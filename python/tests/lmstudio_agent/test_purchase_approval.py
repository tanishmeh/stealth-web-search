"""The CLI as an interactive host for sub-agent questions: a scripted host model starts a sub-agent
(a second scripted model, run by the server in its own browser) that asks before it orders on the
fixture checkout page. Needs a server started with the fake sub-agent model, so it is skipped
against MCP_URL.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from sws_tools.fixture_site import FixtureSite, RecordedRequest
from sws_tools.lmstudio_agent.agent import AgentOptions, AgentResult, WaitingQuestion, run_agent
from sws_tools.ts_server import TsServer
from tests.conftest import StartServer
from tests.lmstudio_agent.fakes import (
    MODEL,
    FakeLlm,
    FakeLmStudio,
    FakeRequest,
    FakeTurn,
    Reply,
    Stream,
    TcpProxy,
    answer,
    tool_call,
)
from tests.lmstudio_agent.helpers import server_call

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(bool(os.environ.get("MCP_URL")), reason="needs a server started with the fake sub-agent model"),
]

ORDER_QUESTION = (
    "Place the order for one Blue Mug, total $17.49, delivered to 1 Example Street, paid with the card ending 4242?"
)
ASKING = (
    "The shop is ready to order one Blue Mug for $17.49, delivered to 1 Example Street and paid with the card ending "
    "4242. Would you like me to place this order? (Yes/No)"
)
_WAITING = re.compile(r"Run (r[0-9a-f]+) is waiting for your answer \(question (q[0-9a-f]+)")


def waiting_ids(body: dict[str, Any]) -> dict[str, str]:
    """run_id and question_id from the waiting agent_run result in the host's conversation."""
    text = "\n".join(str(m["content"]) for m in body["messages"] if m["role"] == "tool")
    m = _WAITING.search(text)
    assert m, f"a waiting result in the conversation: {text[:300]}"
    return {"run_id": m.group(1), "question_id": m.group(2)}


@dataclass
class Shop:
    """A server whose sub-agents run the scripted checkout model, the fixture shop and the scripted host model."""

    server: TsServer
    fx: FixtureSite
    lms: FakeLmStudio
    output: list[str]

    def orders(self) -> list[RecordedRequest]:
        """Orders the checkout fixture received (its form posts to /echo)."""
        return [r for r in self.fx.requests if r.method == "POST" and r.url == "/echo" and "item=blue-mug" in r.body]

    def start_run(self, marker: str) -> Stream:
        return tool_call(
            "agent_run",
            {
                "task": f"{marker}: order one Blue Mug from {self.fx.base_url}/checkout.html",
                "output": "the order confirmation",
            },
        )

    async def run(self, task: str, **extra: Any) -> AgentResult:
        options: dict[str, Any] = {
            "task": task,
            "mcp_url": self.server.mcp_url,
            "auth_token": os.environ.get("AUTH_TOKEN"),
            "lmstudio_url": self.lms.url,
            "client_name": "lmstudio-agent-approval-test",
            "color": False,
            "write": self.output.append,
            **extra,
        }
        return await run_agent(AgentOptions(**options))

    async def agent_status(self, run_id: str) -> dict[str, Any]:
        result = await server_call(self.server, "agent_status", {"run_id": run_id})
        return result.structured_content or {}

    async def cancel(self, run_id: str) -> None:
        await server_call(self.server, "agent_cancel", {"run_id": run_id})


@pytest.fixture
def shop(
    ts_server_factory: StartServer, fixture_site: FixtureSite, lms: FakeLmStudio, tmp_path: Path
) -> Iterator[Shop]:
    fx = fixture_site

    def checkout(req: FakeRequest) -> FakeTurn:
        """Every sub-agent run: open the checkout, ask the host, order only when the answer is yes."""

        def call(name: str, args: dict[str, Any]) -> FakeTurn:
            return FakeTurn(tool_calls=[(name, args)])

        if req.step == 1:
            return call("browser_navigate", {"url": f"{fx.base_url}/checkout.html"})
        if req.step == 2:
            return call(
                "ask_host", {"question": ORDER_QUESTION, "options": ["Yes, place the order", "No"], "reason": "confirm"}
            )
        if req.step == 3:
            if re.match(r'The host answered: "Yes', req.last_tool_result or ""):
                return call("browser_click", {"selector": "#place"})
            return call("finish", {"output": "not ordered", "success": False})
        return call("finish", {"output": f"ordered: {req.last_tool_result}"})

    sub_agent = FakeLlm(checkout)
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir(mode=0o700)
    try:
        server = ts_server_factory(
            {
                "AGENT_LLM_URL": sub_agent.url,
                "AGENT_LLM_MODEL": "fake-model",
                "AGENT_WAIT_SECONDS": "60",
                "AGENT_REPLY_TIMEOUT_MS": "600000",
                "SCRIPTS_DIR": str(scripts_dir),
            }
        )
        yield Shop(server=server, fx=fx, lms=lms, output=[])
    finally:
        sub_agent.close()


Script = Callable[[dict[str, Any], int], Reply]


async def test_the_host_ends_its_turn_to_ask_the_user_the_reply_goes_back_to_it_it_answers_with_agent_reply_and_the_order_is_placed(
    shop: Shop,
) -> None:
    before = len(shop.orders())

    def reply(body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            return shop.start_run("MARKER-CLI-YES")
        if i == 1:
            # the task did not approve the purchase: the host asks the user instead of answering
            return answer(ASKING)
        if i == 2:
            return tool_call("agent_reply", {**waiting_ids(body), "answer": "Yes, place the order"})
        return answer("Ordered one Blue Mug for $17.49.")

    shop.lms.reset(reply)
    prompts: list[str] = []

    async def ask(prompt: str) -> str | None:
        prompts.append(prompt)
        return "  Yes, place the order  "

    result = await shop.run("Order one Blue Mug from the shop", ask=ask)
    assert result.ok is True, result.error
    assert result.final_answer == "Ordered one Blue Mug for $17.49."
    assert [(c.name, c.is_error) for c in result.tool_calls] == [("agent_run", False), ("agent_reply", False)]
    assert len(shop.orders()) == before + 1, "ordered once, after the user approved"

    # the host was told to ask the user, and got the reply as the next user message
    requests = shop.lms.requests
    system = requests[0]["messages"][0]["content"]
    assert re.search(
        r"end your turn by asking the user \(item, total, delivery address, payment method, the site\)", system
    )
    assert not re.search(r"The user cannot answer", system)
    assert requests[2]["messages"][-2:] == [
        {"role": "assistant", "content": ASKING},
        {"role": "user", "content": "Yes, place the order"},
    ]

    # the user saw the host's question and the sub-agent's, then the prompt
    assert prompts == ["Your answer (Enter to leave it unanswered): "]
    ids = waiting_ids(requests[2])
    parts = urlsplit(shop.fx.base_url)
    origin = f"{parts.scheme}://{parts.netloc}"
    printed = "".join(shop.output)
    assert re.search(r"Question for you \(a sub-agent run waits for your answer\)\n", printed)
    assert f"{ASKING}\n  run {ids['run_id']} asks on {origin}: {ORDER_QUESTION}\n" in printed, printed
    assert re.search(r"Final answer \(4 steps, 2 tool calls, ", printed)

    # the transcript keeps the exchange
    assert len(result.user_turns) == 1
    turn = result.user_turns[0]
    assert (turn.step, turn.question, turn.reply) == (2, ASKING, "Yes, place the order")
    assert turn.waiting == [
        WaitingQuestion(
            run_id=ids["run_id"],
            question_id=ids["question_id"],
            text=ORDER_QUESTION,
            reason="confirm",
            origin=origin,
            expires_at=turn.waiting[0].expires_at,
        )
    ]
    assert result.waiting_runs == []
    assert any(m["role"] == "user" and m["content"] == "Yes, place the order" for m in result.messages)

    s = await shop.agent_status(ids["run_id"])
    assert s["status"] == "completed"
    assert re.match(r'ordered: Clicked button\[submit\] "Place your order"', s["output"])
    assert [(q["reason"], q["status"], q["answer"]) for q in s["questions"]] == [
        ("confirm", "answered", "Yes, place the order")
    ]


async def test_no_reply_the_run_ends_as_before_the_sub_agent_run_keeps_waiting_and_nothing_is_ordered(
    shop: Shop,
) -> None:
    before = len(shop.orders())
    replies = [shop.start_run("MARKER-CLI-NONE"), answer(ASKING)]
    shop.lms.reset(lambda _body, i: replies[i] if i < len(replies) else answer("should not be needed"))
    asked = 0

    async def ask(_prompt: str) -> str | None:
        nonlocal asked
        asked += 1
        return ""

    result = await shop.run("Order one Blue Mug from the shop", ask=ask)
    assert result.ok is True, result.error
    assert result.stop_reason == "final_answer"
    assert result.final_answer == ASKING
    assert asked == 1
    assert len(shop.lms.requests) == 2, "the model is not called again"
    ids = waiting_ids(shop.lms.requests[1])
    assert [(t.step, t.reply, [w.run_id for w in t.waiting]) for t in result.user_turns] == [(2, None, [ids["run_id"]])]
    assert [(w.run_id, w.question_id, w.reason) for w in result.waiting_runs] == [
        (ids["run_id"], ids["question_id"], "confirm")
    ]
    printed = "".join(shop.output)
    assert re.search(r"No answer; stopping \(2 steps, 1 tool calls, ", printed)
    assert not re.search(r"Final answer", printed), "the question is not printed twice"
    assert re.search(
        rf"Run {ids['run_id']} is still waiting for an answer to question {ids['question_id']}\. Unanswered, it continues "
        r"without it after its timeout \(in about 10 min\) and does not take the step it asked about, so nothing is "
        r"ordered\.",
        printed,
    )

    assert (await shop.agent_status(ids["run_id"]))["status"] == "waiting"
    assert len(shop.orders()) == before, "nothing was ordered"
    await shop.cancel(ids["run_id"])
    assert len(shop.orders()) == before


async def test_without_an_ask_callback_or_with_no_step_left_the_user_is_not_asked_and_the_waiting_run_is_reported(
    shop: Shop,
) -> None:
    before = len(shop.orders())
    run_ids: list[str] = []

    async def must_not_ask(_prompt: str) -> str | None:
        raise AssertionError("no step left to pass on an answer")

    extras: list[dict[str, Any]] = [{}, {"max_steps": 2, "ask": must_not_ask}]
    for extra in extras:
        shop.output.clear()
        replies = [shop.start_run("MARKER-CLI-QUIET"), answer(ASKING)]

        def reply(_body: dict[str, Any], i: int, replies: list[Stream] = replies) -> Reply:
            return replies[i] if i < len(replies) else answer("should not be needed")

        shop.lms.reset(reply)
        result = await shop.run("Order one Blue Mug from the shop", **extra)
        assert result.stop_reason == "final_answer", result.error
        assert len(shop.lms.requests) == 2
        run_id = waiting_ids(shop.lms.requests[1])["run_id"]
        run_ids.append(run_id)
        assert result.user_turns == []
        assert [w.run_id for w in result.waiting_runs] == [run_id]
        printed = "".join(shop.output)
        assert re.search(r"Final answer \(2 steps, 1 tool calls, ", printed)
        assert re.search(rf"Run {run_id} is still waiting for an answer", printed)
        system = shop.lms.requests[0]["messages"][0]["content"]
        if "ask" in extra:
            assert re.search(r"No steps left to ask you and pass on your answer \(--max-steps 2\)\.", printed)
            assert re.search(r"end your turn by asking the user", system)
        else:
            # one-shot: the host is told nobody can answer, and to refuse what the task did not approve
            assert re.search(r"The user cannot answer questions while you work\.", system)
            assert re.search(
                r'reply "No" to the confirm question, and say in your final answer that the order is ready', system
            )
    for run_id in run_ids:
        await shop.cancel(run_id)
    assert len(shop.orders()) == before


async def test_a_run_that_ends_in_an_error_still_reports_the_sub_agent_run_left_waiting(shop: Shop) -> None:
    before = len(shop.orders())
    start = shop.start_run("MARKER-CLI-EMPTY")
    # the model starts a run, then only returns empty replies: two nudges, then the run ends in an error
    shop.lms.reset(lambda _body, i: start if i == 0 else answer(""))

    async def must_not_ask(_prompt: str) -> str | None:
        raise AssertionError("nothing to ask: the model asked nothing")

    result = await shop.run("Order one Blue Mug from the shop", ask=must_not_ask)
    assert result.stop_reason == "error"
    assert result.error == "The model returned an empty response.", "".join(shop.output)
    assert len(shop.lms.requests) == 4
    ids = waiting_ids(shop.lms.requests[1])
    assert [(w.run_id, w.question_id, w.reason) for w in result.waiting_runs] == [
        (ids["run_id"], ids["question_id"], "confirm")
    ]
    assert re.search(
        rf"Run {ids['run_id']} is still waiting for an answer to question {ids['question_id']}\..*so nothing is ordered\.",
        "".join(shop.output),
    )
    await shop.cancel(ids["run_id"])
    assert len(shop.orders()) == before


async def test_a_lost_mcp_connection_while_checking_for_waiting_runs_does_not_replace_the_final_answer(
    shop: Shop,
) -> None:
    # a TCP proxy in front of the server, cut before the model's final answer, as when the server goes away
    target = urlsplit(shop.server.mcp_url)
    assert target.hostname is not None
    assert target.port is not None
    proxy = TcpProxy(target.hostname, target.port)
    via_proxy = target._replace(netloc=f"127.0.0.1:{proxy.port}").geturl()
    run_id = ""
    start = shop.start_run("MARKER-CLI-LOST")

    def reply(body: dict[str, Any], i: int) -> Reply:
        nonlocal run_id
        if i == 0:
            return start
        run_id = waiting_ids(body)["run_id"]
        proxy.cut()
        return answer(ASKING)

    async def must_not_ask(_prompt: str) -> str | None:
        raise AssertionError("no waiting run is known")

    try:
        shop.lms.reset(reply)
        result = await shop.run("Order one Blue Mug from the shop", mcp_url=via_proxy, ask=must_not_ask)
        assert result.stop_reason == "final_answer", result.error
        assert result.final_answer == ASKING
        assert result.waiting_runs == []
    finally:
        proxy.cut()
        if run_id:
            await shop.cancel(run_id)


def _cli(shop: Shop, python_env: dict[str, str], args: list[str], stdin_text: str) -> tuple[int | None, str, str]:
    """Run the CLI with piped stdin that stays open (the answers wait in the pipe until it asks);
    returns its exit code (None if it hangs), stdout and stderr."""
    env = {
        **python_env,
        "MCP_URL": shop.server.mcp_url,
        "LMSTUDIO_URL": shop.lms.url,
        "LMSTUDIO_MODEL": MODEL,
        "NO_COLOR": "1",
    }
    child = subprocess.Popen(
        [sys.executable, "-m", "sws_tools.lmstudio_agent", *args],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert child.stdin is not None
    assert child.stdout is not None
    assert child.stderr is not None
    child.stdin.write(stdin_text.encode())
    child.stdin.flush()
    out: list[bytes] = []
    err: list[bytes] = []
    readers = [
        _drain(child.stdout, out),
        _drain(child.stderr, err),
    ]
    try:
        code: int | None = child.wait(timeout=90)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
        code = None
    finally:
        child.stdin.close()
    for reader in readers:
        reader.join(5)
    return code, b"".join(out).decode(), b"".join(err).decode()


def _drain(stream: Any, sink: list[bytes]) -> Any:
    import threading

    thread = threading.Thread(target=lambda: sink.extend(iter(lambda: stream.read1(65536), b"")), daemon=True)
    thread.start()
    return thread


async def test_the_cli_with_piped_stdin_and_no_interactive_never_reads_it_it_reports_the_waiting_run_and_exits(
    shop: Shop, python_env: dict[str, str], tmp_path: Path
) -> None:
    before = len(shop.orders())
    replies = [shop.start_run("MARKER-CLI-PIPED"), answer(ASKING)]
    shop.lms.reset(lambda _body, i: replies[i] if i < len(replies) else answer("should not be needed"))
    json_path = tmp_path / "run.json"
    code, stdout, stderr = _cli(
        shop, python_env, ["Order one Blue Mug from the shop", "--json", str(json_path)], "yes\n"
    )
    assert code == 0, f"exit code (stderr: {stderr})\n{stdout}"
    assert len(shop.lms.requests) == 2, "the model is not called again"
    assert re.search(
        r"The user cannot answer questions while you work\.", shop.lms.requests[0]["messages"][0]["content"]
    )
    assert not re.search(r"Question for you|Your answer", stdout)
    assert re.search(r"Final answer \(2 steps, 1 tool calls, ", stdout)
    transcript = json.loads(json_path.read_text(encoding="utf-8"))
    assert transcript["options"]["interactive"] is False
    assert transcript["userTurns"] == []
    assert len(transcript["waitingRuns"]) == 1
    run_id = transcript["waitingRuns"][0]["runId"]
    assert re.search(rf"Run {run_id} is still waiting for an answer", stdout)
    await shop.cancel(run_id)
    assert len(shop.orders()) == before


async def test_the_cli_asks_on_stdin_with_interactive_and_writes_the_exchange_to_the_json_transcript(
    shop: Shop, python_env: dict[str, str], tmp_path: Path
) -> None:
    before = len(shop.orders())

    def reply(body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            return shop.start_run("MARKER-CLI-STDIN")
        if i == 1:
            return answer(ASKING)
        if i == 2:
            return tool_call("agent_reply", {**waiting_ids(body), "answer": "Yes"})
        if i == 3:
            return answer("Ordered.")
        return answer("done")

    shop.lms.reset(reply)
    json_path = tmp_path / "run.json"
    # stdin stays open after the answer: the CLI still exits once the run is done
    code, stdout, stderr = _cli(
        shop,
        python_env,
        ["Order one Blue Mug from the shop", "--interactive", "--json", str(json_path)],
        "yes please\n",
    )
    assert code == 0, f"exit code (stderr: {stderr})\n{stdout}"
    assert re.search(r"Question for you \(a sub-agent run waits for your answer\)\n", stdout)
    # the piped answer is not echoed: the prompt line still ends, as it does after Enter in a terminal
    assert re.search(r"Your answer \(Enter to leave it unanswered\): \n\n\[step 3\]", stdout)
    assert re.search(r"Final answer \(4 steps, 2 tool calls, [^)]*\)\nOrdered\.\n", stdout)
    assert shop.lms.requests[2]["messages"][-1] == {"role": "user", "content": "yes please"}
    transcript = json.loads(json_path.read_text(encoding="utf-8"))
    assert transcript["options"]["interactive"] is True
    assert transcript["userTurns"][0]["reply"] == "yes please"
    assert transcript["userTurns"][0]["waiting"][0]["reason"] == "confirm"
    assert transcript["waitingRuns"] == []
    assert len(shop.orders()) == before + 1


def _terminal_cli(
    shop: Shop, python_env: dict[str, str], args: list[str], at_prompt: Callable[[int, int], object]
) -> tuple[int | None, str]:
    """Run the CLI with stdin and stdout on a pseudo-terminal; `at_prompt(master_fd, pid)` runs when it asks."""
    import pty
    import select
    import time

    env = {
        **python_env,
        "MCP_URL": shop.server.mcp_url,
        "LMSTUDIO_URL": shop.lms.url,
        "LMSTUDIO_MODEL": MODEL,
        "NO_COLOR": "1",
    }
    master, slave = pty.openpty()
    child = subprocess.Popen(
        [sys.executable, "-m", "sws_tools.lmstudio_agent", *args], env=env, stdin=slave, stdout=slave, stderr=slave
    )
    os.close(slave)
    output = b""
    prompted = False
    deadline = time.monotonic() + 90
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:  # EIO: the terminal's other end is closed
                    chunk = b""
                output += chunk
                if not chunk and child.poll() is not None:
                    break
            elif child.poll() is not None:
                break
            if not prompted and b"Your answer (Enter to leave it unanswered): " in output:
                prompted = True
                at_prompt(master, child.pid)
        code = child.wait(timeout=max(1.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
        code = None
    finally:
        os.close(master)
    return code, output.decode(errors="replace").replace("\r\n", "\n")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX pseudo-terminal")
async def test_in_a_terminal_the_cli_asks_by_default_and_the_typed_answer_goes_back_to_the_model(
    shop: Shop, python_env: dict[str, str]
) -> None:
    # not in the TS suite: the TTY rule (interactive by default when stdin and stdout are a terminal)
    before = len(shop.orders())

    def reply(body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            return shop.start_run("MARKER-CLI-TTY")
        if i == 1:
            return answer(ASKING)
        if i == 2:
            return tool_call("agent_reply", {**waiting_ids(body), "answer": "Yes"})
        return answer("Ordered.")

    shop.lms.reset(reply)
    code, printed = _terminal_cli(
        shop, python_env, ["Order one Blue Mug from the shop"], lambda fd, _pid: os.write(fd, b"yes please\r")
    )
    assert code == 0, printed
    assert re.search(r"end your turn by asking the user", shop.lms.requests[0]["messages"][0]["content"])
    # the terminal echoes the typed answer and the Enter key
    assert "Your answer (Enter to leave it unanswered): yes please\n" in printed
    assert shop.lms.requests[2]["messages"][-1] == {"role": "user", "content": "yes please"}
    assert re.search(r"Final answer \(4 steps, 2 tool calls, [^)]*\)\nOrdered\.\n", printed)
    assert len(shop.orders()) == before + 1


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX pseudo-terminal")
async def test_ctrl_c_at_the_question_in_a_terminal_stops_the_cli_with_code_130(
    shop: Shop, python_env: dict[str, str]
) -> None:
    # not in the TS suite: Ctrl+C while the CLI waits for the user's answer
    before = len(shop.orders())
    replies = [shop.start_run("MARKER-CLI-TTY-INT"), answer(ASKING)]
    shop.lms.reset(lambda _body, i: replies[i] if i < len(replies) else answer("should not be needed"))
    code, printed = _terminal_cli(
        shop, python_env, ["Order one Blue Mug from the shop"], lambda _fd, pid: os.kill(pid, signal.SIGINT)
    )
    assert code == 130, printed
    assert "Interrupted; stopping..." in printed
    assert "Error: Aborted." in printed
    assert len(shop.lms.requests) == 2, "the model is not called again"
    await shop.cancel(waiting_ids(shop.lms.requests[1])["run_id"])
    assert len(shop.orders()) == before
