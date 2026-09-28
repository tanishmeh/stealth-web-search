"""The live sub-agent scenarios and how each one is judged.

Each scenario hands a job to a sub-agent through MCP, exactly like a host agent would, and judges
the result against ground truth it reads itself with the regular browser tools. The sites are
public practice sites made for scraping, so the ground truth is stable:

  run       agent_run: first 3 books of a books.toscrape.com category as JSON
  automate  agent_automate: a "quotes by tag" script, then script_run with other parameters
  find      agent_find: a fact confirmed on at least two websites, with cited links
  parallel  agent_run and agent_find at the same time (separate browsers)

Every scenario also checks that the host's own browser was not touched.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import re
import time
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol
from urllib.parse import urlsplit

from .js import JS_SPACES, UNDEFINED, at, coalesce, get, js_string, nullish, stringify, trim, truthy


@dataclass(frozen=True)
class ToolResult:
    """A tool call's text content (joined by newlines), structuredContent and isError."""

    text: str
    structured: Any = None
    is_error: bool = False


class Call(Protocol):
    """Call a tool on the server (timeout in seconds)."""

    def __call__(self, name: str, args: dict[str, Any], timeout: float = ...) -> Awaitable[ToolResult]: ...


RunInfo = dict[str, Any]


@dataclass
class ScenarioResult:
    failures: list[str]
    runs: list[RunInfo]
    details: Any = UNDEFINED  # left out of the JSON results when UNDEFINED


Scenario = Callable[[Call], Coroutine[Any, Any, ScenarioResult]]

_QUOTE_CHARS = re.compile("[\u201c\u201d\u2018\u2019\"']")


def norm(value: Any) -> str:
    """Compare text loosely: no quotation marks, collapsed whitespace, lower case."""
    return trim(JS_SPACES.sub(" ", _QUOTE_CHARS.sub("", js_string(coalesce(value, ""))))).lower()


async def ground_truth(call: Call, url: str, schema: dict[str, str]) -> Any:
    nav = await call("browser_navigate", {"url": url})
    if nav.is_error:
        raise RuntimeError(f"ground truth: {nav.text}")
    res = await call("browser_extract", {"schema": schema})
    if res.is_error:
        raise RuntimeError(f"ground truth: {res.text}")
    return json.loads(res.text)


async def host_tabs(call: Call) -> str:
    """The shared browser's tab list, to check that sub-agents never touch it."""
    return (await call("browser_tab_list", {})).text


async def main_browser_untouched(call: Call, before: str) -> list[str]:
    after = await host_tabs(call)
    if after == before:
        return []
    return [
        "the host browser changed during the run:\n"
        f"      before: {before.replace(chr(10), ' | ')}\n"
        f"      after:  {after.replace(chr(10), ' | ')}"
    ]


def run_info(structured: Any) -> RunInfo:
    return {
        "runId": coalesce(get(structured, "run_id"), "?"),
        "kind": coalesce(get(structured, "kind"), "?"),
        "status": coalesce(get(structured, "status"), "?"),
        "steps": coalesce(get(structured, "steps"), 0),
        "durationMs": coalesce(get(structured, "duration_ms"), 0),
    }


def _site(url: Any) -> Any:
    """new URL(url).hostname without "www.", or the URL itself when it does not parse."""
    try:
        parts = urlsplit(js_string(url))
        host = parts.hostname
    except ValueError:
        return url
    if not parts.scheme or not host:
        return url
    with contextlib.suppress(UnicodeError):
        host = host.encode("idna").decode("ascii")  # WHATWG URLs give IDN host names in punycode
    return re.sub(r"^www\.", "", host)


def check_find(res: ToolResult, answer: re.Pattern[str]) -> list[str]:
    failures: list[str] = []
    s = coalesce(res.structured, {})
    if res.is_error:
        failures.append(f"failed: {res.text[:500]}")
    got = js_string(coalesce(get(s, "answer"), ""))
    if not answer.search(got):
        failures.append(f"answer does not match /{answer.pattern}/: {stringify(got[:300])}")
    sources = coalesce(get(s, "sources"), [])
    sources = sources if isinstance(sources, list) else []
    sites = dict.fromkeys(_site(get(src, "url")) for src in sources)
    if len(sites) < 2:
        names = ", ".join("" if nullish(site) else js_string(site) for site in sites)
        failures.append(f"expected sources on at least 2 websites, got {names or 'none'}")
    if not any(truthy(get(q, "verified")) for src in sources for q in _as_list(coalesce(get(src, "quotes"), []))):
        failures.append("no cited quote was verified on its page")
    if not all(re.match(r"https?://", js_string(get(src, "url"))) for src in sources):
        failures.append("a source has no http(s) URL")
    return failures


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _parse_time(value: Any) -> float:
    """Date.parse for the server's ISO timestamps (NaN when missing or malformed)."""
    if not isinstance(value, str):
        return math.nan
    try:
        # Python 3.10's fromisoformat does not take the "Z" suffix
        return datetime.fromisoformat(re.sub(r"Z$", "+00:00", value)).timestamp()
    except ValueError:
        return math.nan


def _min(a: float, b: float) -> float:
    """Math.min: NaN when either is NaN (Python's min depends on the argument order)."""
    return math.nan if math.isnan(a) or math.isnan(b) else min(a, b)


def _max(a: float, b: float) -> float:
    return math.nan if math.isnan(a) or math.isnan(b) else max(a, b)


async def scenario_run(call: Call) -> ScenarioResult:
    category = "https://books.toscrape.com/catalogue/category/books/poetry_23/index.html"
    truth = await ground_truth(
        call, category, {"titles[]": "article.product_pod h3 a@title", "prices[]": "article.product_pod .price_color"}
    )
    await call("browser_navigate", {"url": "https://example.com/"})
    before = await host_tabs(call)
    res = await call(
        "agent_run",
        {
            "task": 'On https://books.toscrape.com, open the "Poetry" category (from the category list on the left) and read the first 3 books listed there.',
            "output": 'A JSON array of 3 objects {title, price}: the full book title (the link title attribute, not the shortened text) and the price exactly as shown, e.g. "£51.77".',
            "output_format": "json",
            "wait_seconds": 900,
        },
    )
    failures: list[str] = []
    out = get(res.structured, "output")
    if res.is_error or not isinstance(out, list):
        failures.append(f"no JSON array output: {res.text[:400]}")
    else:
        if len(out) != 3:
            failures.append(f"expected 3 books, got {len(out)}")
        titles, prices = get(truth, "titles"), get(truth, "prices")
        for i, book in enumerate(out[:3]):
            title, price = get(book, "title"), get(book, "price")
            if norm(title) != norm(at(titles, i)):
                failures.append(f"book {i + 1} title {stringify(title)} != {stringify(at(titles, i))}")
            if norm(price) != norm(at(prices, i)):
                failures.append(f"book {i + 1} price {stringify(price)} != {stringify(at(prices, i))}")
    failures += await main_browser_untouched(call, before)
    return ScenarioResult(failures, [run_info(res.structured)], {"output": out, "truth": truth})


async def scenario_automate(call: Call) -> ScenarioResult:
    await call("browser_navigate", {"url": "https://example.com/"})
    before = await host_tabs(call)
    res = await call(
        "agent_automate",
        {
            "task": 'On https://quotes.toscrape.com, get the first 3 quotes for the tag "love" (tag pages are at /tag/<tag>/): the quote text and its author.',
            "output": "A JSON array of {text, author} objects in page order; text without the surrounding quotation marks.",
            "parameters": "the tag, and how many quotes to return",
            "script_name": "e2e-quotes-by-tag",
            "overwrite": True,
            "wait_seconds": 1200,
        },
    )
    failures: list[str] = []
    script = get(res.structured, "script")
    if res.is_error or not truthy(script):
        failures.append(f"no script: {res.text[:600]}")
        return ScenarioResult(failures, [run_info(res.structured)])
    verification = get(script, "verification")
    if get(verification, "status") != "passed":
        status, error = get(verification, "status"), coalesce(get(verification, "error"), "")
        failures.append(f"verification {js_string(status)}: {js_string(error)}")
    params = _as_list(coalesce(get(script, "params"), []))
    tag_param = next((p for p in params if get(p, "type") == "string"), UNDEFINED)
    count_param = next((p for p in params if get(p, "type") in ("integer", "number")), UNDEFINED)
    if not truthy(tag_param):
        failures.append(f"no string parameter for the tag: {stringify(params)}")
    if not truthy(count_param):
        failures.append(f"no number parameter for the count: {stringify(params)}")
    if failures:
        return ScenarioResult(failures, [run_info(res.structured)], {"script": script})

    failures += await main_browser_untouched(call, before)
    # replay with new parameters, no model involved
    replay = await call(
        "script_run",
        {
            "name": get(script, "name"),
            "params": {js_string(get(tag_param, "name")): "life", js_string(get(count_param, "name")): 2},
        },
    )
    truth = await ground_truth(
        call, "https://quotes.toscrape.com/tag/life/", {"texts[]": ".quote .text", "authors[]": ".quote .author"}
    )
    out = get(replay.structured, "output")
    if replay.is_error or not isinstance(out, list):
        failures.append(f"script_run failed: {replay.text[:600]}")
    else:
        if len(out) != 2:
            failures.append(f"script_run returned {len(out)} quotes, expected 2")
        texts, authors = get(truth, "texts"), get(truth, "authors")
        for i, quote in enumerate(out[:2]):
            if norm(get(quote, "author")) != norm(at(authors, i)):
                failures.append(
                    f"quote {i + 1} author {stringify(get(quote, 'author'))} != {stringify(at(authors, i))}"
                )
            if norm(get(quote, "text")) != norm(at(texts, i)):
                failures.append(f"quote {i + 1} text differs: {stringify(js_string(get(quote, 'text'))[:80])}")
    details = {
        "script": {"name": get(script, "name"), "params": params, "verification": verification},
        "replay": out,
    }
    return ScenarioResult(failures, [run_info(res.structured)], details)


async def scenario_find(call: Call) -> ScenarioResult:
    await call("browser_navigate", {"url": "https://example.com/"})
    before = await host_tabs(call)
    res = await call(
        "agent_find",
        {
            "objective": "In which year was the Python programming language first released?",
            "output": "The year, with one sentence of context.",
            "wait_seconds": 900,
        },
    )
    failures = check_find(res, re.compile("1991"))
    failures += await main_browser_untouched(call, before)
    details = {"answer": get(res.structured, "answer"), "sources": get(res.structured, "sources")}
    return ScenarioResult(failures, [run_info(res.structured)], details)


async def _both(first: Awaitable[ToolResult], second: Awaitable[ToolResult]) -> tuple[ToolResult, ToolResult]:
    """Promise.all for two calls; when one fails, the other is cancelled instead of left running."""
    tasks = [asyncio.ensure_future(first), asyncio.ensure_future(second)]
    try:
        a, b = await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    return a, b


async def scenario_parallel(call: Call) -> ScenarioResult:
    await call("browser_navigate", {"url": "https://example.com/"})
    before = await host_tabs(call)
    started = time.monotonic()
    a, b = await _both(
        call(
            "agent_run",
            {
                "task": "Open https://quotes.toscrape.com/ and read the author of the first quote on the page.",
                "output": "Only the author name.",
                "wait_seconds": 900,
            },
        ),
        call(
            "agent_find",
            {
                "objective": "What is the chemical symbol of the element tungsten?",
                "output": "The symbol only, then one sentence of context.",
                "wait_seconds": 900,
            },
        ),
    )
    failures: list[str] = []
    a_output = get(a.structured, "output")
    if not re.search("einstein", js_string(coalesce(a_output, "")), re.IGNORECASE):
        failures.append(f"agent_run: expected Albert Einstein, got {stringify(coalesce(a_output, a.text[:300]))}")
    failures += [f"agent_find: {f}" for f in check_find(b, re.compile(r"\bW\b", re.ASCII))]
    a_id, b_id = get(a.structured, "run_id"), get(b.structured, "run_id")
    if truthy(a_id) and truthy(b_id):
        status = await call("agent_status", {})
        runs = _as_list(coalesce(get(status.structured, "runs"), []))
        ra = next((r for r in runs if get(r, "id") == a_id), UNDEFINED)
        rb = next((r for r in runs if get(r, "id") == b_id), UNDEFINED)
        if truthy(ra) and truthy(rb):
            overlap = _min(_parse_time(get(ra, "endedAt")), _parse_time(get(rb, "endedAt"))) - _max(
                _parse_time(get(ra, "startedAt")), _parse_time(get(rb, "startedAt"))
            )
            if not overlap > 0:
                failures.append("the two runs did not overlap in time (they should run concurrently)")
            if get(ra, "browserId") == get(rb, "browserId"):
                failures.append("the two runs shared a browser")
    failures += await main_browser_untouched(call, before)
    details = {
        "wallMs": round((time.monotonic() - started) * 1000),
        "a": a_output,
        "b": get(b.structured, "answer"),
    }
    return ScenarioResult(failures, [run_info(a.structured), run_info(b.structured)], details)


SCENARIOS: dict[str, Scenario] = {
    "run": scenario_run,
    "automate": scenario_automate,
    "find": scenario_find,
    "parallel": scenario_parallel,
}


@dataclass
class Outcome:
    scenario: str
    attempt: int
    passed: bool
    failures: list[str]
    duration_ms: int
    runs: list[RunInfo] = field(default_factory=list)
    details: Any = UNDEFINED

    def to_json(self) -> dict[str, Any]:
        """The shape of the --json results (the keys the TypeScript runner wrote)."""
        data: dict[str, Any] = {
            "scenario": self.scenario,
            "attempt": self.attempt,
            "pass": self.passed,
            "failures": self.failures,
            "durationMs": self.duration_ms,
            "runs": self.runs,
        }
        if self.details is not UNDEFINED:
            data["details"] = self.details
        return data
