"""The MCP side: a Streamable HTTP connection to the Stealth Web Search server, and the tool list
as OpenAI function tools.

Each connection runs in its own task. The MCP SDK keeps a task group open for the life of a
connection, and a failed HTTP request (the server went away) cancels whatever runs inside that
group; in a task of its own, a lost connection only fails the calls waiting on it, and the agent
can reconnect.
"""

from __future__ import annotations

import contextlib
import copy
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import Any

import anyio
import anyio.abc
import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError
from mcp.types import CallToolResult, Implementation, TextContent, Tool

from ._js import js_truthy
from .errors import AgentError, error_message, exception_leaves, sole_exception
from .lmstudio import auth_headers

CLIENT_VERSION = "1.0.0"
GROUP_META = "stealth-web-search/group"
"""The server publishes each tool's group (core, content, ...) in the tool's _meta under this key."""

CONNECTION_CLOSED = -32000
REQUEST_TIMEOUT = -32001
CLOSE_TIMEOUT_S = 10.0
DEFAULT_REQUEST_TIMEOUT_S = 60.0


DRAIN_LIMIT_S = 0.05
"""How long closing a response may wait for the rest of it, to keep its connection."""


class _DrainOnClose(httpx2.AsyncByteStream):
    """A response body that, when closed before its end, first reads what is left (for a moment), so
    its keep-alive connection goes back to the pool. The SDK closes each POST's event stream as
    soon as the result arrives, just before the server ends the stream; without this, every MCP
    message opened a new TCP connection (as Node's fetch never did)."""

    def __init__(self, stream: httpx2.AsyncByteStream) -> None:
        self._stream = stream
        self._chunks: AsyncIterator[bytes] | None = None
        """The body's own iterator. Only this object uses it: the readers above get a generator of
        their own, which they may close (even while the rest is read here) without touching it."""

    async def __aiter__(self) -> AsyncIterator[bytes]:
        self._chunks = self._stream.__aiter__()
        async for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        try:
            rest = self._chunks if self._chunks is not None else self._stream.__aiter__()
            with anyio.move_on_after(DRAIN_LIMIT_S), contextlib.suppress(Exception):
                async for _ in rest:
                    pass
        finally:
            await self._stream.aclose()


class KeepAliveTransport(httpx2.AsyncBaseTransport):
    """httpx's transport, with POST responses that keep their connection when closed early."""

    def __init__(self) -> None:
        self._inner = httpx2.AsyncHTTPTransport(trust_env=False)

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        response = await self._inner.handle_async_request(request)
        if request.method == "POST" and isinstance(response.stream, httpx2.AsyncByteStream):
            response.stream = _DrainOnClose(response.stream)
        return response

    async def aclose(self) -> None:
        await self._inner.aclose()


class AbortError(Exception):
    """A tool call stopped by the abort signal (the text the model sees, as with fetch)."""

    def __init__(self) -> None:
        super().__init__("This operation was aborted")


class McpConnection:
    """One MCP session (the 2025-11-25 initialize handshake, as the TypeScript client made).
    Start it with `connect()`; `close()` ends the session with an HTTP DELETE."""

    def __init__(self, url: str, auth_token: str | None, client_name: str) -> None:
        self.url = url
        self.client_name = client_name
        self._auth_token = auth_token
        self.client: Client | None = None
        self.error: BaseException | None = None
        """Why the connection ended (or never started), when it failed."""
        self.statuses: list[int] = []
        """HTTP error statuses (>= 400) the server answered to MCP messages since the last call started."""
        self._stop = anyio.Event()
        self._done = anyio.Event()

    async def _on_response(self, response: httpx2.Response) -> None:
        # MCP messages only (POST): the standalone GET stream reconnects by itself
        if response.status_code >= 400 and response.request.method == "POST":
            self.statuses.append(response.status_code)

    async def _run(self, *, task_status: anyio.abc.TaskStatus[None] = anyio.TASK_STATUS_IGNORED) -> None:
        started = False
        http = httpx2.AsyncClient(
            headers=auth_headers(self._auth_token),
            # the SDK's defaults; the tool timeout is set per call
            timeout=httpx2.Timeout(30, read=300),
            # straight to the server, as Node's fetch does: never HTTP_PROXY/HTTPS_PROXY
            trust_env=False,
            transport=KeepAliveTransport(),
            event_hooks={"response": [self._on_response]},
        )
        try:
            async with (
                http,
                Client(
                    streamable_http_client(self.url, http_client=http),
                    client_info=Implementation(name=self.client_name, version=CLIENT_VERSION),
                    mode="legacy",
                    # the TypeScript SDK's default request timeout; tool calls set their own
                    read_timeout_seconds=DEFAULT_REQUEST_TIMEOUT_S,
                ) as client,
            ):
                self.client = client
                started = True
                task_status.started()
                await self._stop.wait()
        except Exception as exc:
            self.error = exc
        finally:
            self._done.set()
            if not started:
                task_status.started()

    @property
    def closed(self) -> bool:
        return self._done.is_set()

    def transport_failed(self) -> bool:
        """The connection ended because an HTTP request to the server failed."""
        return self.error is not None and any(
            isinstance(leaf, (httpx2.TransportError, OSError)) for leaf in exception_leaves(self.error, causes=True)
        )

    async def wait_closed(self, limit_s: float) -> None:
        with anyio.move_on_after(limit_s, shield=True):
            await self._done.wait()

    async def list_tools(self) -> list[Tool]:
        return (await self._client().list_tools()).tools

    @property
    def instructions(self) -> str | None:
        return self.client.instructions if self.client is not None and not self.closed else None

    async def call_tool(self, name: str, arguments: dict[str, Any], timeout_s: float | None = None) -> CallToolResult:
        """Call a tool; `timeout_s` (default: 60 s, as the TypeScript SDK) bounds the wait for its result."""
        self.statuses = []
        return await self._client().call_tool(name, arguments, read_timeout_seconds=timeout_s)

    def _client(self) -> Client:
        if self.client is None or self.closed:
            raise MCPError(CONNECTION_CLOSED, "Connection closed")
        return self.client

    async def close(self) -> None:
        """End the session (HTTP DELETE) and the connection; never raises."""
        self._stop.set()
        await self.wait_closed(CLOSE_TIMEOUT_S)


def describe_error(exc: BaseException) -> str:
    """The message the TypeScript SDK would give for the same failure."""
    if isinstance(exc, MCPError):
        if exc.code == REQUEST_TIMEOUT and exc.message.startswith("Request '") and exc.message.endswith("timed out"):
            return "Request timed out"
        return exc.message
    return error_message(exc)


async def connect_mcp(tg: anyio.abc.TaskGroup, mcp_url: str, auth_token: str | None, client_name: str) -> McpConnection:
    """Open a session in a task of `tg`, or raise AgentError with a hint."""
    conn = McpConnection(mcp_url, auth_token, client_name)
    await tg.start(conn._run)
    if conn.client is None:
        status = next((s for s in conn.statuses if s in (401, 403)), None)
        if status == 401:
            hint = "the server requires a token: set AUTH_TOKEN"
        elif status == 403:
            hint = "the Host header was rejected: use 127.0.0.1 or add the host to ALLOWED_HOSTS on the server"
        else:
            hint = "is the server running? Start it with `docker compose up -d` or `npm run dev`, or set MCP_URL"
        reason = describe_error(conn.error) if conn.error is not None else "connection closed"
        raise AgentError(f"Cannot connect to the MCP server at {mcp_url}: {reason} ({hint})")
    return conn


@asynccontextmanager
async def mcp_session(mcp_url: str, auth_token: str | None, client_name: str) -> AsyncIterator[McpConnection]:
    """A connection for the length of a `with` block. An error from connecting or from the block
    comes out as itself, not wrapped in the task group's ExceptionGroup."""
    single: BaseException | None = None
    try:
        async with anyio.create_task_group() as tg:
            conn = await connect_mcp(tg, mcp_url, auth_token, client_name)
            try:
                yield conn
            finally:
                await conn.close()
    except Exception as exc:
        single = sole_exception(exc)
        if single is exc:
            raise
    if single is not None:
        raise single  # outside the except block, so the group does not become its context


def error_result(text: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=True)


def to_openai_tool(tool: Tool) -> dict[str, Any]:
    """MCP tool -> OpenAI function tool."""
    parameters: dict[str, Any] = copy.deepcopy(tool.input_schema) if isinstance(tool.input_schema, dict) else {}
    parameters.pop("$schema", None)
    parameters["type"] = "object"
    properties = parameters.get("properties")
    if not js_truthy(properties) or not isinstance(properties, (dict, list)):
        parameters["properties"] = {}
    description = (
        tool.description if tool.description is not None else tool.title if tool.title is not None else tool.name
    )
    return {"type": "function", "function": {"name": tool.name, "description": description, "parameters": parameters}}


def tool_group(tool: Tool) -> str | None:
    group = (tool.meta or {}).get(GROUP_META)
    return group if isinstance(group, str) else None


def select_tools(
    tools: Sequence[Tool], names: Sequence[str] | None = None, toolsets: Sequence[str] | None = None
) -> list[Tool]:
    """The tools to offer: those of the groups (or with the names) in `toolsets`, plus `names`."""
    selected = list(tools)
    sets = [s.lower() for s in toolsets or []]
    if sets and "all" not in sets:
        known_groups: list[str] = []
        for tool in tools:
            group = tool_group(tool)
            if group is not None and group not in known_groups:
                known_groups.append(group)
        unknown = [s for s in sets if s not in known_groups and not any(t.name == s for t in tools)]
        if unknown:
            raise AgentError(f"Unknown toolset(s): {', '.join(unknown)}. Groups: {', '.join(known_groups)} (or all).")
        wanted = set(sets)
        selected = [t for t in selected if (tool_group(t) or "") in wanted or t.name in wanted]
    if names:
        unknown = [n for n in names if not any(t.name == n for t in tools)]
        if unknown:
            offered = ", ".join(t.name for t in tools)
            raise AgentError(f"Unknown tool(s): {', '.join(unknown)}. The server offers: {offered}")
        extra = [t for t in tools if t.name in names and all(t is not s for s in selected)]
        selected = [*selected, *extra] if toolsets else [t for t in tools if t.name in names]
    if not selected:
        raise AgentError("No tools selected: check --tools / --toolsets against the tools the server offers.")
    return selected
