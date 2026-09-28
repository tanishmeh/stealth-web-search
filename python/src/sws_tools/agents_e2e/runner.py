"""Connect to the server, run the chosen scenarios, print the results and write the JSON report."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, TextIO

from ..ts_server import auth_headers
from .js import js_string, strip_undefined, to_fixed
from .scenarios import SCENARIOS, Call, Outcome, ToolResult

if TYPE_CHECKING:
    from mcp import Client

CLIENT_NAME = "agents-e2e"  # how the server's activity feed names this client
CLIENT_VERSION = "1.0.0"
# per tool call; longer than the longest wait_seconds (1200) plus the time to report back
CALL_TIMEOUT = 1500.0
CONNECT_TIMEOUT = 30.0
# the server sends a progress heartbeat every 10 s during agent waits, so 300 s of silence means it is gone
READ_TIMEOUT = 300.0


@dataclass(frozen=True)
class Options:
    only: list[str]
    repeat: int
    mcp_url: str
    json_file: str | None


def use_color(stream: TextIO) -> bool:
    """Whether Node's util.styleText would color this stream (FORCE_COLOR, NO_COLOR, a terminal)."""
    force = os.environ.get("FORCE_COLOR")
    if force is not None:
        return force in ("", "1", "true", "2", "3")
    if "NO_COLOR" in os.environ or "NODE_DISABLE_COLORS" in os.environ or os.environ.get("TERM") == "dumb":
        return False
    try:
        return stream.isatty()
    except (AttributeError, ValueError):
        return False


class Style:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def _wrap(self, text: str, start: int, end: int) -> str:
        return f"\x1b[{start}m{text}\x1b[{end}m" if self.enabled else text

    def bold(self, text: str) -> str:
        return self._wrap(text, 1, 22)

    def green(self, text: str) -> str:
        return self._wrap(text, 32, 39)

    def red(self, text: str) -> str:
        return self._wrap(text, 31, 39)


def seconds(ms: Any) -> str:
    """(ms / 1000).toFixed(1)"""
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return "NaN"
    return to_fixed(ms / 1000, 1)


def leaf_errors(err: BaseException) -> list[BaseException]:
    """The errors inside (nested) exception groups; anyio task groups wrap what they raise."""
    inner = getattr(err, "exceptions", None)
    if isinstance(inner, tuple) and inner:
        return [leaf for e in inner for leaf in leaf_errors(e)]
    return [err]


def first_error(err: BaseException) -> BaseException:
    """The error to report: the first one that is not just the cancellation of a sibling task."""
    leaves = leaf_errors(err)
    return next((e for e in leaves if not isinstance(e, asyncio.CancelledError)), leaves[0])


def error_message(err: BaseException) -> str:
    leaf = first_error(err)
    return str(leaf) or type(leaf).__name__


def make_call(client: Client) -> Call:
    async def ignore_progress(progress: float, total: float | None, message: str | None) -> None:
        # asking for progress makes the server send heartbeats during long agent waits, which keeps
        # the response stream alive (the TypeScript runner used resetTimeoutOnProgress the same way)
        del progress, total, message

    async def call(name: str, args: dict[str, Any], timeout: float = CALL_TIMEOUT) -> ToolResult:
        raw = await client.call_tool(
            name, strip_undefined(args), read_timeout_seconds=timeout, progress_callback=ignore_progress
        )
        text = "\n".join(block.text for block in raw.content if block.type == "text")
        return ToolResult(text=text, structured=raw.structured_content, is_error=bool(raw.is_error))

    return call


async def tool_names(client: Client) -> list[str]:
    names: list[str] = []
    cursor: str | None = None
    while True:
        page = await client.list_tools(cursor=cursor)
        names += [tool.name for tool in page.tools]
        cursor = page.next_cursor
        if not cursor:
            return names


class ScenarioRunner:
    """Runs the planned (attempt, scenario) pairs in order and prints each result as it comes."""

    def __init__(self, options: Options, out: TextIO) -> None:
        self.options, self.out = options, out
        self.style = Style(use_color(out))
        self.plan = [(attempt, s) for attempt in range(1, options.repeat + 1) for s in options.only]
        self.outcomes: list[Outcome] = []
        self._in_flight: float | None = None  # when the scenario whose header is printed started

    async def run(self, call: Call) -> list[Outcome]:
        for attempt, scenario in self.plan:
            started = self._begin(attempt, scenario)
            try:
                result = await SCENARIOS[scenario](call)
            except Exception as err:
                self._end(self._crashed(attempt, scenario, started, error_message(err)))
                continue
            elapsed = round((time.monotonic() - started) * 1000)
            passed = not result.failures
            self._end(Outcome(scenario, attempt, passed, result.failures, elapsed, result.runs, result.details))
        return self.outcomes

    def abandon(self, reason: str) -> list[Outcome]:
        """The connection is gone: the scenario in flight and the ones not run yet crash with `reason`,
        so the summary and the report still cover the whole plan."""
        for attempt, scenario in self.plan[len(self.outcomes) :]:
            started = self._in_flight if self._in_flight is not None else self._begin(attempt, scenario)
            self._end(self._crashed(attempt, scenario, started, reason))
        return self.outcomes

    def _begin(self, attempt: int, scenario: str) -> float:
        repeat = f" #{attempt}" if self.options.repeat > 1 else ""
        self.out.write(f"{self.style.bold(f'[{scenario}]')}{repeat} … ")
        self.out.flush()
        self._in_flight = time.monotonic()
        return self._in_flight

    @staticmethod
    def _crashed(attempt: int, scenario: str, started: float, message: str) -> Outcome:
        elapsed = round((time.monotonic() - started) * 1000)
        return Outcome(scenario, attempt, False, [f"crashed: {message}"], elapsed)

    def _end(self, outcome: Outcome) -> None:
        self._in_flight = None
        self.outcomes.append(outcome)
        runs = "; ".join(
            f"{js_string(r['runId'])} {js_string(r['kind'])} {js_string(r['status'])} {js_string(r['steps'])} steps "
            f"{seconds(r['durationMs'])} s"
            for r in outcome.runs
        )
        verdict = self.style.green("PASS") if outcome.passed else self.style.red("FAIL")
        self.out.write(f"{verdict} ({seconds(outcome.duration_ms)} s) {runs}\n")
        for failure in outcome.failures:
            self.out.write(f"    - {failure}\n")
        self.out.flush()


async def run_scenarios(call: Call, options: Options, out: TextIO) -> list[Outcome]:
    return await ScenarioRunner(options, out).run(call)


async def run(options: Options, out: TextIO = sys.stdout) -> int:
    """Run the scenarios against options.mcp_url; the exit code (0 all passed, 1 a failure, 2 no agent tools)."""
    # imported here, so --help and usage errors do not pay for loading the SDK
    import httpx2
    from mcp import Client
    from mcp.client.streamable_http import streamable_http_client
    from mcp.types import Implementation

    http = httpx2.AsyncClient(
        headers=auth_headers(),
        timeout=httpx2.Timeout(CONNECT_TIMEOUT, read=READ_TIMEOUT),
        # straight to the server, as Node's fetch did: never HTTP_PROXY/HTTPS_PROXY or the system proxy
        trust_env=False,
    )
    info = Implementation(name=CLIENT_NAME, version=CLIENT_VERSION)
    scenarios = ScenarioRunner(options, out)
    has_agents: bool | None = None
    # the 2025-11-25 initialize handshake (a session), as the TypeScript client and LM Studio connect
    transport = streamable_http_client(options.mcp_url, http_client=http)
    try:
        async with http, Client(transport, client_info=info, mode="legacy") as client:
            has_agents = "agent_run" in await tool_names(client)
            if has_agents:
                await scenarios.run(make_call(client))
    except Exception as err:
        if not has_agents:
            raise  # no connection at all: reported by the caller
        # the SDK ends every call in flight when the transport fails, and reports the failure here
        scenarios.abandon(f"the connection to the server was lost: {error_message(err)}")
    if not has_agents:
        print(
            f"{options.mcp_url} does not offer agent_run: set AGENT_LLM_URL on the server, and include the agents "
            "and scripts groups if you set TOOLSETS (see docs/AGENTS.md).",
            file=sys.stderr,
        )
        return 2

    outcomes = scenarios.outcomes
    passed = sum(outcome.passed for outcome in outcomes)
    out.write(f"\n{passed}/{len(outcomes)} passed\n")
    out.flush()
    if options.json_file:
        write_report(Path(options.json_file), options.mcp_url, outcomes)
    return 0 if passed == len(outcomes) else 1


def write_report(file: Path, mcp_url: str, outcomes: Sequence[Outcome]) -> None:
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    report = {"mcpUrl": mcp_url, "at": at, "outcomes": [strip_undefined(o.to_json()) for o in outcomes]}
    file.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
