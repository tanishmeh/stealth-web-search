"""The host's MCP connection keeps its HTTP connections alive, as Node's fetch did: the SDK closes
each POST's event stream as soon as the result is in, and the transport reads the stream's end so
the connection can carry the next message."""

from __future__ import annotations

import os
import socket
import threading
import time
import urllib.parse
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx2
import pytest

from sws_tools.lmstudio_agent.mcp_client import DRAIN_LIMIT_S, KeepAliveTransport, mcp_session
from sws_tools.ts_server import TsServer
from tests.lmstudio_agent.fakes import TcpProxy


class _EventStream(BaseHTTPRequestHandler):
    """Answers POST with one server-sent event, then ends the stream; /hold keeps it open."""

    protocol_version = "HTTP/1.1"
    connections: list[int]
    release: threading.Event

    def log_message(self, format: str, *args: object) -> None:
        pass

    def setup(self) -> None:
        super().setup()
        self.connections.append(1)

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        event = b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'
        self.wfile.write(f"{len(event):x}\r\n".encode() + event + b"\r\n")
        self.wfile.flush()
        if self.path == "/hold":
            self.release.wait(5)
            self.close_connection = True
            return
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


@pytest.fixture
def event_server() -> Iterator[tuple[str, list[int], threading.Event]]:
    connections: list[int] = []
    release = threading.Event()
    handler = type("Handler", (_EventStream,), {"connections": connections, "release": release})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", connections, release
    finally:
        release.set()
        server.shutdown()
        server.server_close()


async def read_first_event(http: httpx2.AsyncClient, url: str) -> None:
    # what the SDK does: stop at the result and close the response before the stream ends
    async with http.stream("POST", url, content=b"{}") as res:
        async for line in res.aiter_lines():
            if line.startswith("data:"):
                break


@pytest.mark.anyio
async def test_a_response_closed_after_its_event_leaves_the_connection_open(
    event_server: tuple[str, list[int], threading.Event],
) -> None:
    base, connections, _ = event_server
    async with httpx2.AsyncClient(transport=KeepAliveTransport()) as http:
        for _ in range(5):
            await read_first_event(http, f"{base}/mcp")
    assert len(connections) == 1


@pytest.mark.anyio
async def test_a_stream_the_server_keeps_open_is_closed_after_a_moment(
    event_server: tuple[str, list[int], threading.Event],
) -> None:
    base, connections, _ = event_server
    async with httpx2.AsyncClient(transport=KeepAliveTransport()) as http:
        started = time.monotonic()
        await read_first_event(http, f"{base}/hold")
        assert time.monotonic() - started < DRAIN_LIMIT_S + 1
        await read_first_event(http, f"{base}/mcp")
    assert len(connections) == 2, "the held connection was given up, not reused"


@pytest.mark.anyio
async def test_tool_calls_share_a_keep_alive_connection_to_the_server(ts_server: TsServer) -> None:
    target = urllib.parse.urlsplit(ts_server.mcp_url)
    assert target.hostname is not None
    assert target.port is not None
    proxy = TcpProxy(socket.gethostbyname(target.hostname), target.port)
    try:
        url = f"http://127.0.0.1:{proxy.port}{target.path}"
        async with mcp_session(url, os.environ.get("AUTH_TOKEN"), "keep-alive-test") as conn:
            await conn.list_tools()
            for _ in range(10):
                result = await conn.call_tool("browser_tab_list", {}, 60)
                assert not result.is_error
        # one for the MCP messages and one for the server's event stream (GET); before, every
        # message opened its own
        assert proxy.accepted <= 3, f"{proxy.accepted} TCP connections for 13 MCP messages"
    finally:
        proxy.cut()
