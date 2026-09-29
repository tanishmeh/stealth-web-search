"""The CLI agent loop against the real server, with a scripted stand-in for LM Studio's
OpenAI-compatible API (no model needed; real-model runs are `npm run lmstudio:e2e`).

Each test gets its own server.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Callable, Coroutine
from typing import Any

import anyio
import pytest

from sws_tools.fixture_site import FixtureSite
from sws_tools.lmstudio_agent.abort import AbortController
from sws_tools.lmstudio_agent.agent import AgentOptions, AgentResult, run_agent
from sws_tools.ts_server import TsServer, auth_headers
from tests.lmstudio_agent.fakes import MODEL, FakeLmStudio, Hang, Reply, Stream, answer, choice, model_list, tool_call

pytestmark = pytest.mark.anyio

Run = Callable[..., Coroutine[Any, Any, AgentResult]]


def last_message(body: dict[str, Any]) -> dict[str, Any]:
    message: dict[str, Any] = body["messages"][-1]
    return message


def image_parts(body: dict[str, Any]) -> int:
    return sum(
        1 for m in body["messages"] if isinstance(m["content"], list) for p in m["content"] if p["type"] == "image_url"
    )


def script(*replies: Reply) -> Callable[[dict[str, Any], int], Reply]:
    return lambda _body, i: replies[i]


@pytest.fixture
def output() -> list[str]:
    return []


@pytest.fixture
def run(ts_server: TsServer, lms: FakeLmStudio, output: list[str]) -> Run:
    async def go(task: str, **extra: Any) -> AgentResult:
        options: dict[str, Any] = {
            "task": task,
            "mcp_url": ts_server.mcp_url,
            "auth_token": os.environ.get("AUTH_TOKEN"),
            "lmstudio_url": lms.url,
            "client_name": "lmstudio-agent-test",
            "color": False,
            "write": output.append,
            **extra,
        }
        return await run_agent(AgentOptions(**options))

    return go


async def test_runs_tool_calls_on_the_server_and_returns_the_final_answer(
    run: Run, lms: FakeLmStudio, ts_server: TsServer, fixture_site: FixtureSite
) -> None:
    lms.reset(
        script(
            tool_call("browser_navigate", {"url": f"{fixture_site.base_url}/index.html"}, "1001"),
            tool_call("browser_snapshot", {}, "1002"),
            answer('The heading is "Hello Fixture" and Pear costs $2.'),
        ),
        model_list(),
    )
    result = await run("Read the fixture page")
    assert result.ok is True, result.error
    assert result.stop_reason == "final_answer"
    assert re.search(r"Hello Fixture", result.final_answer or "")
    assert [(c.name, c.executed, c.is_error) for c in result.tool_calls] == [
        ("browser_navigate", True, False),
        ("browser_snapshot", True, False),
    ]
    assert result.model == MODEL
    assert result.usage.prompt_tokens == 300

    first = lms.requests[0]
    assert first["model"] == MODEL
    assert first["stream"] is True
    assert first["reasoning_effort"] == "low"
    assert first["messages"][0]["role"] == "system"
    nav = next((t for t in first["tools"] if t["function"]["name"] == "browser_navigate"), None)
    assert nav, "tools are offered as OpenAI functions"
    assert nav["function"]["parameters"]["type"] == "object"
    assert "$schema" not in nav["function"]["parameters"]

    second = lms.requests[1]
    assistant = second["messages"][-2]
    assert assistant["role"] == "assistant"
    assert assistant["tool_calls"][0]["id"] == "1001"
    tool_msg = last_message(second)
    assert tool_msg["role"] == "tool"
    assert tool_msg["tool_call_id"] == "1001"
    assert re.search(r"Fixture Home", tool_msg["content"])
    assert re.search(r"Hello Fixture", last_message(lms.requests[2])["content"])

    state = ts_server.get_json("/api/state")
    calls = [a["tool"] for a in state["history"]["activity"] if a.get("client") == "lmstudio-agent-test 1.0.0"]
    assert calls[-2:] == ["browser_navigate", "browser_snapshot"]
    assert not any(s.get("client") == "lmstudio-agent-test 1.0.0" for s in state["sessions"]), (
        "the agent ends its MCP session"
    )


async def test_feeds_invalid_arguments_unknown_tools_and_tool_calls_written_as_text_back_to_the_model(
    run: Run, lms: FakeLmStudio
) -> None:
    lms.reset(
        script(
            tool_call("browser_navigate", '{"url": ', "2001"),
            tool_call("browser_fly", {}, "2002"),
            answer('<tool_call>{"name": "browser_snapshot", "arguments": {}}</tool_call>'),
            answer("Done."),
        )
    )
    result = await run("Do something")
    assert result.stop_reason == "final_answer", result.error
    assert result.final_answer == "Done."
    assert [(c.name, c.executed) for c in result.tool_calls] == [("browser_navigate", False), ("browser_fly", False)]
    assert re.search(r"not valid JSON", last_message(lms.requests[1])["content"])
    assert re.search(r'unknown tool "browser_fly"', last_message(lms.requests[2])["content"])
    nudge = last_message(lms.requests[3])
    assert nudge["role"] == "user"
    assert re.search(r"function-calling interface", nudge["content"])


async def test_gives_up_with_an_error_when_the_model_keeps_writing_tool_calls_as_text(
    run: Run, lms: FakeLmStudio
) -> None:
    lms.reset(lambda _body, _i: answer('browser_navigate({"url": "https://example.com"})'), model_list())
    result = await run("Open example.com")
    assert result.ok is False
    assert result.stop_reason == "error"
    assert result.final_answer is None
    assert re.search(r"keeps writing tool calls as text", result.error or "")
    assert len(lms.requests) == 3, "two nudges, then stop"


async def test_warns_when_the_loaded_context_leaves_no_room_for_the_conversation(
    run: Run, lms: FakeLmStudio, output: list[str]
) -> None:
    lms.reset(lambda _body, _i: answer("ok"), model_list(context_length=16384))
    result = await run("hi")
    assert result.ok is True, result.error
    assert re.search(r"Warning: the model is loaded with a 16384-token context", "".join(output))


async def test_sends_screenshots_as_a_user_image_message_and_keeps_only_the_newest_image(
    run: Run, lms: FakeLmStudio
) -> None:
    lms.reset(
        script(tool_call("browser_screenshot", {}), tool_call("browser_screenshot", {}), answer("It is white.")),
        model_list(vision=True),
    )
    result = await run("Describe the page")
    assert result.ok is True, result.error
    after_first = lms.requests[1]
    image_msg = last_message(after_first)
    assert image_msg["role"] == "user"
    assert re.match(r"data:image/png;base64,", image_msg["content"][1]["image_url"]["url"])
    assert image_parts(after_first) == 1
    assert image_parts(lms.requests[2]) == 1, "older images are dropped"
    assert not any(
        isinstance(m["content"], list) and any(p["type"] == "image_url" for p in m["content"]) for m in result.messages
    ), "the returned transcript does not carry base64 images"

    lms.reset(script(tool_call("browser_screenshot", {}), answer("No image.")))
    blind = await run("Describe the page", vision=False)
    assert blind.ok is True, blind.error
    assert image_parts(lms.requests[1]) == 0
    assert re.search(r"vision is off", last_message(lms.requests[1])["content"])


async def test_omits_reasoning_effort_for_on_and_for_models_without_reasoning_options(
    run: Run, lms: FakeLmStudio
) -> None:
    lms.reset(lambda _body, _i: answer("ok"), model_list())
    assert (await run("hi", reasoning="on")).ok is True
    assert "reasoning_effort" not in lms.requests[0]

    lms.reset(models=model_list(reasoning=False))
    assert (await run("hi", reasoning="none")).ok is True
    assert "reasoning_effort" not in lms.requests[0]


async def test_stops_at_the_step_limit_with_a_best_effort_answer_requested_without_tools(
    run: Run, lms: FakeLmStudio
) -> None:
    lms.reset(script(tool_call("browser_snapshot", {"include_elements": False}), answer("Partial: Hello Fixture")))
    result = await run("Loop forever", max_steps=1)
    assert result.stop_reason == "max_steps"
    assert result.final_answer == "Partial: Hello Fixture"
    assert len(lms.requests) == 2
    assert "tools" not in lms.requests[1]


async def test_explains_when_no_tool_use_model_is_loaded(lms: FakeLmStudio, output: list[str]) -> None:
    # fails before it connects to the MCP server, so no server is needed
    lms.reset(models=model_list(loaded=False))
    result = await run_agent(
        AgentOptions(
            task="hi",
            mcp_url="http://127.0.0.1:9/mcp",
            lmstudio_url=lms.url,
            client_name="lmstudio-agent-test",
            color=False,
            write=output.append,
        )
    )
    assert result.stop_reason == "error"
    assert re.search(r"No loaded LM Studio model is trained for tool use", result.error or "")
    assert re.search(r"lms load test/tool-model", result.error or "")
    assert len(lms.requests) == 0


async def test_an_error_event_in_the_model_stream_ends_the_run_instead_of_hanging(run: Run, lms: FakeLmStudio) -> None:
    lms.reset(
        lambda _body, _i: Stream(
            [choice({"reasoning_content": "thinking"}), {"error": {"message": "Model has crashed"}}], keep_open=True
        )
    )
    started = time.monotonic()
    result = await run("hi")
    assert result.stop_reason == "error"
    assert re.search(r"Model has crashed", result.error or "")
    assert time.monotonic() - started < 20, "finishes promptly"


async def test_aborting_while_the_model_is_streaming_ends_the_run_and_closes_the_request(
    run: Run, lms: FakeLmStudio
) -> None:
    lms.reset(lambda _body, _i: Hang([choice({"reasoning_content": "thinking..."})]))
    controller = AbortController()
    started = time.monotonic()
    timer = controller.abort_after(0.5)
    try:
        result = await run("hi", signal=controller.signal)
    finally:
        timer.cancel()
    assert result.stop_reason == "aborted"
    assert time.monotonic() - started < 10
    await anyio.sleep(0.2)
    assert lms.open_streams() == 0, "the streaming request was closed"


def test_ctrl_c_during_a_tool_call_makes_the_cli_exit_promptly_with_code_130(
    ts_server: TsServer, lms: FakeLmStudio, python_env: dict[str, str]
) -> None:
    child: subprocess.Popen[bytes] | None = None

    def interrupt() -> None:
        if child is not None:
            child.send_signal(signal.SIGINT)

    def reply(_body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            threading.Timer(1.5, interrupt).start()
            return tool_call("browser_wait", {"seconds": 4})
        return answer("should not be needed")

    lms.reset(reply)
    env = {
        **python_env,
        "MCP_URL": ts_server.mcp_url,
        "LMSTUDIO_URL": lms.url,
        "LMSTUDIO_MODEL": MODEL,
        "NO_COLOR": "1",
    }
    started = time.monotonic()
    child = subprocess.Popen(
        [sys.executable, "-m", "sws_tools.lmstudio_agent", "wait a bit", "--quiet"],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        _, stderr = child.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        child.kill()
        _, stderr = child.communicate()
        pytest.fail(f"the CLI did not exit (stderr: {stderr.decode()})")
    elapsed = time.monotonic() - started
    assert child.returncode == 130, f"exit code (stderr: {stderr.decode()})"
    assert elapsed < 15, f"exited {elapsed:.1f} s after start"


async def test_reconnects_once_when_the_server_no_longer_knows_the_session(
    run: Run, lms: FakeLmStudio, ts_server: TsServer, output: list[str]
) -> None:
    # not in the TS suite: the Python SDK reports the server's 404 as a JSON-RPC error, so the host
    # recognises it by the HTTP status it saw (as the TS host did with err.data.status)
    if ts_server.process is None:
        pytest.skip("ends the session through the server's own API")

    def forget_session() -> None:
        for session in ts_server.get_json("/api/state")["sessions"]:
            if session.get("client") == "lmstudio-agent-test 1.0.0":
                request = urllib.request.Request(
                    ts_server.mcp_url,
                    method="DELETE",
                    headers={**auth_headers(), "mcp-session-id": session["id"], "mcp-protocol-version": "2025-11-25"},
                )
                urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10).close()

    def reply(_body: dict[str, Any], i: int) -> Reply:
        if i == 1:
            forget_session()
        return tool_call("browser_tab_list", {}) if i < 2 else answer("done")

    lms.reset(reply)
    result = await run("List the tabs twice")
    assert result.stop_reason == "final_answer", result.error
    assert [(c.name, c.is_error) for c in result.tool_calls] == [
        ("browser_tab_list", False),
        ("browser_tab_list", False),
    ]
    printed = "".join(output)
    assert printed.count("reconnecting...") == 1
    assert re.search(
        r"MCP connection lost \(Session not found\. Re-initialize the MCP connection\.\); reconnecting\.\.\.", printed
    )
