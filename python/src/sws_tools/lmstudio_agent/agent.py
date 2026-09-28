"""The agent loop: a local LLM served by LM Studio drives the Stealth Web Search server.

This process is the MCP client (Streamable HTTP) and talks to LM Studio's OpenAI-compatible
/v1/chat/completions endpoint with function tools, so it needs no LM Studio mcp.json entry, API
token or plugin settings. Every tool call still goes through the server, so it shows up in the
server logs and on the live dashboard.

With an `ask` callback the run is interactive: when the model ends its turn while a sub-agent run
it started waits for an answer (a purchase the task did not approve), the waiting question is
printed, the user is asked, and the reply goes back to the model as a user message.

In both modes, a final answer given while a sub-agent run it started is still queued or running is
not taken at once: the model is told to wait for that run with agent_wait (at most twice per run
of the agent, with a step left and agent_wait among its tools), so it answers with the run's result
or question.
"""

from __future__ import annotations

import contextlib
import functools
import math
import re
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

import anyio
import anyio.abc
import httpx2
from mcp.shared.exceptions import MCPError
from mcp.types import CallToolResult

from ._js import js_json, js_len, js_round, js_slice, js_string, js_trim, js_truthy
from .abort import abortable, sleep
from .conversation import (
    CHARS_PER_TOKEN,
    TEXT_TOOL_CALL,
    ChatMessage,
    build_system_prompt,
    compact_history,
    format_tool_result,
    parse_tool_arguments,
    redact_images,
    split_thinking,
)
from .errors import AgentError, HttpStatusError
from .lmstudio import BodyEncoder, Completion, resolve_model, stream_chat_completion, strip_slashes
from .mcp_client import (
    CONNECTION_CLOSED,
    AbortError,
    McpConnection,
    connect_mcp,
    describe_error,
    error_result,
    select_tools,
    to_openai_tool,
)
from .options import DEFAULT_LMSTUDIO_URL, DEFAULT_MCP_URL, REASONING_MODES, AgentOptions
from .output import Printer, clip_line, preview, seconds

__all__ = [
    "DEFAULT_LMSTUDIO_URL",
    "DEFAULT_MCP_URL",
    "REASONING_MODES",
    "AgentOptions",
    "AgentResult",
    "run_agent",
]

MODEL_IDLE_TIMEOUT_S = 600.0

StopReason = Literal["final_answer", "max_steps", "error", "aborted"]


@dataclass
class ToolCallRecord:
    step: int
    id: str
    name: str
    args: Any
    is_error: bool
    executed: bool
    """False when the call never reached the server (unknown tool, invalid JSON arguments)."""
    duration_ms: int
    result: str
    """Text given to the model (after truncation)."""
    images: int

    def to_json(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "id": self.id,
            "name": self.name,
            "args": self.args,
            "isError": self.is_error,
            "executed": self.executed,
            "durationMs": self.duration_ms,
            "result": self.result,
            "images": self.images,
        }


@dataclass
class StepRecord:
    step: float
    llm_ms: int
    finish_reason: Any
    prompt_tokens: Any
    completion_tokens: Any
    reasoning_tokens: Any
    reasoning: str | None
    content: str | None
    tool_calls: list[str]

    def to_json(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "llmMs": self.llm_ms,
            "finishReason": self.finish_reason,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "reasoningTokens": self.reasoning_tokens,
            "reasoning": self.reasoning,
            "content": self.content,
            "toolCalls": self.tool_calls,
        }


@dataclass
class WaitingQuestion:
    """A question of a sub-agent run this agent started, waiting for an answer."""

    run_id: str
    question_id: str
    text: str
    reason: str | None
    origin: str | None
    expires_at: str | None

    def to_json(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "questionId": self.question_id,
            "text": self.text,
            "reason": self.reason,
            "origin": self.origin,
            "expiresAt": self.expires_at,
        }


@dataclass
class UnfinishedRun:
    """A sub-agent run this agent started that was still queued or running (not waiting, not done)."""

    run_id: str
    status: str

    def to_json(self) -> dict[str, Any]:
        return {"runId": self.run_id, "status": self.status}


@dataclass
class UserTurnRecord:
    """The model ended its turn while sub-agent runs waited, and the user was asked."""

    step: int
    question: str
    """What the model asked the user."""
    waiting: list[WaitingQuestion]
    reply: str | None
    """The user's reply; None when there was none (the run then ended)."""

    def to_json(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "question": self.question,
            "waiting": [w.to_json() for w in self.waiting],
            "reply": self.reply,
        }


@dataclass
class Usage:
    prompt_tokens: Any = 0
    completion_tokens: Any = 0
    reasoning_tokens: Any = 0

    def to_json(self) -> dict[str, Any]:
        return {
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "reasoningTokens": self.reasoning_tokens,
        }


@dataclass
class AgentResult:
    ok: bool
    stop_reason: StopReason
    final_answer: str | None
    error: str | None
    model: str
    mcp_url: str
    steps: int
    tool_calls: list[ToolCallRecord]
    steps_detail: list[StepRecord]
    user_turns: list[UserTurnRecord]
    """Questions put to the user during the run (interactive runs only)."""
    waiting_runs: list[WaitingQuestion]
    """Sub-agent runs this agent started that were still waiting for an answer when it stopped."""
    usage: Usage
    tools: list[str]
    started_at: str
    duration_ms: int
    messages: list[ChatMessage]
    unfinished_runs: list[UnfinishedRun] = field(default_factory=list)
    """Sub-agent runs this agent started that were still queued or running when it stopped."""

    def to_json(self) -> dict[str, Any]:
        """The transcript fields, with the keys of the TypeScript host (camelCase)."""
        return {
            "ok": self.ok,
            "stopReason": self.stop_reason,
            "finalAnswer": self.final_answer,
            "error": self.error,
            "model": self.model,
            "mcpUrl": self.mcp_url,
            "steps": self.steps,
            "toolCalls": [c.to_json() for c in self.tool_calls],
            "stepsDetail": [s.to_json() for s in self.steps_detail],
            "userTurns": [t.to_json() for t in self.user_turns],
            "waitingRuns": [w.to_json() for w in self.waiting_runs],
            "unfinishedRuns": [u.to_json() for u in self.unfinished_runs],
            "usage": self.usage.to_json(),
            "tools": self.tools,
            "startedAt": self.started_at,
            "durationMs": self.duration_ms,
            "messages": self.messages,
        }


RUN_STARTERS = frozenset({"agent_run", "agent_automate", "agent_find"})
"""Tools whose result starts a sub-agent run (its run_id)."""
RUN_FOLLOWERS = frozenset({"agent_reply", "agent_wait", "agent_status"})
"""Tools whose result reports a run's new status."""
RUN_DONE = frozenset({"completed", "failed", "cancelled"})
RUN_WORKING = frozenset({"queued", "running"})
MAX_RUN_NUDGES = 2
"""Final answers sent back per run of the agent because a sub-agent run it started was still working."""
_CONTEXT_ERROR = re.compile(r"context|too long|exceed", re.I | re.A)
_NEWLINES = re.compile(r"\n+")


def is_transient(exc: BaseException) -> bool:
    if isinstance(exc, AgentError) and exc.transient:
        return True
    return (
        isinstance(exc, HttpStatusError)
        and (exc.status >= 500 or exc.status == 429)
        and not _CONTEXT_ERROR.search(exc.message)
    )


def iso_time(ms: int) -> str:
    """Date.prototype.toISOString() for a time in ms since the epoch."""
    moment = datetime.fromtimestamp(ms // 1000, tz=timezone.utc)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{ms % 1000:03d}Z"


def parse_iso_ms(text: str | None) -> float:
    """Date.parse for the server's ISO timestamps; NaN when it is not one."""
    if not text:
        return math.nan
    try:
        moment = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text)
    except ValueError:
        return math.nan
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return moment.timestamp() * 1000


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def clock_ms() -> int:
    """A monotonic clock in whole milliseconds: durations are differences of two readings, as with
    Date.now() in the TypeScript host (so "0 ms" and "1 ms" come out as often as they did)."""
    return time.monotonic_ns() // 1_000_000


def _elapsed_ms(since: int) -> int:
    return clock_ms() - since


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def still_working_message(runs: list[UnfinishedRun]) -> str:
    """What the model is told when it answers while sub-agent runs it started are still working."""
    calls = [f'{{"run_id": "{r.run_id}"}}' for r in runs]
    if len(runs) == 1:
        return (
            f"Run {runs[0].run_id} you started is still working. Call agent_wait with {calls[0]} and wait for its "
            "result or its question before you answer."
        )
    return (
        f"Runs {', '.join(r.run_id for r in runs)} you started are still working. Call agent_wait for each of them "
        f"({', '.join(calls)}) and wait for its result or its question before you answer."
    )


def _add(total: Any, value: Any) -> Any:
    # `total += u?.x ?? 0`: only numbers add up
    return total + value if isinstance(value, (int, float)) and not isinstance(value, bool) else total


async def run_agent(options: AgentOptions) -> AgentResult:
    started = now_ms()
    started_clock = clock_ms()
    out = Printer(options.write, bool(options.quiet), options.color)
    mcp_url = options.mcp_url if options.mcp_url is not None else DEFAULT_MCP_URL
    lmstudio_url = strip_slashes(options.lmstudio_url if options.lmstudio_url is not None else DEFAULT_LMSTUDIO_URL)
    max_steps = options.max_steps if options.max_steps is not None else 25
    max_result_chars = options.max_result_chars if options.max_result_chars is not None else 12_000
    tool_timeout_ms = options.tool_timeout_ms if options.tool_timeout_ms is not None else 180_000
    client_name = options.client_name if options.client_name is not None else "lmstudio-agent"
    signal = options.signal
    messages: list[ChatMessage] = []
    tool_calls: list[ToolCallRecord] = []
    steps_detail: list[StepRecord] = []
    usage = Usage()
    user_turns: list[UserTurnRecord] = []
    still_waiting: list[WaitingQuestion] = []
    still_working: list[UnfinishedRun] = []
    started_runs: dict[str, str] = {}
    """Sub-agent runs this agent started, with their last known status."""
    tool_names: list[str] = []
    model_id = options.model if options.model is not None else "(unresolved)"

    def result(stop_reason: StopReason, final_answer: str | None, error: str | None) -> AgentResult:
        return AgentResult(
            ok=stop_reason == "final_answer",
            stop_reason=stop_reason,
            final_answer=final_answer,
            error=error,
            model=model_id,
            mcp_url=mcp_url,
            steps=len(steps_detail),
            tool_calls=tool_calls,
            steps_detail=steps_detail,
            user_turns=user_turns,
            waiting_runs=still_waiting,
            unfinished_runs=still_working,
            usage=usage,
            tools=tool_names,
            started_at=iso_time(started),
            duration_ms=_elapsed_ms(started_clock),
            messages=redact_images(messages),
        )

    def finalize(r: AgentResult) -> AgentResult:
        if r.error and r.stop_reason != "max_steps":
            # the result carries the error; an output that fails (the reason the run stopped, maybe)
            # must not turn it into an exception
            with contextlib.suppress(Exception):
                out.error(f"{out.style(['bold', 'red'], 'Error:')} {r.error}")
        return r

    http = httpx2.AsyncClient(trust_env=False, timeout=httpx2.Timeout(MODEL_IDLE_TIMEOUT_S))
    mcp: McpConnection | None = None
    connections: list[McpConnection] = []
    async with http, anyio.create_task_group() as tg:
        try:
            model = await resolve_model(http, lmstudio_url, options.lm_api_token, options.model)
            model_id = model.id
            vision = options.vision if options.vision is not None else model.vision
            reasoning = options.reasoning if options.reasoning is not None else "low"
            reasoning_effort: str | None = None
            if reasoning != "on" and (model.reasoning is not None or not model.listed):
                reasoning_effort = reasoning

            mcp = await connect_mcp(tg, mcp_url, options.auth_token, client_name)
            connections.append(mcp)
            all_tools = await mcp.list_tools()
            tools = select_tools(all_tools, options.tools, options.toolsets)
            tool_names = [t.name for t in tools]
            openai_tools = [to_openai_tool(t) for t in tools]
            known = set(tool_names)

            messages.append(
                {
                    "role": "system",
                    "content": build_system_prompt(
                        mcp.instructions,
                        vision,
                        options.instructions,
                        any(t.name == "agent_reply" for t in tools),
                        options.ask is not None,
                    ),
                }
            )
            messages.append({"role": "user", "content": options.task})

            if not model.listed:
                model_note = " (not in LM Studio's model list; check the id with `lms ls`)"
            elif model.loaded:
                model_note = ""
            else:
                model_note = " (not loaded yet: LM Studio loads it on the first request)"
            out.line(
                out.style("bold", "Stealth Web Search agent")
                + out.style(
                    "dim",
                    f" | model {model.id}{model_note} | reasoning {reasoning} | vision {'on' if vision else 'off'} "
                    f"| {len(tools)} tools | {mcp_url}",
                )
            )
            # Character budget for the conversation, so old results get shortened before the prompt overflows the loaded context.
            max_tokens = options.max_tokens if options.max_tokens is not None else 8192
            tool_chars = js_len(js_json(openai_tools))
            context_length = model.context_length
            history_budget = (
                math.floor((context_length - max_tokens) * CHARS_PER_TOKEN) - tool_chars
                if isinstance(context_length, (int, float)) and context_length
                else math.inf
            )
            if (
                isinstance(context_length, (int, float))
                and context_length
                and (context_length < 16_000 or history_budget < 20_000)
            ):
                out.line(
                    out.style(
                        "yellow",
                        f"Warning: the model is loaded with a {js_string(context_length)}-token context, which leaves "
                        f"little room next to {len(tools)} tool definitions and --max-tokens {js_string(max_tokens)}. "
                        "Reload it with a context of 32k or more, or use --toolsets core.",
                    )
                )
            out.line(f"{out.style('bold', 'Task:')} {options.task}")

            nudges = 0
            run_nudges = 0
            last_completion: Completion | None = None
            encoder = BodyEncoder()

            async def call_model(step: float, with_tools: bool) -> Completion:
                compact_history(messages, max(8_000, history_budget))
                body: dict[str, Any] = {
                    "model": model.id,
                    "messages": messages,
                    "temperature": options.temperature if options.temperature is not None else 0.2,
                    "max_tokens": max_tokens,
                }
                if with_tools:
                    body["tools"] = openai_tools
                    body["tool_choice"] = "auto"
                if reasoning_effort:
                    body["reasoning_effort"] = reasoning_effort
                out.line("")
                out.line(
                    out.style(["bold", "cyan"], f"[step {js_string(step)}]")
                    + out.style("dim", f" +{seconds(_elapsed_ms(started_clock))} waiting for the model...")
                )
                attempt = 1
                while True:
                    t0 = clock_ms()
                    printed_thinking = False

                    def on_reasoning(delta: str) -> None:
                        nonlocal printed_thinking
                        if not printed_thinking:
                            out.stream("  thinking: ")
                            printed_thinking = True
                        out.stream(_NEWLINES.sub(" ", delta))

                    try:
                        completion = await stream_chat_completion(
                            http,
                            lmstudio_url,
                            options.lm_api_token,
                            body,
                            on_reasoning,
                            signal,
                            MODEL_IDLE_TIMEOUT_S,
                            encoder,
                        )
                    except Exception as exc:
                        out.end_stream()
                        if signal is not None and signal.aborted:
                            raise
                        if attempt < 3 and is_transient(exc):
                            out.line(out.style("yellow", f"  model request failed ({_message(exc)}); retrying..."))
                            await sleep(2 * attempt, signal)
                            attempt += 1
                            continue
                        raise
                    out.end_stream()
                    split_reasoning, split_content = split_thinking(completion.content)
                    if split_reasoning:
                        completion.reasoning = "\n".join(p for p in (completion.reasoning, split_reasoning) if p)
                        if not printed_thinking:
                            out.line(out.style("dim", f"  thinking: {_NEWLINES.sub(' ', split_reasoning)}"))
                    completion.content = split_content
                    llm_ms = _elapsed_ms(t0)
                    u = completion.usage if isinstance(completion.usage, dict) else None
                    details = u.get("completion_tokens_details") if u else None
                    reasoning_tokens = details.get("reasoning_tokens") if isinstance(details, dict) else None
                    usage.prompt_tokens = _add(usage.prompt_tokens, u.get("prompt_tokens") if u else None)
                    usage.completion_tokens = _add(usage.completion_tokens, u.get("completion_tokens") if u else None)
                    usage.reasoning_tokens = _add(usage.reasoning_tokens, reasoning_tokens)
                    steps_detail.append(
                        StepRecord(
                            step=step,
                            llm_ms=llm_ms,
                            finish_reason=completion.finish_reason,
                            prompt_tokens=u.get("prompt_tokens") if u else None,
                            completion_tokens=u.get("completion_tokens") if u else None,
                            reasoning_tokens=reasoning_tokens,
                            reasoning=completion.reasoning or None,
                            content=completion.content or None,
                            tool_calls=[c["name"] for c in completion.tool_calls],
                        )
                    )
                    tokens = ""
                    if js_truthy(completion.usage):
                        prompt = u.get("prompt_tokens") if u else None
                        output = u.get("completion_tokens") if u else None
                        tokens = (
                            f" | {'?' if prompt is None else js_string(prompt)} prompt + "
                            f"{'?' if output is None else js_string(output)} output tokens"
                        )
                    out.line(out.style("dim", f"  model {seconds(llm_ms)}{tokens}"))
                    return completion

            async def call_tool(name: str, args: dict[str, Any]) -> CallToolResult:
                nonlocal mcp
                attempt = 1
                while True:
                    conn = mcp
                    assert conn is not None
                    try:
                        return await abortable(
                            signal,
                            functools.partial(conn.call_tool, name, args, tool_timeout_ms / 1000),
                            AbortError,
                        )
                    except Exception as exc:
                        message = _message(exc)
                        lost = isinstance(exc, MCPError) and exc.code == CONNECTION_CLOSED
                        if lost:
                            await conn.wait_closed(2.0)
                            if conn.transport_failed() and conn.error is not None:
                                message = describe_error(conn.error)
                        status = 404 if 404 in conn.statuses else None
                        network = status is None and (lost or isinstance(exc, (httpx2.TransportError, OSError)))
                        if attempt == 1 and (status == 404 or network):
                            out.line(out.style("yellow", f"  MCP connection lost ({message}); reconnecting..."))
                            await conn.close()
                            mcp = await connect_mcp(tg, mcp_url, options.auth_token, client_name)
                            connections.append(mcp)
                            attempt += 1
                            continue
                        if network:
                            raise AgentError(f"Lost the connection to the MCP server at {mcp_url}: {message}") from exc
                        return error_result(f"Error: {message}")

            def track_run(name: str, res: CallToolResult) -> None:
                """Remember the sub-agent runs this agent starts, and their status as later results report it."""
                s = res.structured_content
                run_id = s.get("run_id") if isinstance(s, dict) else None
                status = s.get("status") if isinstance(s, dict) else None
                if not isinstance(run_id, str) or not isinstance(status, str):
                    return
                if name in RUN_STARTERS or (name in RUN_FOLLOWERS and run_id in started_runs):
                    started_runs[run_id] = status

            async def check_runs() -> tuple[list[WaitingQuestion], list[UnfinishedRun]]:
                """The questions that sub-agent runs this agent started are waiting on, and the runs still queued
                or running (agent_status on each run not yet done). Best effort: a lost MCP connection does not
                replace the reason the agent stops, and a run whose status could not be read is in neither list."""
                waiting: list[WaitingQuestion] = []
                working: list[UnfinishedRun] = []
                for run_id, status in list(started_runs.items()):
                    if status in RUN_DONE:
                        continue
                    try:
                        res = await call_tool("agent_status", {"run_id": run_id})
                    except Exception:
                        res = CallToolResult(content=[], is_error=True)
                    s = res.structured_content
                    new_status = s.get("status") if isinstance(s, dict) else None
                    if res.is_error or not isinstance(new_status, str):
                        continue
                    assert isinstance(s, dict)
                    started_runs[run_id] = new_status
                    if new_status in RUN_WORKING:
                        working.append(UnfinishedRun(run_id=run_id, status=new_status))
                        continue
                    q = s.get("question")
                    question_id = q.get("id") if isinstance(q, dict) else None
                    if new_status != "waiting" or not isinstance(question_id, str):
                        continue
                    assert isinstance(q, dict)
                    waiting.append(
                        WaitingQuestion(
                            run_id=run_id,
                            question_id=question_id,
                            text=_str_or_none(q.get("text")) or "",
                            reason=_str_or_none(q.get("reason")),
                            origin=_str_or_none(q.get("origin")),
                            expires_at=_str_or_none(q.get("expires_at")),
                        )
                    )
                return waiting, working

            def report_waiting(waiting: list[WaitingQuestion]) -> None:
                """Tell the user which runs still wait: unanswered, each goes on without the step it asked about."""
                nonlocal still_waiting
                still_waiting = waiting
                for w in waiting:
                    left = parse_iso_ms(w.expires_at) - now_ms() if w.expires_at else math.nan
                    after = ""
                    if math.isfinite(left):
                        when = (
                            f"{js_round(left / 60_000)} min"
                            if left >= 60_000
                            else f"{max(1, math.ceil(left / 1000))} s"
                        )
                        after = f" (in about {when})"
                    nothing = ", so nothing is ordered" if w.reason == "confirm" else ""
                    out.line(
                        out.style(
                            "yellow",
                            f"Run {w.run_id} is still waiting for an answer to question {w.question_id}. Unanswered, "
                            f"it continues without it after its timeout{after} and does not take the step it asked "
                            f"about{nothing}.",
                        )
                    )

            def report_working(working: list[UnfinishedRun]) -> None:
                """Tell the user which runs are still working: the answer does not include their results."""
                nonlocal still_working
                still_working = working
                for w in working:
                    out.line(
                        out.style(
                            "yellow",
                            f"Run {w.run_id} is still {w.status}, so this answer does not include its result. It goes "
                            "on in the server, and the dashboard shows its result when it ends.",
                        )
                    )

            async def stop_without(stop_reason: StopReason, answer: str | None, error: str) -> AgentResult:
                """Stop without a final answer, saying which sub-agent runs this agent started still wait or work."""
                if started_runs:
                    waiting, working = await check_runs()
                    report_waiting(waiting)
                    report_working(working)
                return finalize(result(stop_reason, answer, error))

            step = 1
            while step <= max_steps:
                completion = await call_model(step, True)
                last_completion = completion

                if not completion.tool_calls:
                    content = js_trim(completion.content)
                    text_tool_call = bool(content) and TEXT_TOOL_CALL.search(content) is not None
                    problem: str | None
                    if not content:
                        problem = (
                            "Your response hit the output token limit before you called a tool or answered. Think less "
                            "and act: call the next tool, or give the final answer."
                            if completion.finish_reason == "length"
                            else "You neither called a tool nor gave an answer. Continue the task with a tool call, or "
                            "give your final answer."
                        )
                    elif text_tool_call:
                        problem = (
                            "Your last message described a tool call as text, so nothing was executed. Call tools "
                            "through the function-calling interface (one JSON arguments object per call), or give the "
                            "final answer as plain text."
                        )
                    else:
                        problem = None
                    if problem and nudges < 2:
                        nudges += 1
                        what = "tool call written as text" if content else "empty response"
                        out.line(out.style("yellow", f"  {what}; asking the model to continue"))
                        if content:
                            messages.append({"role": "assistant", "content": content})
                        messages.append({"role": "user", "content": problem})
                        step += 1
                        continue
                    if not content:
                        return await stop_without("error", None, "The model returned an empty response.")
                    if text_tool_call:
                        messages.append({"role": "assistant", "content": content})
                        return await stop_without(
                            "error",
                            None,
                            f"The model keeps writing tool calls as text instead of calling tools (last reply: "
                            f"{js_slice(content, 0, 200)}). Use a model trained for tool use, or try --reasoning none / "
                            "--toolsets core.",
                        )
                    messages.append({"role": "assistant", "content": content})
                    waiting, working = await check_runs() if started_runs else ([], [])

                    def show(text: str) -> None:
                        if options.quiet:
                            out.always(text)
                        else:
                            out.line(text)

                    asked = False
                    if waiting and options.ask is not None and step < max_steps:
                        # the model ended its turn to ask the user (a purchase to approve): ask, and hand the reply back to it
                        out.line("")
                        runs_wait = (
                            "a sub-agent run waits" if len(waiting) == 1 else f"{len(waiting)} sub-agent runs wait"
                        )
                        show(
                            out.style(["bold", "yellow"], "Question for you")
                            + out.style("dim", f" ({runs_wait} for your answer)")
                        )
                        show(content)
                        for w in waiting:
                            where = f" on {w.origin}" if w.origin else ""
                            show(out.style("dim", f"  run {w.run_id} asks{where}: {clip_line(w.text, 300)}"))
                        answer = await options.ask("Your answer (Enter to leave it unanswered): ")
                        reply = js_trim(answer) if answer is not None else ""
                        if signal is not None and signal.aborted:
                            raise AgentError("aborted")
                        user_turns.append(
                            UserTurnRecord(step=step, question=content, waiting=waiting, reply=reply or None)
                        )
                        if reply:
                            messages.append({"role": "user", "content": reply})
                            step += 1
                            continue
                        asked = True
                    elif working and "agent_wait" in known and run_nudges < MAX_RUN_NUDGES and step < max_steps:
                        # an answer given while a run it started still works would lack that run's result or question
                        # (only when the model can wait for it: --tools/--toolsets may leave agent_wait out)
                        run_nudges += 1
                        for unfinished in working:
                            out.line(
                                out.style(
                                    "yellow",
                                    f"  run {unfinished.run_id} is still {unfinished.status}; "
                                    "asking the model to wait for it",
                                )
                            )
                        messages.append({"role": "user", "content": still_working_message(working)})
                        step += 1
                        continue
                    out.line("")
                    summary = f"{len(steps_detail)} steps, {len(tool_calls)} tool calls, {seconds(_elapsed_ms(started_clock))}"
                    if asked:
                        # the question above stays the final answer; it was just printed
                        out.line(
                            out.style(["bold", "yellow"], "No answer; stopping") + out.style("dim", f" ({summary})")
                        )
                    else:
                        out.line(out.style(["bold", "green"], "Final answer") + out.style("dim", f" ({summary})"))
                        show(content)
                    if waiting and options.ask is not None and step >= max_steps:
                        out.line(
                            out.style(
                                "yellow",
                                f"No steps left to ask you and pass on your answer (--max-steps {js_string(max_steps)}).",
                            )
                        )
                    report_waiting(waiting)
                    report_working(working)
                    return finalize(result("final_answer", content, None))

                if js_trim(completion.content):
                    out.line(f"  {_NEWLINES.sub(chr(10) + '  ', js_trim(completion.content))}")
                assistant_calls: list[dict[str, Any]] = [
                    {
                        "id": c["id"] or f"call_{js_string(step)}_{i}",
                        "type": "function",
                        "function": {"name": c["name"], "arguments": c["arguments"] or "{}"},
                    }
                    for i, c in enumerate(completion.tool_calls)
                ]
                messages.append(
                    {"role": "assistant", "content": completion.content or "", "tool_calls": assistant_calls}
                )

                pending_images: list[dict[str, str]] = []
                for call in assistant_calls:
                    t0 = clock_ms()
                    fn = call["function"]
                    parsed = parse_tool_arguments(fn["arguments"])
                    is_error = True
                    images: list[dict[str, str]] = []
                    args: Any = fn["arguments"]
                    executed = False
                    shown_args = js_json(parsed.value) if parsed.ok else fn["arguments"]
                    out.line(
                        f"  {out.style('magenta', '->')} {out.style('bold', fn['name'])} {out.style('dim', shown_args)}"
                    )
                    if fn["name"] not in known:
                        text = f'Error: unknown tool "{fn["name"]}". Available tools: {", ".join(tool_names)}.'
                    elif not parsed.ok:
                        text = (
                            f"Error: the arguments for {fn['name']} are not valid JSON ({parsed.error}). Call the tool "
                            "again with a single JSON object that matches its schema."
                        )
                    else:
                        args = parsed.value
                        executed = True
                        res = await call_tool(fn["name"], parsed.value)
                        track_run(fn["name"], res)
                        formatted = format_tool_result(res, max_result_chars, vision)
                        text = formatted.text
                        images = formatted.images
                        is_error = bool(res.is_error)
                    duration_ms = _elapsed_ms(t0)
                    tool_calls.append(
                        ToolCallRecord(
                            step=step,
                            id=call["id"],
                            name=fn["name"],
                            args=args,
                            is_error=is_error,
                            executed=executed,
                            duration_ms=duration_ms,
                            result=text,
                            images=len(images),
                        )
                    )
                    status_text = out.style("red", "error") if is_error else out.style("green", "ok")
                    image_note = out.style("dim", f" | {len(images)} image(s)") if images else ""
                    out.line(
                        f"  {out.style('magenta', '<-')} {status_text} {out.style('dim', seconds(duration_ms))}{image_note}"
                    )
                    for line in preview(text):
                        out.line(out.style("dim", f"     {line}"))
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
                    pending_images.extend({"tool": fn["name"], **img} for img in images)
                if pending_images:
                    sources = ", ".join(dict.fromkeys(img["tool"] for img in pending_images))
                    messages.append(
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": f"Image output from {sources}:"},
                                *(
                                    {
                                        "type": "image_url",
                                        "image_url": {"url": f"data:{img['mimeType']};base64,{img['data']}"},
                                    }
                                    for img in pending_images
                                ),
                            ],
                        }
                    )
                step += 1

            # Step budget exhausted: ask for a best-effort answer without tools.
            out.line("")
            out.line(
                out.style(
                    "yellow",
                    f"Reached the step limit ({js_string(max_steps)}); asking for a final answer without tools.",
                )
            )
            messages.append(
                {
                    "role": "user",
                    "content": "You have used all available steps. Do not call tools. Give your best final answer now, "
                    "based only on what you found, and say what is missing.",
                }
            )
            summary_text: str | None
            try:
                final = await call_model(max_steps + 1, False)
                summary_text = js_trim(final.content) or None
            except Exception:
                summary_text = (js_trim(last_completion.content) if last_completion else "") or None
            if summary_text:
                out.line(out.style(["bold", "yellow"], "Best-effort answer (step limit reached)"))
                if options.quiet:
                    out.always(summary_text)
                else:
                    out.line(summary_text)
                messages.append({"role": "assistant", "content": summary_text})
            return await stop_without(
                "max_steps", summary_text, f"Stopped after {js_string(max_steps)} steps without a final answer."
            )
        except Exception as exc:
            aborted = signal is not None and signal.aborted
            message = exc.message if isinstance(exc, AgentError) else "".join(traceback.format_exception(exc)).rstrip()
            return finalize(result("aborted" if aborted else "error", None, "Aborted." if aborted else message))
        finally:
            if mcp is not None:
                await mcp.close()
            if any(not c.closed for c in connections):
                tg.cancel_scope.cancel()  # a session that did not close in time
    raise AssertionError("unreachable: every path above returns")


def _message(exc: BaseException) -> str:
    if isinstance(exc, AgentError):
        return exc.message
    return describe_error(exc)
