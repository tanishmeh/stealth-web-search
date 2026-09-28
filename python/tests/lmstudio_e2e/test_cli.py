"""The e2e runner's command line: how it reports a server it cannot use, and what it writes to a
stdout whose locale cannot show the model's text."""

from __future__ import annotations

import re
import subprocess
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from sws_tools.ts_server import TsServer
from tests.conftest import StartServer
from tests.lmstudio_agent.fakes import MODEL, FakeLmStudio, Reply, Stream, answer, choice, tool_call


class _TokenRequired(BaseHTTPRequestHandler):
    """A server that is up (/healthz) but answers every MCP message with 401."""

    def log_message(self, format: str, *args: object) -> None:
        pass

    def _reply(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._reply(200, b'{"ok":true}')
        else:
            self._reply(401, b'{"error":"unauthorized"}')

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._reply(401, b'{"error":"unauthorized"}')


@pytest.fixture
def token_required() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _TokenRequired)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/mcp"
    finally:
        server.shutdown()
        server.server_close()


def run_e2e(
    python_env: dict[str, str], lms: FakeLmStudio, *args: str, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[bytes]:
    env = {k: v for k, v in python_env.items() if k not in ("AUTH_TOKEN", "MCP_URL", "LMSTUDIO_MODEL")}
    env.update({"LMSTUDIO_URL": lms.url, "NO_COLOR": "1", **(extra_env or {})})
    return subprocess.run(
        [sys.executable, "-m", "sws_tools.lmstudio_e2e", "--only", "a", *args],
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=120,
        check=False,
    )


def test_a_server_that_wants_a_token_gives_one_error_line(
    lms: FakeLmStudio, token_required: str, python_env: dict[str, str]
) -> None:
    done = run_e2e(python_env, lms, "--mcp-url", token_required)
    stderr = done.stderr.decode()
    assert done.returncode == 1, stderr
    assert re.fullmatch(
        rf"Error: Cannot connect to the MCP server at {re.escape(token_required)}: .*"
        r"\(the server requires a token: set AUTH_TOKEN\)\n",
        stderr,
    ), stderr
    assert not lms.requests, "no model request before the server is usable"


def test_a_failed_preflight_gives_one_error_line_with_the_docker_hint(
    lms: FakeLmStudio, ts_server_factory: StartServer, python_env: dict[str, str]
) -> None:
    server = ts_server_factory({"ALLOW_PRIVATE_NETWORK": "false"})
    if server.process is None:
        pytest.skip("needs a server started with ALLOW_PRIVATE_NETWORK=false")
    done = run_e2e(python_env, lms, "--mcp-url", server.mcp_url)
    stderr = done.stderr.decode()
    assert done.returncode == 1, stderr
    assert stderr.startswith("Error: Preflight failed: the browser cannot open the fixture site http://"), stderr
    assert stderr.endswith(
        "Run the server with ALLOW_PRIVATE_NETWORK=true, and when it runs in Docker set "
        "FIXTURE_HOST=host.docker.internal.\n"
    ), stderr
    assert stderr.count("\n") == 1, stderr
    assert not lms.requests


def test_writes_utf8_whatever_the_locale_of_stdout(
    lms: FakeLmStudio, ts_server: TsServer, python_env: dict[str, str]
) -> None:
    # Node writes UTF-8 to a file or a pipe whatever the locale; a latin-1 stdout (a Latin-1 locale,
    # or Windows with the output redirected) must not end the run on the model's first arrow
    def reply(body: dict[str, Any], i: int) -> Reply:
        if i == 0:
            task = body["messages"][-1]["content"]
            url = re.search(r"http://\S+/index\.html", task)
            assert url, task
            return tool_call("browser_navigate", {"url": url.group(0)})
        return Stream(
            [
                choice({"role": "assistant", "reasoning_content": "page read → answer"}),
                *answer('The h1 is "Hello Fixture" → Pear costs $2.').chunks,
            ]
        )

    lms.reset(reply)
    done = run_e2e(
        python_env,
        lms,
        "--mcp-url",
        ts_server.mcp_url,
        "--model",
        MODEL,
        extra_env={"PYTHONIOENCODING": "latin-1"},
    )
    stdout = done.stdout.decode("utf-8")
    assert done.returncode == 0, f"{stdout}\n{done.stderr.decode()}"
    assert "page read → answer" in stdout
    assert re.search(r"^PASS a read page ", stdout, re.M), stdout
    assert "All 1 checks passed" in stdout
