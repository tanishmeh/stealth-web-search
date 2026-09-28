"""The conversation with the model: system prompt, tool arguments and results, and keeping the
history within the model's context."""

from __future__ import annotations

import math
import re
from collections.abc import MutableSequence
from dataclasses import dataclass, field
from typing import Any

from mcp.types import CallToolResult, EmbeddedResource, ImageContent, ResourceLink, TextContent

from ._js import WS, js_json, js_len, js_number_to_string, js_parse, js_slice, js_trim

ChatMessage = dict[str, Any]
"""{"role", "content", "tool_calls"?, "tool_call_id"?} as sent to the OpenAI-compatible API."""

PURCHASE_RULE = (
    "- Orders and payments: the sub-agent always asks you (reason confirm) before it places an order or pays. "
    'When the user\'s task explicitly approves the purchase (for example "I approve", "go ahead and pay", '
    '"no need to ask me", or a maximum price such as "up to $20"), pass the user\'s words as purchase_approval to '
    'agent_run (or agent_automate), and answer the matching confirm question "Yes" yourself when the checkout '
    "matches that approval (item, quantity, total within the limit, address, payment method). A task that only "
    'asks you to order or buy something ("order X and give me the order number") does not approve the purchase: '
    "it says what to buy, not what it may cost."
)
"""A purchase the task approves: the host approves the matching question itself (both modes)."""


def _sub_agent_questions(interactive: bool) -> str:
    """What this host does when a sub-agent run pauses with a question. One-shot (not interactive):
    nobody is there to ask, so it answers itself and refuses what the task did not approve.
    Interactive: it ends its turn to ask the user, and the CLI brings the user's reply back to it."""
    if interactive:
        lines = [
            'Sub-agent questions: a sub-agent run (agent_run, agent_automate) can pause with status "waiting" and ask '
            "you a question. Answer it with agent_reply (run_id and question_id from the result) before you give your "
            "final answer. While a run you started is waiting, end your turn only to ask the user a question below; "
            "their reply comes back to you.",
            "- Answer from the user's task when it decides the question.",
            f"{PURCHASE_RULE} Then do not pass purchase_approval. When the task does not explicitly approve the purchase, "
            "do not approve it yourself: end your turn by asking the user (item, total, delivery address, payment "
            'method, the site); their reply comes back to you, then answer the waiting question with agent_reply ("Yes" '
            'only if they approve; "No" otherwise). Do the same when the checkout differs from the approval or goes '
            "beyond it.",
            "- Other confirm questions (sending a message, deleting) that the task did not explicitly approve: ask the "
            "user the same way, and answer with their decision.",
        ]
    else:
        lines = [
            'Sub-agent questions: a sub-agent run (agent_run, agent_automate) can pause with status "waiting" and ask '
            "you a question. Answer it with agent_reply (run_id and question_id from the result) before you give your "
            "final answer, and never end with a final answer while a run you started is waiting.",
            "- Answer from the user's task when it decides the question.",
            f'{PURCHASE_RULE} Then do not pass purchase_approval, reply "No" to the confirm question, and say in your '
            "final answer that the order is ready and needs the user's approval, with the item and the total. Also "
            'reply "No" when the checkout differs from the approval or goes beyond it.',
            '- The user cannot answer: reply "No" to any other confirm question (sending a message, deleting) that the '
            "task did not explicitly approve, and say so in your final answer.",
        ]
    return "\n".join(
        [
            *lines,
            "- Never send a password. Give a one-time code only if the task contains it; otherwise reply that you do "
            "not have it.",
            "- Answer only the questions of runs you started in this task; runs other clients started are theirs to "
            "answer.",
            "- If you cannot answer at all, call agent_cancel for that run.",
        ]
    )


def build_system_prompt(
    server_instructions: str | None,
    vision: bool,
    extra: str | None = None,
    sub_agents: bool = False,
    interactive: bool = False,
) -> str:
    """`sub_agents`: the model has agent_reply. `interactive`: the CLI asks the user when the model
    ends its turn while a sub-agent run it started waits for an answer (only with sub-agents)."""
    asks_user = interactive and sub_agents
    who_answers = (
        "Ask the user only to decide a sub-agent question as described below; any other reply without tool calls "
        "ends the task as your final answer."
        if asks_user
        else "The user cannot answer questions while you work."
    )
    parts = [
        "You are a browser automation agent. You control a real web browser (headless, JavaScript enabled) through "
        f"the provided tools and complete the user's task on your own. {who_answers}\n"
        "\n"
        "How to work:\n"
        "- Open pages with browser_navigate, then read them with browser_snapshot before anything else; do not guess "
        'CSS selectors for a page you have not read. Snapshots list interactive elements with refs such as "e12"; '
        "pass a ref to the interaction tools. Refs change when the page changes: take a new snapshot before reusing "
        "them.\n"
        "- Do one step at a time and check each tool result before the next call. If a tool returns an error, read "
        "the message and change your approach instead of repeating the same call.\n"
        "- Only report facts that appear in tool results, and copy requested text exactly as the page shows it.\n"
        "- When the task is done, stop calling tools and reply with a short final answer that contains the "
        "requested values.",
        "Screenshots from browser_screenshot are attached as images right after the tool result."
        if vision
        else "You cannot see images: rely on browser_snapshot and other text tools to understand pages.",
    ]
    if sub_agents:
        parts.append(_sub_agent_questions(asks_user))
    if server_instructions and js_trim(server_instructions):
        parts.append(f"Notes from the browser server:\n{js_trim(server_instructions)}")
    if extra and js_trim(extra):
        parts.append(js_trim(extra))
    return "\n\n".join(parts)


@dataclass
class ParsedArguments:
    ok: bool
    value: dict[str, Any] = field(default_factory=dict)
    error: str = ""


def _parse_object(text: str) -> dict[str, Any]:
    value = js_parse(text)
    if not isinstance(value, dict):
        raise ValueError("arguments must be a JSON object")
    return value


_FENCE_START = re.compile(f"^```(?:json)?{WS}*", re.I | re.A)
_FENCE_END = re.compile(f"```{WS}*$")


def parse_tool_arguments(raw: str) -> ParsedArguments:
    """Parse tool-call arguments, tolerating code fences and trailing junk around one JSON object."""
    text = js_trim(raw)
    if text in ("", "null"):
        return ParsedArguments(ok=True, value={})
    try:
        return ParsedArguments(ok=True, value=_parse_object(text))
    except ValueError as first:
        unfenced = _FENCE_END.sub("", _FENCE_START.sub("", text, count=1), count=1)
        start = unfenced.find("{")
        end = unfenced.rfind("}")
        if start >= 0 and end > start:
            try:
                return ParsedArguments(ok=True, value=_parse_object(unfenced[start : end + 1]))
            except ValueError:
                pass
        return ParsedArguments(ok=False, error=str(first))


_THINK = re.compile(r"<think>(.*?)</think>", re.S)


def split_thinking(content: str) -> tuple[str, str]:
    """(reasoning, content): separate `<think>` blocks when LM Studio does not split reasoning into
    reasoning_content."""
    reasoning_parts: list[str] = []

    def take(match: re.Match[str]) -> str:
        reasoning_parts.append(match.group(1))
        return ""

    rest = _THINK.sub(take, content)
    reasoning = "".join(reasoning_parts)
    opening = rest.find("<think>")
    if opening >= 0:
        reasoning += rest[opening + 7 :]
        rest = rest[:opening]
    elif not reasoning and "</think>" in rest:
        close = rest.index("</think>")
        reasoning = rest[:close]
        rest = rest[close + 8 :]
    return js_trim(reasoning), js_trim(rest)


TEXT_TOOL_CALL = re.compile(
    f'<tool_call>|<function[={WS[1:-1]}]|"name"{WS}*:{WS}*"browser_[a-z_]+"|\\bbrowser_[a-z_]+{WS}*\\({WS}*\\{{',
    re.A,
)
"""A reply that describes a tool call as text instead of calling it."""


def truncate_text(text: str, limit: float) -> str:
    length = js_len(text)
    if length <= limit:
        return text
    return (
        f"{js_slice(text, 0, limit)}\n...[truncated {js_number_to_string(length - limit)} characters. "
        "Use more specific tools or options to read the rest.]"
    )


@dataclass
class FormattedResult:
    text: str
    images: list[dict[str, str]]
    """[{"mimeType", "data"}]"""


_ERROR_PREFIX = re.compile(r"error\b", re.I | re.A)


def format_tool_result(result: CallToolResult, max_chars: float, vision: bool) -> FormattedResult:
    texts: list[str] = []
    images: list[dict[str, str]] = []
    for item in result.content or []:
        if isinstance(item, TextContent):
            texts.append(item.text)
        elif isinstance(item, ImageContent):
            if vision:
                images.append({"mimeType": item.mime_type, "data": item.data})
                texts.append(f"[image {item.mime_type} attached in the next message]")
            else:
                texts.append("[image returned; not shown because vision is off]")
        elif isinstance(item, EmbeddedResource):
            text = getattr(item.resource, "text", None)
            texts.append(text if isinstance(text, str) else f"[resource {item.resource.uri}]")
        elif isinstance(item, ResourceLink):
            texts.append(js_trim(f"[resource link {item.name} {item.uri}]"))
        else:
            texts.append(f"[{getattr(item, 'type', 'unknown')} content omitted]")
    if result.structured_content is not None and not texts:
        texts.append(js_json(result.structured_content))
    text = js_trim("\n".join(texts)) or (
        "Error: the tool failed without a message" if result.is_error else "(no output)"
    )
    if result.is_error and not _ERROR_PREFIX.match(text):
        text = f"Error: {text}"
    return FormattedResult(text=truncate_text(text, max_chars), images=images)


OLD_RESULT_CHARS = 1_500
MIN_RESULT_CHARS = 300
KEEP_FULL_RESULTS = 6
IMAGE_CHARS = 4_000
"""Rough prompt cost of one attached screenshot, in characters of text."""
CHARS_PER_TOKEN = 3.2
"""Conservative characters per token for browser text and JSON (measured ~3.7 for the tool definitions)."""


def content_chars(message: ChatMessage) -> int:
    tool_calls = message.get("tool_calls")
    calls = js_len(js_json(tool_calls)) if tool_calls is not None else 0
    content = message.get("content")
    if isinstance(content, str):
        return js_len(content) + calls
    if not isinstance(content, list):
        return calls
    return calls + sum(js_len(p["text"]) if p.get("type") == "text" else IMAGE_CHARS for p in content)


def compact_history(messages: MutableSequence[ChatMessage], max_chars: float = math.inf) -> None:
    """Keep the context small: shorten old tool results and drop images from earlier turns. With
    `max_chars` (derived from the loaded context length), older results are shortened further until
    the conversation fits; the newest result stays whole."""
    tool_idx = [i for i, m in enumerate(messages) if m.get("role") == "tool"]

    def shorten(i: int, limit: int, note: str) -> None:
        content = messages[i].get("content")
        if isinstance(content, str) and js_len(content) > limit + 100:
            messages[i]["content"] = f"{js_slice(content, 0, limit)}\n...[{note}]"

    for i in tool_idx[: max(0, len(tool_idx) - KEEP_FULL_RESULTS)]:
        shorten(i, OLD_RESULT_CHARS, "older result shortened to save context")
    image_idx = [
        i
        for i, m in enumerate(messages)
        if isinstance(m.get("content"), list) and any(p.get("type") == "image_url" for p in m["content"])
    ]
    for i in image_idx[:-1]:
        messages[i]["content"] = [
            {"type": "text", "text": "[image from an earlier step removed to save context]"}
            if p.get("type") == "image_url"
            else p
            for p in messages[i]["content"]
        ]
    if not math.isfinite(max_chars):
        return

    # the conversation's size, kept up to date as results are shortened (only tool messages change)
    sizes = [content_chars(m) for m in messages]
    total = sum(sizes)
    for limit in (OLD_RESULT_CHARS, MIN_RESULT_CHARS):
        for i in tool_idx[:-1]:
            if total <= max_chars:
                return
            shorten(i, limit, "older result shortened to fit the model context")
            size = content_chars(messages[i])
            total += size - sizes[i]
            sizes[i] = size


def redact_images(messages: list[ChatMessage]) -> list[ChatMessage]:
    """The transcript without base64 images."""
    return [
        {
            **m,
            "content": [
                {"type": "text", "text": f"[image, {js_len(p['image_url']['url'])} base64 chars]"}
                if p.get("type") == "image_url"
                else p
                for p in m["content"]
            ],
        }
        if isinstance(m.get("content"), list)
        else m
        for m in messages
    ]
