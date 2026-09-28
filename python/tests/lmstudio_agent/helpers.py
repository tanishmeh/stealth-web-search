"""Helpers of the agent host tests."""

from __future__ import annotations

import os
from typing import Any

from mcp.types import CallToolResult

from sws_tools.lmstudio_agent.mcp_client import mcp_session
from sws_tools.ts_server import TsServer


async def server_call(server: TsServer, name: str, args: dict[str, Any]) -> CallToolResult:
    """Call a tool on the server as a client of its own (the TS harness's srv.call)."""
    async with mcp_session(server.mcp_url, os.environ.get("AUTH_TOKEN"), "integration-test") as conn:
        return await conn.call_tool(name, args, 60)
