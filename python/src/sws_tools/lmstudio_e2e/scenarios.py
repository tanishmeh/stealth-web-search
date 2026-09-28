"""The end-to-end scenarios and their objective checks (answer text, requests the fixture site
received, the server's own activity feed)."""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from sws_tools.fixture_site import FixtureSite, RecordedRequest
from sws_tools.lmstudio_agent._js import WS, js_json
from sws_tools.lmstudio_agent.agent import AgentResult, parse_iso_ms

CLIENT_NAME = "lmstudio-e2e"
TYPING_TOOLS = ("browser_fill", "browser_type", "browser_fill_form", "browser_evaluate")


@dataclass
class ScenarioContext:
    fx: FixtureSite | None
    result: AgentResult
    requests: Sequence[RecordedRequest]
    """Fixture requests received while the scenario ran."""


@dataclass(frozen=True)
class Scenario:
    id: str
    name: str
    max_steps: int
    task: Callable[[FixtureSite], str]
    check: Callable[[ScenarioContext], list[str]]
    """Failure reasons (empty: pass)."""
    online: bool = False
    unsupported: Callable[[Sequence[str]], str | None] | None = None
    """Why the scenario cannot run against this server, if it cannot."""


def answer_includes(result: AgentResult, needle: str) -> bool:
    return needle.lower() in (result.final_answer or "").lower()


PEAR_PRICE = re.compile(rf"\$(?:{WS})?2(?:\.00?)?(?![\d.,]*\d)", re.A)
""""$2" or "$2.00", but not "$20" or "$2.50"."""


def _check_read_page(ctx: ScenarioContext) -> list[str]:
    failures: list[str] = []
    if not answer_includes(ctx.result, "Hello Fixture"):
        failures.append('answer lacks "Hello Fixture"')
    if not PEAR_PRICE.search(ctx.result.final_answer or ""):
        failures.append('answer lacks the price "$2"')
    if not any(c.name == "browser_navigate" and not c.is_error for c in ctx.result.tool_calls):
        failures.append("browser_navigate was not used")
    return failures


_AGREE = re.compile(r"(^|&)agree=yes(&|$)")


def _check_form(ctx: ScenarioContext) -> list[str]:
    posts = [r for r in ctx.requests if r.method == "POST" and r.url.startswith("/echo")]
    if not posts:
        return ["the fixture site received no POST /echo (form was not submitted)"]
    if any("email=e2e%40example.com" in r.body and _AGREE.search(r.body) for r in posts):
        return []
    bodies = " | ".join(js_json(p.body) for p in posts)
    return [f"POST /echo body did not contain email=e2e%40example.com and agree=yes: {bodies}"]


def _typing_unsupported(tools: Sequence[str]) -> str | None:
    if any(t in tools for t in TYPING_TOOLS):
        return None
    return f"the server offers no tool that can enter text ({', '.join(TYPING_TOOLS)})"


SCENARIOS: list[Scenario] = [
    Scenario(
        id="a",
        name="read page",
        max_steps=10,
        task=lambda fx: (
            f"Open {fx.base_url}/index.html and tell me the exact text of the h1 heading and the price of Pear."
        ),
        check=_check_read_page,
    ),
    Scenario(
        id="b",
        name="fill and submit form",
        max_steps=15,
        task=lambda fx: (
            f'Go to {fx.base_url}/form.html, fill the email field with e2e@example.com, check the "I agree" checkbox '
            "and submit the form."
        ),
        unsupported=_typing_unsupported,
        check=_check_form,
    ),
    Scenario(
        id="c",
        name="JS-rendered site (online)",
        online=True,
        max_steps=12,
        task=lambda _fx: "Open https://quotes.toscrape.com/js/ and tell me who wrote the first quote.",
        check=lambda ctx: [] if answer_includes(ctx.result, "Albert Einstein") else ['answer lacks "Albert Einstein"'],
    ),
]


@dataclass
class RunRecord:
    scenario: str
    name: str
    run: int
    status: str
    """"pass" or "fail"."""
    steps: int
    tool_calls: int
    duration_ms: int
    failures: list[str]
    tools: list[str]
    answer: str | None
    started_at: str
    result: AgentResult | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "scenario": self.scenario,
            "name": self.name,
            "run": self.run,
            "status": self.status,
            "steps": self.steps,
            "toolCalls": self.tool_calls,
            "durationMs": self.duration_ms,
            "failures": self.failures,
            "tools": self.tools,
            "answer": self.answer,
            "startedAt": self.started_at,
        }
        if self.result is not None:
            out["result"] = self.result.to_json()
        return out


@dataclass
class ActivityCheck:
    failures: list[str] = field(default_factory=list)
    verified: int = 0
    logged: int = 0

    def to_json(self) -> dict[str, Any]:
        return {"failures": self.failures, "verified": self.verified, "logged": self.logged}


def _get(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else None


def verify_activity(state: Any, runs: Sequence[RunRecord]) -> ActivityCheck:
    """(d) Match the agent's tool calls against a GET /api/state body: the server's activity feed
    (and log tap) must contain every tool call the agent made."""
    history = _get(state, "history")
    # Only the agent's own session: the preflight client ("lmstudio-e2e-preflight") opens the same
    # fixture page just before scenario a and must not stand in for a call the agent made.
    activity = [
        a
        for a in (_get(history, "activity") or [])
        if isinstance(_get(a, "client"), str)
        and (a["client"] == CLIENT_NAME or a["client"].startswith(f"{CLIENT_NAME} "))
    ]
    logs = _get(history, "logs") or []
    oldest_log = parse_iso_ms(_get(logs[0], "time")) if logs else math.inf
    used: set[Any] = set()
    check = ActivityCheck()

    for run in runs:
        since = parse_iso_ms(run.started_at)
        for call in run.result.tool_calls if run.result else []:
            # Calls rejected by the SDK's input-schema validation never reach the tool runner, so they have no activity entry.
            if not call.executed or (call.is_error and "Input validation error" in call.result):
                continue
            match = next(
                (
                    a
                    for a in activity
                    if a.get("id") not in used
                    and a.get("tool") == call.name
                    and parse_iso_ms(a.get("startedAt")) >= since - 1_000
                    and (call.name != "browser_navigate" or _get(a.get("args"), "url") == _get(call.args, "url"))
                ),
                None,
            )
            if match is None:
                check.failures.append(
                    f"scenario {run.scenario} run {run.run}: {call.name} {js_json(call.args)} is missing from the "
                    "server activity feed"
                )
                continue
            used.add(match.get("id"))
            check.verified += 1
            expected = "error" if call.is_error else "ok"
            if match.get("status") != expected:
                saw = "an error" if call.is_error else "success"
                check.failures.append(
                    f'scenario {run.scenario} run {run.run}: {call.name} recorded as "{match.get("status")}" but the '
                    f"client saw {saw}"
                )
            if parse_iso_ms(match.get("startedAt")) >= oldest_log + 1_000:
                has_log = any(
                    _get(entry, "callId") == match.get("id")
                    and isinstance(_get(entry, "msg"), str)
                    and entry["msg"].startswith(f"tool call {call.name}")
                    for entry in logs
                )
                if has_log:
                    check.logged += 1
                else:
                    check.failures.append(
                        f'scenario {run.scenario} run {run.run}: no "tool call {call.name}" log record for call '
                        f"{match.get('id')}"
                    )
    if check.verified == 0 and not check.failures:
        check.failures.append("no tool calls to verify (run at least one other scenario)")
    return check
