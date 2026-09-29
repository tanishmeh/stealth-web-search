"""The e2e runner's checks."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sws_tools.lmstudio_agent.agent import AgentResult, ToolCallRecord, Usage
from sws_tools.lmstudio_e2e.scenarios import SCENARIOS, RunRecord, ScenarioContext, verify_activity


def _result(tool_calls: list[tuple[str, Any]], final_answer: str = "ok") -> AgentResult:
    return AgentResult(
        ok=True,
        stop_reason="final_answer",
        final_answer=final_answer,
        error=None,
        model="m",
        mcp_url="",
        steps=len(tool_calls),
        tool_calls=[
            ToolCallRecord(
                step=i + 1,
                id=str(i),
                name=name,
                args=args,
                is_error=False,
                executed=True,
                duration_ms=1,
                result="ok",
                images=0,
            )
            for i, (name, args) in enumerate(tool_calls)
        ],
        steps_detail=[],
        user_turns=[],
        waiting_runs=[],
        usage=Usage(),
        tools=[],
        started_at="",
        duration_ms=1,
        messages=[],
    )


def _run_record(started_at: str, r: AgentResult) -> RunRecord:
    return RunRecord(
        scenario="a",
        name="read page",
        run=1,
        status="pass",
        steps=1,
        tool_calls=len(r.tool_calls),
        duration_ms=1,
        failures=[],
        tools=[],
        answer=r.final_answer,
        started_at=started_at,
        result=r,
    )


def _iso(moment: datetime) -> str:
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


def test_the_preflight_navigate_does_not_count_as_the_agents_own_call() -> None:
    t0 = datetime(2026, 9, 17, 10, 0, 0, tzinfo=timezone.utc)
    url = "http://127.0.0.1:5000/index.html"
    activity: list[dict[str, Any]] = [
        {
            "id": "p1",
            "tool": "browser_navigate",
            "client": "lmstudio-e2e-preflight 1.0.0",
            "status": "ok",
            "args": {"url": url},
            "startedAt": _iso(t0 - timedelta(milliseconds=300)),
        }
    ]
    state = {"history": {"logs": [], "activity": activity}}
    run = _run_record(_iso(t0), _result([("browser_navigate", {"url": url})]))
    missing = verify_activity(state, [run])
    assert missing.verified == 0
    assert re.search(r"browser_navigate .* is missing from the server activity feed", "\n".join(missing.failures))

    activity.append(
        {
            "id": "a1",
            "tool": "browser_navigate",
            "client": "lmstudio-e2e 1.0.0",
            "status": "ok",
            "args": {"url": url},
            "startedAt": _iso(t0 + timedelta(seconds=20)),
        }
    )
    found = verify_activity(state, [run])
    assert found.failures == []
    assert found.verified == 1


def test_scenario_a_requires_the_exact_pear_price() -> None:
    a = next(s for s in SCENARIOS if s.id == "a")

    def check(answer: str) -> list[str]:
        return a.check(ScenarioContext(fx=None, requests=[], result=_result([("browser_navigate", {})], answer)))

    assert check('The heading is "Hello Fixture" and Pear costs $2.') == []
    assert check("Hello Fixture; Pear: $2.00") == []
    assert check("Hello Fixture; Pear costs $20") == ['answer lacks the price "$2"']
