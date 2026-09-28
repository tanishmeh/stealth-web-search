"""How each scenario judges a run, with a stand-in for the server's tools (no model, no network)."""

from __future__ import annotations

import asyncio
import io
import json
import re
from collections.abc import Callable
from typing import Any

import pytest

from sws_tools.agents_e2e import runner
from sws_tools.agents_e2e.js import UNDEFINED
from sws_tools.agents_e2e.runner import Options, run_scenarios, write_report
from sws_tools.agents_e2e.scenarios import SCENARIOS, ToolResult, check_find, norm, run_info

Handler = Callable[[dict[str, Any]], Any]

TABS = "1. [active] Example Domain — https://example.com/"
BOOKS = {
    "titles": ["A Light in the Attic", "Shakespeare's Sonnets", "Olio"],
    "prices": ["£51.77", "£20.66", "£23.88"],
}
QUOTES_LIFE = {
    "texts": ["\u201cIt is our choices, Harry...\u201d", "\u201cLife is what happens...\u201d", "x"],
    "authors": ["J.K. Rowling", "Allen Saunders", "y"],
}


class FakeServer:
    """Answers tool calls from handlers; records every call; keeps the host's tab list unless told otherwise."""

    def __init__(self, **handlers: Handler) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.tabs = [TABS]
        self.handlers: dict[str, Handler] = {
            "browser_navigate": lambda args: ToolResult("navigated"),
            "browser_tab_list": lambda args: ToolResult(self.tabs[0] if len(self.tabs) == 1 else self.tabs.pop(0)),
            **handlers,
        }

    async def __call__(self, name: str, args: dict[str, Any], timeout: float = 1500.0) -> ToolResult:
        self.calls.append((name, args))
        result = self.handlers[name](args)
        if asyncio.iscoroutine(result):
            result = await result
        assert isinstance(result, ToolResult)
        return result


def structured(**fields: Any) -> ToolResult:
    return ToolResult(text=json.dumps(fields), structured=fields)


def run_result(output: Any, run_id: str = "r0000001", kind: str = "run") -> ToolResult:
    return structured(run_id=run_id, kind=kind, status="completed", steps=4, duration_ms=12_250, output=output)


def extract(truth: dict[str, list[str]]) -> Handler:
    return lambda args: ToolResult(json.dumps(truth))


def test_norm_ignores_quotes_space_and_case() -> None:
    assert norm("  \u201cIt\u2019s\u00a0 A   Test\u201d ") == "its a test"
    assert norm(UNDEFINED) == norm(None) == ""
    assert norm(42) == "42"


def test_run_info_defaults() -> None:
    assert run_info(None) == {"runId": "?", "kind": "?", "status": "?", "steps": 0, "durationMs": 0}


@pytest.mark.anyio
async def test_run_passes_when_the_books_match() -> None:
    books = [
        {"title": f"\u201c{t.upper()}\u201d", "price": p} for t, p in zip(BOOKS["titles"], BOOKS["prices"], strict=True)
    ]
    server = FakeServer(browser_extract=extract(BOOKS), agent_run=lambda args: run_result(books))
    result = await SCENARIOS["run"](server)
    assert result.failures == []
    assert result.runs == [
        {"runId": "r0000001", "kind": "run", "status": "completed", "steps": 4, "durationMs": 12_250}
    ]
    _, args = next(c for c in server.calls if c[0] == "agent_run")
    assert (args["output_format"], args["wait_seconds"]) == ("json", 900)
    extract_args = next(a for n, a in server.calls if n == "browser_extract")
    assert extract_args == {
        "schema": {"titles[]": "article.product_pod h3 a@title", "prices[]": "article.product_pod .price_color"}
    }


@pytest.mark.anyio
async def test_run_reports_each_difference() -> None:
    books = [{"title": BOOKS["titles"][0], "price": "£1.00"}, {"price": BOOKS["prices"][1]}]
    server = FakeServer(browser_extract=extract(BOOKS), agent_run=lambda args: run_result(books))
    server.tabs = [TABS, "1. [active] Books — https://books.toscrape.com/\n2. other"]
    result = await SCENARIOS["run"](server)
    assert result.failures == [
        "expected 3 books, got 2",
        'book 1 price "£1.00" != "£51.77"',
        'book 2 title undefined != "Shakespeare\'s Sonnets"',
        "the host browser changed during the run:\n"
        f"      before: {TABS}\n"
        "      after:  1. [active] Books — https://books.toscrape.com/ | 2. other",
    ]

    failed = FakeServer(
        browser_extract=extract(BOOKS), agent_run=lambda args: ToolResult("model unreachable", None, True)
    )
    result = await SCENARIOS["run"](failed)
    assert result.failures == ["no JSON array output: model unreachable"]
    assert result.runs == [{"runId": "?", "kind": "?", "status": "?", "steps": 0, "durationMs": 0}]


@pytest.mark.anyio
async def test_ground_truth_errors_crash_the_scenario() -> None:
    server = FakeServer(browser_navigate=lambda args: ToolResult("net::ERR_NAME_NOT_RESOLVED", None, True))
    with pytest.raises(RuntimeError, match=r"^ground truth: net::ERR_NAME_NOT_RESOLVED$"):
        await SCENARIOS["run"](server)


def automate_result(**script: Any) -> ToolResult:
    base = {
        "name": "e2e-quotes-by-tag",
        "params": [{"name": "tag", "type": "string"}, {"name": "count", "type": "integer"}],
        "verification": {"status": "passed"},
    }
    return structured(run_id="r2", kind="automate", status="completed", steps=9, duration_ms=1000, script=base | script)


@pytest.mark.anyio
async def test_automate_replays_the_script_with_other_parameters() -> None:
    replay = [
        {"text": QUOTES_LIFE["texts"][0], "author": "j.k. rowling"},
        {"text": "Life is what happens...", "author": "Allen Saunders"},
    ]
    server = FakeServer(
        agent_automate=lambda args: automate_result(),
        script_run=lambda args: structured(output=replay),
        browser_extract=extract(QUOTES_LIFE),
    )
    result = await SCENARIOS["automate"](server)
    assert result.failures == []
    assert ("script_run", {"name": "e2e-quotes-by-tag", "params": {"tag": "life", "count": 2}}) in server.calls
    assert result.details["replay"] == replay
    assert result.details["script"]["verification"] == {"status": "passed"}


@pytest.mark.anyio
async def test_automate_stops_without_usable_parameters() -> None:
    server = FakeServer(
        agent_automate=lambda args: automate_result(
            params=[{"name": "tag", "type": "string"}], verification={"status": "failed", "error": "timeout"}
        )
    )
    result = await SCENARIOS["automate"](server)
    assert result.failures == [
        "verification failed: timeout",
        'no number parameter for the count: [{"name":"tag","type":"string"}]',
    ]
    assert "script_run" not in [name for name, _ in server.calls]

    no_script = FakeServer(agent_automate=lambda args: structured(run_id="r3", script=None))
    result = await SCENARIOS["automate"](no_script)
    assert result.failures[0].startswith("no script: ")
    assert result.details is UNDEFINED


def find_result(answer: str, *urls: str, verified: bool = True) -> ToolResult:
    sources = [
        {"n": i + 1, "url": u, "quotes": [{"text": "q", "verified": verified and i == 0}]} for i, u in enumerate(urls)
    ]
    return structured(
        run_id="r4", kind="find", status="completed", steps=5, duration_ms=500, answer=answer, sources=sources
    )


def test_check_find() -> None:
    good = find_result(
        "1991: Guido van Rossum released it.", "https://www.python.org/about", "https://en.wikipedia.org/wiki/Python"
    )
    assert check_find(good, re.compile("1991")) == []

    same_site = find_result("It was 1991.", "https://www.python.org/a", "https://python.org/b", verified=False)
    assert check_find(same_site, re.compile("1991")) == [
        "expected sources on at least 2 websites, got python.org",
        "no cited quote was verified on its page",
    ]

    bad = ToolResult(
        "agent failed", {"answer": "maybe 1989", "sources": [{"url": "ftp://x"}, {"title": "no url"}]}, True
    )
    assert check_find(bad, re.compile("1991")) == [
        "failed: agent failed",
        'answer does not match /1991/: "maybe 1989"',
        "no cited quote was verified on its page",
        "a source has no http(s) URL",
    ]
    assert (
        check_find(ToolResult("", None), re.compile("1991"))[1] == "expected sources on at least 2 websites, got none"
    )


def test_check_find_word_boundary_is_ascii() -> None:
    # /\bW\b/ in JavaScript: an accented letter next to W is not a word character
    pattern = re.compile(r"\bW\b", re.ASCII)
    urls = ("https://a.example/1", "https://b.example/2")
    assert check_find(find_result("Symbol: W (wolfram)", *urls), pattern) == []
    assert check_find(find_result("éW", *urls), pattern) == []
    assert check_find(find_result("Tungsten", *urls), pattern)[0].startswith("answer does not match /\\bW\\b/")


@pytest.mark.anyio
async def test_parallel_runs_both_agents_at_once() -> None:
    in_flight = 0
    peak = 0

    async def slow(result: ToolResult) -> ToolResult:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.05)
        in_flight -= 1
        return result

    runs = [
        {"id": "ra", "startedAt": "2026-09-28T10:00:00.000Z", "endedAt": "2026-09-28T10:01:00.000Z", "browserId": "b1"},
        {"id": "rb", "startedAt": "2026-09-28T10:00:30.000Z", "endedAt": "2026-09-28T10:02:00.000Z", "browserId": "b2"},
    ]
    server = FakeServer(
        agent_run=lambda args: slow(run_result("Albert Einstein", run_id="ra")),
        agent_find=lambda args: slow(find_result_with_id()),
        agent_status=lambda args: structured(runs=runs),
    )
    result = await SCENARIOS["parallel"](server)
    assert peak == 2, "the two agent calls were in flight together"
    assert result.failures == []
    assert result.details["a"] == "Albert Einstein"
    assert len(result.runs) == 2

    runs[1].update(startedAt="2026-09-28T10:05:00.000Z", browserId="b1")
    result = await SCENARIOS["parallel"](server)
    assert result.failures == [
        "the two runs did not overlap in time (they should run concurrently)",
        "the two runs shared a browser",
    ]


def find_result_with_id() -> ToolResult:
    result = find_result("W is the symbol.", "https://a.example/", "https://b.example/")
    assert isinstance(result.structured, dict)
    return ToolResult(result.text, {**result.structured, "run_id": "rb"})


@pytest.mark.anyio
async def test_parallel_cancels_the_other_call_when_one_fails() -> None:
    cancelled = asyncio.Event()

    async def hang(args: dict[str, Any]) -> ToolResult:
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.set()
            raise
        raise AssertionError("not cancelled")

    async def boom(args: dict[str, Any]) -> ToolResult:
        await asyncio.sleep(0.01)
        raise RuntimeError("connection lost")

    server = FakeServer(agent_run=hang, agent_find=boom)
    with pytest.raises(RuntimeError, match="connection lost"):
        await SCENARIOS["parallel"](server)
    assert cancelled.is_set()


@pytest.mark.anyio
async def test_the_runner_prints_and_reports_outcomes(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner, "use_color", lambda stream: False)
    good = find_result("Python first appeared in 1991.", "https://a.example/", "https://b.example/")

    class TaskGroupError(Exception):
        """Like the ExceptionGroup an anyio task group raises (the builtin needs Python 3.11)."""

        def __init__(self, *errors: Exception) -> None:
            super().__init__("unhandled errors in a TaskGroup")
            self.exceptions = errors

    async def crash(args: dict[str, Any]) -> ToolResult:
        raise TaskGroupError(ConnectionError("server went away"))

    server = FakeServer(agent_find=lambda args: good)
    out = io.StringIO()
    options = Options(only=["find"], repeat=2, mcp_url="http://127.0.0.1:1/mcp", json_file=None)
    outcomes = await run_scenarios(server, options, out)
    assert [o.passed for o in outcomes] == [True, True]
    lines = out.getvalue().splitlines()
    assert re.fullmatch(r"\[find\] #1 … PASS \(\d+\.\d s\) r4 find completed 5 steps 0\.5 s", lines[0])
    assert lines[1].startswith("[find] #2 … PASS")

    server.handlers["agent_find"] = crash
    out = io.StringIO()
    crashed = await run_scenarios(server, Options(["find"], 1, "u", None), out)
    assert crashed[0].failures == ["crashed: server went away"]
    assert re.fullmatch(r"\[find\] … FAIL \(\d+\.\d s\) \n    - crashed: server went away\n", out.getvalue())

    report = tmp_path / "results.json"
    write_report(report, "http://127.0.0.1:1/mcp", [*outcomes, *crashed])
    data = json.loads(report.read_text())
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", data["at"])
    assert data["mcpUrl"] == "http://127.0.0.1:1/mcp"
    first, _, last = data["outcomes"]
    assert list(first) == ["scenario", "attempt", "pass", "failures", "durationMs", "runs", "details"]
    assert first["runs"] == [{"runId": "r4", "kind": "find", "status": "completed", "steps": 5, "durationMs": 500}]
    assert "details" not in last, "a crashed scenario has no details (undefined in the TypeScript runner)"
    assert report.read_text().endswith("}\n")
