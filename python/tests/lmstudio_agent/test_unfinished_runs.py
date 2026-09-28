"""The CLI host and a sub-agent run it started that is still working: a final answer given while the
run is queued or running is sent back (at most twice per run of the agent) with the hint to wait for
it with agent_wait, in both modes. A scripted host model starts the run; a second scripted model is
the sub-agent the server runs. Needs a server started with the fake sub-agent model, so it is
skipped against MCP_URL.
"""

from __future__ import annotations

import os
import re
import threading
import time
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import anyio
import pytest

from sws_tools.lmstudio_agent.agent import AgentOptions, AgentResult, UnfinishedRun, run_agent
from sws_tools.ts_server import TsServer
from tests.conftest import StartServer
from tests.lmstudio_agent.fakes import FakeLlm, FakeLmStudio, FakeRequest, FakeTurn, Reply, answer, tool_call
from tests.lmstudio_agent.helpers import server_call

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(bool(os.environ.get("MCP_URL")), reason="needs a server started with the fake sub-agent model"),
]

_STARTED = re.compile(r"Agent run (r[0-9a-f]{7}) ")
_WAITING = re.compile(r"Run (r[0-9a-f]+) is waiting for your answer \(question (q[0-9a-f]+)")
_NUDGED = re.compile(r"  run (r[0-9a-f]{7}) is still (queued|running); asking the model to wait for it\n")

Ask = Callable[[str], Awaitable[str | None]]


def tool_texts(body: dict[str, Any]) -> str:
    return "\n".join(str(m["content"]) for m in body["messages"] if m["role"] == "tool")


def started_run(body: dict[str, Any]) -> str:
    """The run_id of the agent_run result in the host's conversation."""
    m = _STARTED.search(tool_texts(body))
    assert m, f"an agent_run result in the conversation: {tool_texts(body)[:300]}"
    return m.group(1)


def nudge(run_id: str) -> dict[str, str]:
    return {
        "role": "user",
        "content": f'Run {run_id} you started is still working. Call agent_wait with {{"run_id": "{run_id}"}} and '
        "wait for its result or its question before you answer.",
    }


@dataclass
class Lab:
    """A server whose sub-agents run a scripted model, and the scripted host model."""

    server: TsServer
    lms: FakeLmStudio
    output: list[str]
    release: threading.Event
    """Lets the sub-agent of a MARKER-SLOW run go on (it holds its first model turn until then)."""

    def start_run(self, marker: str) -> Reply:
        # wait_seconds 0: the result comes back while the run works
        return tool_call("agent_run", {"task": f"{marker}: count the items", "output": "the count", "wait_seconds": 0})

    async def run(self, task: str, ask: Ask | None, **extra: Any) -> AgentResult:
        return await run_agent(
            AgentOptions(
                task=task,
                mcp_url=self.server.mcp_url,
                auth_token=os.environ.get("AUTH_TOKEN"),
                lmstudio_url=self.lms.url,
                client_name="lmstudio-agent-unfinished-test",
                color=False,
                write=self.output.append,
                ask=ask,
                **extra,
            )
        )

    async def agent_status(self, run_id: str) -> dict[str, Any]:
        result = await server_call(self.server, "agent_status", {"run_id": run_id})
        return result.structured_content or {}

    def wait_until_done(self, run_id: str) -> str:
        """From a scripted model turn (a thread of the fake): wait until the run has ended, and return its status."""
        deadline = time.monotonic() + 30
        while True:
            status = str(anyio.run(self.agent_status, run_id).get("status"))
            if status in ("completed", "failed", "cancelled") or time.monotonic() > deadline:
                return status
            time.sleep(0.2)

    async def cancel(self, run_id: str) -> None:
        await server_call(self.server, "agent_cancel", {"run_id": run_id})


@pytest.fixture
def lab(ts_server_factory: StartServer, lms: FakeLmStudio, tmp_path: Path) -> Iterator[Lab]:
    release = threading.Event()

    def sub_agent(req: FakeRequest) -> FakeTurn:
        task = str(next((m.get("content") for m in req.messages if m.get("role") == "user"), ""))
        if "MARKER-SLOW" in task:
            # works until the test lets it go on
            if req.step == 1:
                release.wait(60)
            return FakeTurn(tool_calls=[("finish", {"output": "slow done"})])
        if "MARKER-ASKS" in task:
            if req.step == 1:
                return FakeTurn(
                    delay_ms=1_500,
                    tool_calls=[
                        ("ask_host", {"question": "Which colour?", "options": ["red", "blue"], "reason": "choose"})
                    ],
                )
            return FakeTurn(tool_calls=[("finish", {"output": f"colour: {req.last_tool_result}"})])
        # a run that takes a moment, then finishes
        return FakeTurn(delay_ms=1_500, tool_calls=[("finish", {"output": "42 items"})])

    sub = FakeLlm(sub_agent)
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir(mode=0o700)
    try:
        server = ts_server_factory(
            {
                "AGENT_LLM_URL": sub.url,
                "AGENT_LLM_MODEL": "fake-model",
                "AGENT_WAIT_SECONDS": "60",
                "AGENT_REPLY_TIMEOUT_MS": "600000",
                "SCRIPTS_DIR": str(scripts_dir),
            }
        )
        yield Lab(server=server, lms=lms, output=[], release=release)
    finally:
        release.set()
        sub.close()


async def must_not_ask(_prompt: str) -> str | None:
    raise AssertionError("no run waits for an answer: nothing to ask the user")


@pytest.mark.parametrize("interactive", [False, True], ids=["one-shot", "interactive"])
async def test_an_answer_while_a_started_run_still_works_is_sent_back_the_model_waits_for_the_run_and_answers_with_its_result(
    lab: Lab, interactive: bool
) -> None:
    premature = "The sub-agent is counting the items; it will report back."

    def reply(body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            return lab.start_run("MARKER-COUNT")
        if i == 1:
            # ends its turn while the run it started still works
            return answer(premature)
        if i == 2:
            run_id = started_run(body)
            assert body["messages"][-2:] == [{"role": "assistant", "content": premature}, nudge(run_id)]
            return tool_call("agent_wait", {"run_id": run_id, "wait_seconds": 30})
        return answer("There are 42 items.")

    lab.lms.reset(reply)
    result = await lab.run("Count the items", must_not_ask if interactive else None)
    assert result.ok is True, result.error
    assert result.final_answer == "There are 42 items."
    assert [(c.name, c.is_error) for c in result.tool_calls] == [("agent_run", False), ("agent_wait", False)]
    assert len(lab.lms.requests) == 4
    run_id = started_run(lab.lms.requests[2])
    assert "42 items" in result.tool_calls[1].result
    assert result.user_turns == []
    assert result.waiting_runs == []
    assert result.unfinished_runs == []
    printed = "".join(lab.output)
    assert [m.group(1) for m in _NUDGED.finditer(printed)] == [run_id]
    assert re.search(r"Final answer \(4 steps, 2 tool calls, [^)]*\)\nThere are 42 items\.\n", printed)
    assert "does not include its result" not in printed
    assert (await lab.agent_status(run_id))["status"] == "completed"


@pytest.mark.parametrize("interactive", [False, True], ids=["one-shot", "interactive"])
async def test_the_model_is_sent_back_at_most_twice_then_its_answer_is_taken_and_the_unfinished_run_reported(
    lab: Lab, interactive: bool
) -> None:
    replies = ["Still counting.", "The count is not ready yet.", "I could not wait for the count."]

    def reply(_body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            return lab.start_run("MARKER-SLOW")
        # never waits for the run: answers again and again
        return answer(replies[i - 1]) if i <= len(replies) else answer("should not be needed")

    lab.lms.reset(reply)
    run_id = ""
    try:
        result = await lab.run("Count the items", must_not_ask if interactive else None)
        requests = lab.lms.requests
        run_id = started_run(requests[1])
        assert result.stop_reason == "final_answer", result.error
        assert result.final_answer == "I could not wait for the count."
        assert len(requests) == 4, "two answers sent back, the third taken"
        for i in (2, 3):
            assert requests[i]["messages"][-2:] == [{"role": "assistant", "content": replies[i - 2]}, nudge(run_id)]
        assert sum(1 for m in result.messages if m == nudge(run_id)) == 2
        assert [(c.name, c.is_error) for c in result.tool_calls] == [("agent_run", False)]
        assert result.waiting_runs == []
        assert result.unfinished_runs == [UnfinishedRun(run_id=run_id, status="running")]
        assert result.to_json()["unfinishedRuns"] == [{"runId": run_id, "status": "running"}]

        printed = "".join(lab.output)
        assert [m.group(1) for m in _NUDGED.finditer(printed)] == [run_id, run_id]
        assert re.search(r"Final answer \(4 steps, 1 tool calls, [^)]*\)\nI could not wait for the count\.\n", printed)
        assert (
            f"Run {run_id} is still running, so this answer does not include its result. It goes on in the server, "
            "and the dashboard shows its result when it ends.\n"
        ) in printed
        assert (await lab.agent_status(run_id))["status"] == "running"
    finally:
        if run_id:
            await lab.cancel(run_id)
        lab.release.set()


@pytest.mark.parametrize("interactive", [False, True], ids=["one-shot", "interactive"])
async def test_a_run_that_ended_before_the_answer_is_not_waited_for_although_its_last_known_status_was_running(
    lab: Lab, interactive: bool
) -> None:
    def reply(body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            return lab.start_run("MARKER-DONE-BEFORE")
        if i == 1:
            # the run ends on its own before the model answers: only agent_status knows it is done
            assert lab.wait_until_done(started_run(body)) == "completed"
            return answer("The sub-agent has counted the items.")
        return answer("should not be needed")

    lab.lms.reset(reply)
    result = await lab.run("Count the items", must_not_ask if interactive else None)
    assert result.ok is True, result.error
    assert result.final_answer == "The sub-agent has counted the items."
    assert len(lab.lms.requests) == 2, "the answer is taken: the run is not working any more"
    assert [c.name for c in result.tool_calls] == ["agent_run"]
    assert "is still running" in result.tool_calls[0].result, "the agent last saw the run running"
    assert (result.waiting_runs, result.unfinished_runs) == ([], [])
    printed = "".join(lab.output)
    assert not _NUDGED.search(printed)
    assert "does not include its result" not in printed


@pytest.mark.parametrize("interactive", [False, True], ids=["one-shot", "interactive"])
async def test_with_no_step_left_the_answer_is_taken_and_the_run_still_working_reported(
    lab: Lab, interactive: bool
) -> None:
    replies = [lab.start_run("MARKER-SLOW"), answer("The count is not ready yet.")]
    lab.lms.reset(lambda _body, i: replies[i] if i < len(replies) else answer("should not be needed"))
    run_id = ""
    try:
        result = await lab.run("Count the items", must_not_ask if interactive else None, max_steps=2)
        run_id = started_run(lab.lms.requests[1])
        assert result.stop_reason == "final_answer", result.error
        assert result.final_answer == "The count is not ready yet."
        assert len(lab.lms.requests) == 2, "no step left for the model to wait (--max-steps 2)"
        assert result.unfinished_runs == [UnfinishedRun(run_id=run_id, status="running")]
        printed = "".join(lab.output)
        assert not _NUDGED.search(printed)
        assert re.search(r"Final answer \(2 steps, 1 tool calls, [^)]*\)\nThe count is not ready yet\.\n", printed)
        assert f"Run {run_id} is still running, so this answer does not include its result." in printed
    finally:
        if run_id:
            await lab.cancel(run_id)
        lab.release.set()


async def test_without_agent_wait_among_its_tools_the_model_is_not_told_to_call_it(lab: Lab) -> None:
    replies = [lab.start_run("MARKER-SLOW"), answer("The sub-agent is counting the items.")]
    lab.lms.reset(lambda _body, i: replies[i] if i < len(replies) else answer("should not be needed"))
    run_id = ""
    try:
        result = await lab.run("Count the items", None, tools=["agent_run"])
        requests = lab.lms.requests
        run_id = started_run(requests[1])
        assert [t["function"]["name"] for t in requests[0]["tools"]] == ["agent_run"]
        assert result.stop_reason == "final_answer", result.error
        assert result.final_answer == "The sub-agent is counting the items."
        assert len(requests) == 2, "not sent back to call a tool it does not have"
        assert result.unfinished_runs == [UnfinishedRun(run_id=run_id, status="running")]
        printed = "".join(lab.output)
        assert not _NUDGED.search(printed)
        assert f"Run {run_id} is still running, so this answer does not include its result." in printed
    finally:
        if run_id:
            await lab.cancel(run_id)
        lab.release.set()


async def test_interactive_the_run_it_waits_for_asks_a_question_which_is_put_to_the_user(lab: Lab) -> None:
    """The live failure this guards against: the model answered before its own run asked; told to wait,
    it gets the run's question, asks the user, and the reply reaches that run."""
    asking = "The sub-agent asks which colour you want: red or blue?"

    def reply(body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            return lab.start_run("MARKER-ASKS")
        if i == 1:
            return answer("The sub-agent is on it.")
        if i == 2:
            run_id = started_run(body)
            assert body["messages"][-1] == nudge(run_id)
            return tool_call("agent_wait", {"run_id": run_id, "wait_seconds": 30})
        if i == 3:
            assert _WAITING.search(str(body["messages"][-1]["content"])), "agent_wait returned the question"
            return answer(asking)
        if i == 4:
            assert body["messages"][-1] == {"role": "user", "content": "blue"}
            m = _WAITING.search(tool_texts(body))
            assert m
            return tool_call("agent_reply", {"run_id": m.group(1), "question_id": m.group(2), "answer": "blue"})
        return answer("The sub-agent picked blue.")

    lab.lms.reset(reply)
    prompts: list[str] = []

    async def ask(prompt: str) -> str | None:
        prompts.append(prompt)
        return "blue"

    result = await lab.run("Pick a colour with a sub-agent", ask)
    assert result.ok is True, result.error
    assert result.final_answer == "The sub-agent picked blue."
    assert [c.name for c in result.tool_calls] == ["agent_run", "agent_wait", "agent_reply"]
    assert prompts == ["Your answer (Enter to leave it unanswered): "]
    run_id = started_run(lab.lms.requests[1])
    assert [(t.question, t.reply, [w.run_id for w in t.waiting]) for t in result.user_turns] == [
        (asking, "blue", [run_id])
    ]
    assert (result.waiting_runs, result.unfinished_runs) == ([], [])
    s = await lab.agent_status(run_id)
    assert s["status"] == "completed"
    assert s["output"] == 'colour: The host answered: "blue"'
