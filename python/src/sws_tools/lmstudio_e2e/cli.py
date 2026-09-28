"""Command line of `sws-lmstudio-e2e` (npm run lmstudio:e2e): end-to-end checks with a real local
model. LM Studio drives the Stealth Web Search server through the same loop as the CLI agent, and
every scenario is judged by objective assertions (answer text, requests the fixture site received,
the server's own activity feed).

    npm run lmstudio:e2e                          # scenarios a, b, d
    npm run lmstudio:e2e -- --online              # also c (public JS-rendered site)
    npm run lmstudio:e2e -- --only a --repeat 3

Server: MCP_URL (or --mcp-url) when set; otherwise http://127.0.0.1:8931/mcp if it is up; otherwise
a local server is spawned (needs `npm run obscura:download`). When the server runs in Docker, set
FIXTURE_HOST=host.docker.internal and run the container with ALLOW_PRIVATE_NETWORK=true so the
browser can reach the fixture site.
"""

from __future__ import annotations

import math
import os
import re
import sys
import time
import traceback
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from sws_tools._shutdown import skip_final_collection
from sws_tools.lmstudio_agent._args import Option, ParseArgsError, parse_args
from sws_tools.lmstudio_agent._js import js_json, js_len, js_number, js_to_fixed, js_trim, js_trim_end
from sws_tools.lmstudio_agent.errors import AgentError, sole_exception
from sws_tools.lmstudio_agent.options import DEFAULT_LMSTUDIO_URL, DEFAULT_MCP_URL, REASONING_MODES
from sws_tools.lmstudio_agent.output import (
    Style,
    stdout_closed,
    stdout_color,
    style_text,
    utf8_stdio,
    write_stderr,
    write_stdout,
)

if TYPE_CHECKING:
    from .scenarios import ActivityCheck, RunRecord

USAGE = f"""Usage: npm run lmstudio:e2e -- [options]
       sws-lmstudio-e2e [options]

Options:
  --only <a,b,c,d>       scenarios to run (default: a,b,d; c needs --online)
  --online               include scenarios that need the internet (c)
  --repeat <n>           run each model scenario n times (default 1)
  --model <id>           LM Studio model (default: LMSTUDIO_MODEL or the first loaded tool-use LLM)
  --reasoning <mode>     none | low | medium | high | on (default low)
  --max-steps <n>        override the per-scenario step limit
  --mcp-url <url>        MCP endpoint (default MCP_URL, else {DEFAULT_MCP_URL} if up, else spawn a local server)
  --spawn                always spawn a local server for the run
  --quiet                only print the summary
  --json <file>          write results (with transcripts) as JSON
  -h, --help

Environment: MCP_URL, AUTH_TOKEN, LMSTUDIO_URL, LM_API_TOKEN, LMSTUDIO_MODEL, FIXTURE_HOST."""

OPTIONS: dict[str, Option] = {
    "only": Option("string"),
    "online": Option("boolean"),
    "repeat": Option("string"),
    "model": Option("string"),
    "reasoning": Option("string"),
    "max-steps": Option("string"),
    "mcp-url": Option("string"),
    "spawn": Option("boolean"),
    "quiet": Option("boolean", short="q"),
    "json": Option("string"),
    "help": Option("boolean", short="h"),
}

SCENARIO_TIMEOUT_S = 15 * 60
KNOWN_IDS = ("a", "b", "c", "d")
_MCP_SUFFIX = re.compile(r"/mcp/?$")


def seconds_text(ms: float) -> str:
    return f"{js_to_fixed(ms / 1000, 1)} s"


def table(rows: Sequence[Sequence[str]]) -> str:
    widths = [max(js_len(r[i]) for r in rows) for i in range(len(rows[0]))]

    def fmt(row: Sequence[str]) -> str:
        return js_trim_end("  ".join(c + " " * (widths[i] - js_len(c)) for i, c in enumerate(row)))

    return "\n".join([fmt(rows[0]), "  ".join("-" * w for w in widths), *(fmt(r) for r in rows[1:])])


def base_url_of(mcp_url: str) -> str:
    return _MCP_SUFFIX.sub("", mcp_url)


def _is_integer(value: float) -> bool:
    """Number.isInteger."""
    return math.isfinite(value) and value.is_integer()


def _str(values: dict[str, str | bool], name: str) -> str | None:
    value = values.get(name)
    return value if isinstance(value, str) else None


def _integral(n: float) -> float | int:
    return int(n) if n.is_integer() and abs(n) < 2**53 else n


class _Output:
    def __init__(self, color: bool) -> None:
        self.color = color

    def style(self, fmt: Style, text: str) -> str:
        return style_text(fmt, text) if self.color else text

    @staticmethod
    def log(text: str = "") -> None:
        write_stdout(f"{text}\n")

    @staticmethod
    def error(text: str) -> None:
        write_stderr(f"{text}\n")


async def _check_activity(base_url: str, runs: list[RunRecord]) -> ActivityCheck:
    """(d) GET /api/state and match it against the agent's tool calls."""
    import anyio

    from sws_tools.ts_server import TsServer

    from .scenarios import ActivityCheck, verify_activity

    def fetch() -> tuple[int, Any]:
        import urllib.error

        try:
            return 200, TsServer.external(f"{base_url}/mcp").get_json("/api/state")
        except urllib.error.HTTPError as exc:
            return exc.code, None

    status, state = await anyio.to_thread.run_sync(fetch)
    if status != 200:
        return ActivityCheck(failures=[f"GET /api/state returned HTTP {status}"])
    return verify_activity(state, runs)


async def _main(values: dict[str, str | bool]) -> int:
    import anyio
    import httpx2

    from sws_tools.fixture_site import start_fixture_site
    from sws_tools.lmstudio_agent.abort import AbortController
    from sws_tools.lmstudio_agent.agent import AgentOptions, iso_time, now_ms, run_agent
    from sws_tools.lmstudio_agent.lmstudio import resolve_model
    from sws_tools.lmstudio_agent.mcp_client import mcp_session
    from sws_tools.ts_server import TsServer, is_healthy, start_ts_server

    from .scenarios import CLIENT_NAME, SCENARIOS, RunRecord, ScenarioContext

    out = _Output(stdout_color())
    only_raw = _str(values, "only")
    only = [i for i in (js_trim(s).lower() for s in only_raw.split(",")) if i] if only_raw is not None else None
    reasoning = _str(values, "reasoning")
    repeat_raw = _str(values, "repeat")
    repeat = js_number(repeat_raw) if repeat_raw is not None else 1.0
    max_steps_raw = _str(values, "max-steps")
    max_steps_override = js_number(max_steps_raw) if max_steps_raw else None
    bad_ids = [i for i in only or [] if i not in KNOWN_IDS]
    if (
        bad_ids
        or (reasoning and reasoning not in REASONING_MODES)
        or not (_is_integer(repeat) and repeat >= 1)
        or (max_steps_override is not None and not max_steps_override >= 1)
    ):
        out.error(f"Invalid options.\n\n{USAGE}")
        return 2
    repeat_n = int(repeat)
    online = bool(values.get("online"))
    quiet = bool(values.get("quiet"))

    def wanted(scenario_id: str) -> bool:
        return scenario_id in only if only is not None else scenario_id != "c" or online

    if only is not None and "c" in only and not online:
        out.log(
            out.style(
                "yellow", "Note: scenario c needs internet access; running it because it was requested with --only."
            )
        )
    scenarios = [s for s in SCENARIOS if wanted(s.id)]
    want_activity = wanted("d")

    lmstudio_url = os.environ.get("LMSTUDIO_URL", DEFAULT_LMSTUDIO_URL)
    lm_api_token = os.environ.get("LM_API_TOKEN")
    auth_token = os.environ.get("AUTH_TOKEN")
    requested_model = _str(values, "model")
    if requested_model is None:
        requested_model = os.environ.get("LMSTUDIO_MODEL")
    async with httpx2.AsyncClient(trust_env=False) as http:
        model = await resolve_model(http, lmstudio_url, lm_api_token, requested_model)

    async def healthy(url: str) -> bool:
        return await anyio.to_thread.run_sync(is_healthy, base_url_of(url), 3.0)

    spawned: TsServer | None = None
    mcp_url = _str(values, "mcp-url")
    if mcp_url is None:
        mcp_url = os.environ.get("MCP_URL")
    if values.get("spawn") or (not mcp_url and not await healthy(DEFAULT_MCP_URL)):
        out.log(out.style("dim", "Starting a local Stealth Web Search server for this run..."))
        saved = os.environ.pop("MCP_URL", None)
        try:
            spawned = await anyio.to_thread.run_sync(lambda: start_ts_server({"LOG_LEVEL": "warn"}))
        finally:
            if saved is not None:
                os.environ["MCP_URL"] = saved
        mcp_url = spawned.mcp_url
    if mcp_url is None:
        mcp_url = DEFAULT_MCP_URL
    if spawned is None and not await healthy(mcp_url):
        out.error(
            f"The MCP server at {mcp_url} is not reachable (GET /healthz failed). Start it, fix MCP_URL, or pass --spawn."
        )
        return 1
    base_url = base_url_of(mcp_url)
    fx = start_fixture_site()
    runs: list[RunRecord] = []
    activity_result: ActivityCheck | None = None
    suite_started = time.monotonic()

    try:
        # Preflight without the model: the browser must reach the fixture site.
        async with mcp_session(mcp_url, auth_token, f"{CLIENT_NAME}-preflight") as pre:
            tools = [t.name for t in await pre.list_tools()]
            nav = await pre.call_tool("browser_navigate", {"url": f"{fx.base_url}/index.html"})
            if nav.is_error:
                text = " ".join(getattr(c, "text", "") for c in nav.content)
                raise AgentError(
                    f"Preflight failed: the browser cannot open the fixture site {fx.base_url} ({text}). "
                    "Run the server with ALLOW_PRIVATE_NETWORK=true, and when it runs in Docker set "
                    "FIXTURE_HOST=host.docker.internal."
                )

        where = " (spawned)" if spawned else ""
        out.log(
            f"{out.style('bold', 'LM Studio E2E')} "
            + out.style(
                "dim",
                f"| model {model.id} | reasoning {reasoning or 'low'} | MCP {mcp_url}{where} | fixture {fx.base_url} "
                f"| {len(tools)} tools",
            )
        )

        for scenario in scenarios:
            for run in range(1, repeat_n + 1):
                label = f"{scenario.id}{f'#{run}' if repeat_n > 1 else ''}"
                started_at = iso_time(now_ms())
                unsupported = scenario.unsupported(tools) if scenario.unsupported else None
                if unsupported:
                    runs.append(
                        RunRecord(
                            scenario=scenario.id,
                            name=scenario.name,
                            run=run,
                            status="fail",
                            steps=0,
                            tool_calls=0,
                            duration_ms=0,
                            failures=[f"cannot run: {unsupported}"],
                            tools=[],
                            answer=None,
                            started_at=started_at,
                        )
                    )
                    out.log(out.style("red", f"\n=== {label} {scenario.name}: cannot run ({unsupported})"))
                    continue
                if not quiet:
                    out.log(out.style(["bold", "cyan"], f"\n=== scenario {label}: {scenario.name}"))
                request_mark = len(fx.requests)
                pending = ""

                def indent(text: str) -> str:
                    return "\n".join(js_trim_end(f"  | {line}") for line in text.split("\n"))

                def write(text: str) -> None:
                    nonlocal pending
                    if quiet:
                        return
                    pending += text
                    cut = pending.rfind("\n")
                    if cut < 0:
                        return
                    write_stdout(f"{indent(pending[:cut])}\n")
                    pending = pending[cut + 1 :]

                controller = AbortController()
                timer = controller.abort_after(SCENARIO_TIMEOUT_S)
                try:
                    result = await run_agent(
                        AgentOptions(
                            task=scenario.task(fx),
                            mcp_url=mcp_url,
                            auth_token=auth_token,
                            lmstudio_url=lmstudio_url,
                            lm_api_token=lm_api_token,
                            model=model.id,
                            reasoning=reasoning,
                            max_steps=_integral(max_steps_override)
                            if max_steps_override is not None
                            else scenario.max_steps,
                            client_name=CLIENT_NAME,
                            quiet=quiet,
                            color=out.color,
                            write=write,
                            signal=controller.signal,
                        )
                    )
                finally:
                    timer.cancel()
                if pending and not quiet:
                    write_stdout(f"{indent(pending)}\n")
                stopped = []
                if not result.ok:
                    detail = f" ({result.error.split(chr(10))[0]})" if result.error else ""
                    stopped = [f"agent stopped: {result.stop_reason}{detail}"]
                failures = [
                    *stopped,
                    *scenario.check(ScenarioContext(fx=fx, result=result, requests=fx.requests[request_mark:])),
                ]
                record = RunRecord(
                    scenario=scenario.id,
                    name=scenario.name,
                    run=run,
                    status="fail" if failures else "pass",
                    steps=result.steps,
                    tool_calls=len(result.tool_calls),
                    duration_ms=result.duration_ms,
                    failures=failures,
                    tools=[c.name for c in result.tool_calls],
                    answer=result.final_answer,
                    started_at=started_at,
                    result=result,
                )
                runs.append(record)
                verdict = (
                    out.style(["bold", "green"], "PASS")
                    if record.status == "pass"
                    else out.style(["bold", "red"], "FAIL")
                )
                out.log(
                    f"{verdict} {label} {scenario.name} "
                    + out.style(
                        "dim",
                        f"({record.steps} steps, {record.tool_calls} tool calls, {seconds_text(record.duration_ms)})",
                    )
                )
                for f in failures:
                    out.log(out.style("red", f"  - {f}"))

        if want_activity:
            activity_result = await _check_activity(base_url, runs)
            ok = not activity_result.failures
            verdict = out.style(["bold", "green"], "PASS") if ok else out.style(["bold", "red"], "FAIL")
            out.log(
                f"\n{verdict} d server activity feed "
                + out.style(
                    "dim",
                    f"({activity_result.verified} tool calls found in /api/state, {activity_result.logged} matched log records)",
                )
            )
            for f in activity_result.failures:
                out.log(out.style("red", f"  - {f}"))
    finally:
        fx.close()
        if spawned is not None:
            server = spawned
            await anyio.to_thread.run_sync(server.stop)

    rows = [["scenario", "result", "steps", "tool calls", "duration", "tools used"]]
    for r in runs:
        rows.append(
            [
                f"{r.scenario}{f'#{r.run}' if repeat_n > 1 else ''} {r.name}",
                r.status.upper(),
                str(r.steps),
                str(r.tool_calls),
                seconds_text(r.duration_ms),
                ", ".join(dict.fromkeys(r.tools)),
            ]
        )
    if activity_result:
        rows.append(
            [
                "d server activity feed",
                "FAIL" if activity_result.failures else "PASS",
                "-",
                str(activity_result.verified),
                "-",
                f"{activity_result.logged} log records matched",
            ]
        )
    out.log(f"\n{table(rows)}\n")
    failed = sum(1 for r in runs if r.status == "fail") + (1 if activity_result and activity_result.failures else 0)
    if failed:
        out.log(out.style(["bold", "red"], f"{failed} check(s) failed"))
    else:
        checks = len(runs) + (1 if activity_result else 0)
        elapsed = seconds_text((time.monotonic() - suite_started) * 1000)
        out.log(out.style(["bold", "green"], f"All {checks} checks passed") + out.style("dim", f" in {elapsed}"))

    json_path = _str(values, "json")
    if json_path is not None:
        report = {
            "model": model.id,
            "mcpUrl": mcp_url,
            "reasoning": reasoning or "low",
            "runs": [r.to_json() for r in runs],
            "activity": activity_result.to_json() if activity_result else None,
        }
        await anyio.Path(json_path).write_text(f"{js_json(report, 2)}\n", encoding="utf-8", newline="\n")
        out.log(f"Results written to {json_path}")
    return 1 if failed else 0


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command with `argv` (default: sys.argv[1:]) and return the process exit code."""
    try:
        utf8_stdio()
        try:
            values, _ = parse_args(sys.argv[1:] if argv is None else argv, OPTIONS)
        except ParseArgsError as exc:
            write_stderr(f"{exc}\n\n{USAGE}\n")
            return 2
        if values.get("help"):
            write_stdout(f"{USAGE}\n")
            return 0
        import asyncio
        import logging

        for name in ("mcp", "httpx2", "httpcore2"):
            logging.getLogger(name).addHandler(logging.NullHandler())
        skip_final_collection()
        return asyncio.run(_main(values))
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        return stdout_closed()
    except Exception as exc:
        error = sole_exception(exc)
        if isinstance(error, AgentError):
            write_stderr(f"Error: {error.message}\n")
        else:
            write_stderr(f"fatal: {''.join(traceback.format_exception(exc)).rstrip()}\n")
        return 1
