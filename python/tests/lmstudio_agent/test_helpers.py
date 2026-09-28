"""Helpers of the agent host (the port of test/unit/lmstudio-agent.test.ts, "lmstudio agent helpers")."""

from __future__ import annotations

import re
import sys
from typing import Any

import pytest
from mcp.types import CallToolResult, ImageContent, TextContent, Tool

from sws_tools.lmstudio_agent._js import js_json, js_len
from sws_tools.lmstudio_agent.cli import UsageError, parse_cli
from sws_tools.lmstudio_agent.conversation import (
    ChatMessage,
    build_system_prompt,
    compact_history,
    format_tool_result,
    parse_tool_arguments,
    split_thinking,
)
from sws_tools.lmstudio_agent.errors import AgentError
from sws_tools.lmstudio_agent.mcp_client import GROUP_META, select_tools, to_openai_tool

ONE_SHOT_PURCHASE_RULE = (
    r"\n- Orders and payments: the sub-agent always asks you \(reason confirm\) before it places an order or pays\. "
    r'When the user\'s task explicitly approves the purchase \(for example "I approve", "go ahead and pay", "no need '
    r'to ask me", or a maximum price such as "up to \$20"\), pass the user\'s words as purchase_approval to agent_run '
    r'\(or agent_automate\), and answer the matching confirm question "Yes" yourself when the checkout matches that '
    r"approval \(item, quantity, total within the limit, address, payment method\)\. A task that only asks you to "
    r'order or buy something \("order X and give me the order number"\) does not approve the purchase: it says what '
    r"to buy, not what it may cost\. Then do not pass purchase_approval"
)


def test_parse_tool_arguments_accepts_objects_fenced_json_and_empty_input() -> None:
    parsed = parse_tool_arguments('{"url":"https://a.test"}')
    assert (parsed.ok, parsed.value) == (True, {"url": "https://a.test"})
    parsed = parse_tool_arguments('```json\n{"a":1}\n```')
    assert (parsed.ok, parsed.value) == (True, {"a": 1})
    parsed = parse_tool_arguments("  ")
    assert (parsed.ok, parsed.value) == (True, {})
    assert parse_tool_arguments("[1,2]").ok is False
    assert parse_tool_arguments('{"url": ').ok is False


def test_split_thinking_separates_think_blocks_from_the_answer() -> None:
    assert split_thinking("<think>plan</think>\n\nAnswer") == ("plan", "Answer")
    assert split_thinking("Answer<think>unfinished") == ("unfinished", "Answer")
    assert split_thinking("plan only</think>Answer") == ("plan only", "Answer")
    assert split_thinking("Plain answer") == ("", "Plain answer")


def test_to_openai_tool_strips_schema_and_always_has_an_object_schema() -> None:
    tool = Tool(
        name="x", description="d", input_schema={"$schema": "http://json-schema.org/draft-07/schema#", "type": "object"}
    )
    assert to_openai_tool(tool) == {
        "type": "function",
        "function": {"name": "x", "description": "d", "parameters": {"type": "object", "properties": {}}},
    }


def test_format_tool_result_marks_errors_and_replaces_images_when_vision_is_off() -> None:
    r = format_tool_result(CallToolResult(is_error=True, content=[TextContent(type="text", text="boom")]), 1000, False)
    assert r.text == "Error: boom"
    img = format_tool_result(
        CallToolResult(
            content=[
                TextContent(type="text", text="shot"),
                ImageContent(type="image", mime_type="image/png", data="AAAA"),
            ]
        ),
        1000,
        False,
    )
    assert len(img.images) == 0
    assert re.search(r"vision is off", img.text)
    truncated = format_tool_result(CallToolResult(content=[TextContent(type="text", text="x" * 50)]), 10, True)
    assert re.search(r"truncated 40 characters", truncated.text)


def test_system_prompt_a_purchase_the_task_approves_is_passed_as_purchase_approval_and_approved_by_the_host_itself_anything_else_gets_no() -> (
    None
):
    prompt = build_system_prompt("server notes", False, None, True)
    assert re.search(
        ONE_SHOT_PURCHASE_RULE
        + r', reply "No" to the confirm question, and say in your final answer that the order is ready and needs the '
        r"user's approval, with the item and the total\. Also reply \"No\" when the checkout differs from the approval "
        r"or goes beyond it\.\n",
        prompt,
    )
    assert re.search(
        r'\n- The user cannot answer: reply "No" to any other confirm question \(sending a message, deleting\) that the '
        r"task did not explicitly approve, and say so in your final answer\.\n",
        prompt,
    )
    assert re.search(r"The user cannot answer questions while you work\.", prompt), (
        "a one-shot run: nobody to ask mid-task"
    )
    assert not re.search(r"confirm_purchases", prompt)
    assert prompt.index("Sub-agent questions:") < prompt.index("Notes from the browser server:\nserver notes")
    # without agent_reply there are no sub-agent questions to answer
    assert not re.search(
        r"purchase_approval|Sub-agent questions", build_system_prompt("server notes", False, None, False)
    )


def test_the_interactive_system_prompt_a_purchase_the_task_did_not_approve_is_put_to_the_user_whose_reply_decides_the_answer() -> (
    None
):
    prompt = build_system_prompt("server notes", False, None, True, True)
    # the approval rule itself is the same in both modes
    assert re.search(ONE_SHOT_PURCHASE_RULE + r"\. ", prompt)
    assert re.search(
        r"When the task does not explicitly approve the purchase, do not approve it yourself: end your turn by asking "
        r"the user \(item, total, delivery address, payment method, the site\); their reply comes back to you, then "
        r'answer the waiting question with agent_reply \("Yes" only if they approve; "No" otherwise\)\. Do the same '
        r"when the checkout differs from the approval or goes beyond it\.\n",
        prompt,
    )
    assert re.search(
        r"\n- Other confirm questions \(sending a message, deleting\) that the task did not explicitly approve: ask the "
        r"user the same way, and answer with their decision\.\n",
        prompt,
    )
    assert re.search(
        r"While a run you started is waiting, end your turn only to ask the user a question below; their reply comes "
        r"back to you\.",
        prompt,
    )
    assert re.search(
        r"Ask the user only to decide a sub-agent question as described below; any other reply without tool calls "
        r"ends the task as your final answer\.",
        prompt,
    )
    # nothing of the one-shot text that tells the model nobody can answer
    assert not re.search(r"The user cannot answer", prompt)
    assert not re.search(r"the order is ready and needs the user's approval", prompt)
    assert not re.search(r"never end with a final answer while a run you started is waiting", prompt)
    # the rules that do not depend on the user being there
    assert re.search(
        r"\n- Never send a password\. Give a one-time code only if the task contains it; otherwise reply that you do "
        r"not have it\.\n- Answer only the questions of runs you started in this task",
        prompt,
    )
    assert prompt.index("Sub-agent questions:") < prompt.index("Notes from the browser server:\nserver notes")

    # without sub-agents there is nothing to ask the user about: the one-shot text stays
    plain = build_system_prompt("server notes", False, None, False, True)
    assert re.search(r"The user cannot answer questions while you work\.", plain)
    assert not re.search(r"Sub-agent questions|Ask the user only", plain)


def test_parse_cli_interactive_by_default_on_a_terminal_without_quiet_interactive_and_no_interactive_override() -> None:
    def interactive(argv: list[str], tty: bool) -> bool:
        return parse_cli(["task", *argv], {}, tty).interactive

    assert interactive([], True) is True
    assert interactive([], False) is False, "piped stdin: nobody at a terminal"
    assert interactive(["--quiet"], True) is False
    assert interactive(["-q"], True) is False
    assert interactive(["--no-interactive"], True) is False
    assert interactive(["--interactive"], False) is True
    assert interactive(["--interactive", "--quiet"], True) is True
    assert interactive(["--interactive", "--no-interactive"], True) is False, "--no-interactive wins, like --no-vision"


class _Stream:
    def __init__(self, tty: bool) -> None:
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def test_parse_cli_by_default_a_terminal_needs_both_stdin_to_answer_and_stdout_to_see_the_question(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def interactive(stdin: bool, stdout: bool) -> bool:
        with monkeypatch.context() as m:
            m.setattr(sys, "stdin", _Stream(stdin))
            m.setattr(sys, "stdout", _Stream(stdout))
            return parse_cli(["task"], {}).interactive

    assert interactive(True, True) is True
    assert interactive(True, False) is False, "output redirected to a file: the question would wait unseen"
    assert interactive(False, True) is False, "piped stdin: nobody to answer"
    assert interactive(False, False) is False


def test_parse_cli_task_options_and_environment_defaults_and_usage_errors() -> None:
    cli = parse_cli(
        [
            "Order",
            "a mug",
            "--max-steps",
            "12",
            "--toolsets",
            "core, agents",
            "--no-vision",
            "--json",
            "out.json",
            "--reasoning",
            "none",
        ],
        {"LMSTUDIO_MODEL": "env/model", "MCP_URL": "http://127.0.0.1:9/mcp", "AUTH_TOKEN": "t1", "LM_API_TOKEN": "t2"},
        False,
    )
    assert cli.help is False
    assert cli.json == "out.json"
    assert cli.options.task == "Order a mug"
    assert cli.options.model == "env/model"
    assert cli.options.max_steps == 12
    assert cli.options.toolsets == ["core", "agents"]
    assert cli.options.vision is False
    assert cli.options.reasoning == "none"
    assert cli.options.mcp_url == "http://127.0.0.1:9/mcp"
    assert cli.options.auth_token == "t1"
    assert cli.options.lm_api_token == "t2"
    assert cli.options.ask is None, "main adds the ask callback"
    assert (
        parse_cli(["x", "--model", "flag/model"], {"LMSTUDIO_MODEL": "env/model"}, False).options.model == "flag/model"
    )

    assert parse_cli(["--help"], {}, True).help is True, "help needs no task"

    def usage(argv: list[str]) -> tuple[str, bool]:
        with pytest.raises(UsageError) as info:
            parse_cli(argv, {}, False)
        return info.value.message, info.value.show_usage

    assert usage([]) == ("Missing task.", True)
    assert usage(["x", "--reasoning", "max"]) == ("--reasoning must be one of none, low, medium, high, on", False)
    assert usage(["x", "--max-steps", "0"]) == ('--max-steps must be a number >= 1, got "0"', False)
    unknown, with_usage = usage(["x", "--interactve"])
    assert re.search(r"Unknown option '--interactve'", unknown)
    assert with_usage is True


def _tool(name: str, group: str) -> Tool:
    return Tool(name=name, input_schema={"type": "object"}, _meta={GROUP_META: group})


def test_select_tools_rejects_unknown_toolsets_instead_of_silently_dropping_them() -> None:
    # the server publishes each tool's group in its _meta (the TS host read it from src/tools)
    tools = [_tool("browser_navigate", "core"), _tool("browser_fill_form", "forms"), _tool("browser_evaluate", "debug")]
    assert [t.name for t in select_tools(tools, None, ["CORE"])] == ["browser_navigate"]
    with pytest.raises(AgentError, match=r"Unknown toolset\(s\): formz"):
        select_tools(tools, None, ["core", "formz"])
    assert [t.name for t in select_tools(tools, ["browser_evaluate"], ["core"])] == [
        "browser_navigate",
        "browser_evaluate",
    ]


def test_compact_history_shortens_old_results_keeps_one_image_and_fits_a_context_budget() -> None:
    big = "x" * 10_000
    messages: list[ChatMessage] = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
    for i in range(8):
        messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": str(i), "type": "function", "function": {"name": "browser_snapshot", "arguments": "{}"}}
                ],
            }
        )
        messages.append({"role": "tool", "tool_call_id": str(i), "content": big})
        messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "img"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            }
        )
    compact_history(messages)
    tools = [len(m["content"]) for m in messages if m["role"] == "tool"]
    assert tools[0] < 2_000, "results older than the last six are shortened"
    assert tools[1] < 2_000, "results older than the last six are shortened"
    assert tools[2:] == [10_000] * 6
    images = [p for m in messages if isinstance(m["content"], list) for p in m["content"] if p["type"] == "image_url"]
    assert len(images) == 1

    compact_history(messages, 25_000)
    fitted = [len(m["content"]) for m in messages if m["role"] == "tool"]
    assert fitted[-1] == 10_000, "the newest result stays whole"

    def chars(m: dict[str, Any]) -> int:
        content = m["content"]
        if isinstance(content, str):
            return len(content)
        return sum(len(p["text"]) if p["type"] == "text" else 4_000 for p in content or [])

    total = sum(chars(m) + (js_len(js_json(m["tool_calls"])) if "tool_calls" in m else 0) for m in messages)
    assert total <= 25_000, f"conversation fits the budget ({total} chars)"
