"""The TypeScript server starts from Python and answers the Python MCP client (integration)."""

from __future__ import annotations

import json

import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import Implementation

from sws_tools.fixture_site import FixtureSite
from sws_tools.ts_server import TsServer, auth_headers

GROUP_META = "stealth-web-search/group"


@pytest.mark.anyio
async def test_python_client_drives_the_server(ts_server: TsServer, fixture_site: FixtureSite) -> None:
    info = Implementation(name="sws-pytest", version="1.0.0")
    # the SDK's default timeouts (30 s, 300 s read), plus the bearer token when AUTH_TOKEN is set
    http = httpx2.AsyncClient(headers=auth_headers(), timeout=httpx2.Timeout(30, read=300))
    async with http, Client(streamable_http_client(ts_server.mcp_url, http_client=http), client_info=info) as client:
        tools = (await client.list_tools()).tools
        groups = {(tool.meta or {}).get(GROUP_META) for tool in tools}
        # --toolsets filtering in the Python agent host relies on this metadata
        assert None not in groups
        assert "core" in groups

        nav = await client.call_tool("browser_navigate", {"url": f"{fixture_site.base_url}/index.html"})
        assert not nav.is_error, nav.content
        text = await client.call_tool("browser_get_text", {"selector": "h1"})
        assert not text.is_error, text.content
        assert "Hello Fixture" in "\n".join(c.text for c in text.content if c.type == "text")

        # the server's activity feed names the client (the e2e runners filter on it)
        assert "sws-pytest" in json.dumps(ts_server.get_json("/api/state"))

    if ts_server.process is not None:  # managed mode: the log file is ours to read
        assert any(r.get("component") == "tool" for r in ts_server.logs())
    assert any(r.url == "/index.html" for r in fixture_site.requests)


def test_stop_ends_the_process(ts_server: TsServer) -> None:
    if ts_server.process is None:
        pytest.skip("MCP_URL points at a server started elsewhere")
    ts_server.stop()
    assert ts_server.process.returncode is not None
    ts_server.stop()  # a second stop is a no-op
