"""The sws-agents-e2e command line, and its MCP client against the real TypeScript server."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import Implementation

from sws_tools.agents_e2e import cli, runner, scenarios
from sws_tools.ts_server import TsServer, auth_headers, free_port

StartServer = Callable[..., TsServer]


def test_help(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["--help"]) == 0
    assert capsys.readouterr().out == f"{cli.USAGE}\n"
    assert cli.main(["-h"]) == 0


@pytest.mark.parametrize(
    ("argv", "stderr"),
    [
        (["--only", "run,nope,x"], "Unknown scenario(s): nope, x. Available: run, automate, find, parallel\n"),
        (["--only", "run,,find"], "Unknown scenario(s): . Available: run, automate, find, parallel\n"),
        (["--bogus"], f"unrecognized arguments: --bogus\n\n{cli.USAGE}\n"),
        (["positional"], f"unrecognized arguments: positional\n\n{cli.USAGE}\n"),
        (["--only"], f"argument --only: expected one argument\n\n{cli.USAGE}\n"),
        (["--repeat", "two"], f'--repeat must be a whole number, got "two"\n\n{cli.USAGE}\n'),
    ],
)
def test_usage_errors_exit_2(argv: list[str], stderr: str, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(argv) == 2
    assert capsys.readouterr().err == stderr


def test_options(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MCP_URL", raising=False)
    options = cli.parse([])
    assert options == runner.Options(
        only=["run", "automate", "find", "parallel"], repeat=1, mcp_url="http://127.0.0.1:8931/mcp", json_file=None
    )
    monkeypatch.setenv("MCP_URL", "http://127.0.0.1:1234/mcp")
    options = cli.parse(["--only", " find , run", "--repeat", "0", "--json", "out.json"])
    assert options == runner.Options(
        only=["find", "run"], repeat=1, mcp_url="http://127.0.0.1:1234/mcp", json_file="out.json"
    )
    assert cli.parse(["--mcp-url", "http://x/mcp", "--repeat", "3"]) == runner.Options(
        only=["run", "automate", "find", "parallel"], repeat=3, mcp_url="http://x/mcp", json_file=None
    )


def test_an_unreachable_server_exits_1(capsys: pytest.CaptureFixture[str]) -> None:
    url = f"http://127.0.0.1:{free_port()}/mcp"
    assert cli.main(["--mcp-url", url, "--only", "find"]) == 1
    err = capsys.readouterr().err
    assert err.startswith(f"agents-e2e: cannot use the MCP server at {url}: ")


def test_runs_as_a_module(python_env: dict[str, str]) -> None:
    res = subprocess.run(
        [sys.executable, "-m", "sws_tools.agents_e2e", "--help"], capture_output=True, text=True, env=python_env
    )
    assert (res.returncode, res.stdout) == (0, f"{cli.USAGE}\n")


class _Recorder(BaseHTTPRequestHandler):
    """Records the JSON-RPC messages it gets and answers each with 401."""

    received: list[dict[str, Any]]

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.received.append(json.loads(body))
        payload = b'{"error":"unauthorized"}'
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


@pytest.fixture
def recorder() -> Iterator[tuple[str, list[dict[str, Any]]]]:
    received: list[dict[str, Any]] = []
    handler = type("Handler", (_Recorder,), {"received": received})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/mcp", received
    finally:
        server.shutdown()
        server.server_close()


def test_connects_straight_to_the_server_whatever_the_proxy_variables_say(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # as Node's fetch did for the TypeScript runner: HTTP_PROXY and friends never apply
    dead_proxy = f"http://127.0.0.1:{free_port()}"
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.setenv(name, dead_proxy)
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    url, received = recorder
    assert cli.main(["--mcp-url", url, "--only", "find"]) == 1
    assert received, f"the request went elsewhere: {capsys.readouterr().err}"


def test_opens_a_session_with_the_2025_11_25_handshake(recorder: tuple[str, list[dict[str, Any]]]) -> None:
    # the handshake LM Studio and the CLI host use, so the run shows up as a session on the dashboard
    url, received = recorder
    assert cli.main(["--mcp-url", url, "--only", "find"]) == 1
    assert received
    first = received[0]
    assert first["method"] == "initialize"
    assert first["params"]["protocolVersion"] == "2025-11-25"
    assert first["params"]["clientInfo"] == {"name": "agents-e2e", "version": "1.0.0"}


# ---------------------------------------------------------------- against the TypeScript server


def test_a_server_without_agents_exits_2(ts_server: TsServer, capsys: pytest.CaptureFixture[str]) -> None:
    code = cli.main(["--mcp-url", ts_server.mcp_url, "--only", "find"])
    if ts_server.process is None and code != 2:
        pytest.skip("MCP_URL points at a server with agents")
    assert code == 2
    captured = capsys.readouterr()
    assert captured.err == (
        f"{ts_server.mcp_url} does not offer agent_run: set AGENT_LLM_URL on the server, and include the agents "
        "and scripts groups if you set TOOLSETS (see docs/AGENTS.md).\n"
    )
    assert captured.out == ""


class SlowModel:
    """An OpenAI-compatible chat completions stand-in that answers every request with a `finish`
    tool call after `delay` seconds, streamed the way vLLM and LM Studio stream it."""

    def __init__(self, delay: float, output: str) -> None:
        self.delay, self.output = delay, output
        self.requests: list[dict[str, Any]] = []
        model = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                self._json(200, {"object": "list", "data": [{"id": "fake-model", "object": "model"}]})

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                model.requests.append(body)
                time.sleep(model.delay)
                args = json.dumps({"output": model.output, "success": True})
                delta_call = {
                    "index": 0,
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "finish", "arguments": args},
                }
                chunks = [
                    {"choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": {"tool_calls": [delta_call]}, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
                    {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}},
                ]
                if not body.get("stream"):
                    call = {k: v for k, v in delta_call.items() if k != "index"}
                    message = {"role": "assistant", "content": None, "tool_calls": [call]}
                    self._json(200, {"choices": [{"index": 0, "message": message, "finish_reason": "tool_calls"}]})
                    return
                payload = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
                data = payload.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _json(self, status: int, value: Any) -> None:
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def slow_model() -> Iterator[SlowModel]:
    model = SlowModel(delay=14, output="Albert Einstein")
    yield model
    model.close()


@pytest.mark.anyio
async def test_long_agent_calls_stay_alive_on_progress_heartbeats(
    ts_server_factory: StartServer, slow_model: SlowModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    """agent_run waits minutes for a model. The server sends a progress heartbeat every 10 s to a
    client that asks for progress, which keeps the response stream from hitting the read timeout
    (300 s in the runner; 12.5 s here, shorter than the model's 14 s silence)."""
    server = ts_server_factory(
        {
            "AGENT_LLM_URL": slow_model.url,
            "AGENT_LLM_API_KEY": "test-key",
            "AGENT_LLM_MODEL": "fake-model",
            "AGENT_CONTEXT_TOKENS": "65536",
            "AGENT_WAIT_SECONDS": "120",
        }
    )
    http = httpx2.AsyncClient(headers=auth_headers(), timeout=httpx2.Timeout(runner.CONNECT_TIMEOUT, read=12.5))
    info = Implementation(name=runner.CLIENT_NAME, version=runner.CLIENT_VERSION)
    async with http, Client(streamable_http_client(server.mcp_url, http_client=http), client_info=info) as client:
        assert "agent_run" in await runner.tool_names(client)
        call = runner.make_call(client)
        started = time.monotonic()
        res = await call(
            "agent_run", {"task": "Name the author.", "output": "Only the author name.", "wait_seconds": 60}
        )
        elapsed = time.monotonic() - started
        assert not res.is_error, res.text
        assert res.structured["status"] == "completed", res.text
        assert res.structured["output"] == "Albert Einstein"
        assert elapsed > 13, "the model's delay passed without a byte from the server but for heartbeats"

        tabs = await call("browser_tab_list", {})
        assert tabs.structured is None or isinstance(tabs.structured, dict)
        missing = await call("script_get", {"name": "no-such-script"})
        assert missing.is_error
        assert "no-such-script" in missing.text
    assert slow_model.requests, "the sub-agent asked the stand-in model"
    # the server's activity feed names this client the way the TypeScript runner did
    assert runner.CLIENT_NAME in json.dumps(server.get_json("/api/state"))


@pytest.mark.anyio
async def test_a_lost_connection_still_gives_a_full_report(
    ts_server_factory: StartServer,
    slow_model: SlowModel,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    """When the server goes away mid-run, the scenario in flight and the ones after it are reported
    as crashed (the TypeScript runner did the same, one failed call at a time), and the summary and
    the JSON report are still written."""
    server = ts_server_factory(
        {"AGENT_LLM_URL": slow_model.url, "AGENT_LLM_MODEL": "fake-model", "AGENT_CONTEXT_TOKENS": "65536"}
    )
    if server.process is None:
        pytest.skip("stops the server it started")

    async def stop_during_call(call: Any) -> Any:
        stopper = threading.Timer(1.0, server.stop)
        stopper.start()
        try:
            await call("agent_run", {"task": "Name the author.", "output": "Only the name.", "wait_seconds": 60})
        finally:
            stopper.join()
        raise AssertionError("the call should not return")

    async def after(call: Any) -> Any:
        await call("browser_tab_list", {})
        raise AssertionError("the server is gone")

    monkeypatch.setitem(scenarios.SCENARIOS, "run", stop_during_call)
    monkeypatch.setitem(scenarios.SCENARIOS, "find", after)
    monkeypatch.setattr(runner, "use_color", lambda stream: False)
    report = tmp_path / "results.json"
    out = io.StringIO()
    options = runner.Options(only=["run", "find"], repeat=1, mcp_url=server.mcp_url, json_file=str(report))
    assert await runner.run(options, out) == 1
    lines = out.getvalue().splitlines()
    assert lines[0].startswith("[run] … FAIL (")
    assert lines[1].startswith("    - crashed: ")
    assert lines[2].startswith("[find] … FAIL (")
    # the next call fails to connect, which ends the SDK's transport: the runner records it and stops
    assert lines[3] == "    - crashed: the connection to the server was lost: All connection attempts failed"
    assert lines[-1] == "0/2 passed"
    data = json.loads(report.read_text())
    assert [o["scenario"] for o in data["outcomes"]] == ["run", "find"]
    assert all(not o["pass"] for o in data["outcomes"])
