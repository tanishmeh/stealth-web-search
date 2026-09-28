"""The JavaScript-compatible helpers the agent host relies on to say and print exactly what the
TypeScript host did. Expected values come from Node 24 (JSON.stringify, String(n), toFixed,
Math.round, util.parseArgs)."""

from __future__ import annotations

import math
import os
import re
from typing import Any

import pytest

from sws_tools.lmstudio_agent._args import Option, ParseArgsError, parse_args
from sws_tools.lmstudio_agent._js import (
    js_json,
    js_len,
    js_number,
    js_number_to_string,
    js_round,
    js_slice,
    js_to_fixed,
    js_trim,
)
from sws_tools.lmstudio_agent.abort import AbortController
from sws_tools.lmstudio_agent.cli import UsageError, parse_cli
from sws_tools.lmstudio_agent.conversation import compact_history
from sws_tools.lmstudio_agent.lmstudio import BodyEncoder
from sws_tools.lmstudio_agent.output import style_text
from sws_tools.lmstudio_agent.stdin import StdinAsker

NUMBERS = [0, -0.0, 1, 1.5, -2.25, 0.1, 1e-7, 1.5e-7, 0.000001, 0.00001, 123456789012, 1e21, 1.2e21, 2**53, 2**53 + 2]
NUMBERS += [1e16, 12345678.9, 5e-324, 1.7976931348623157e308, -1e-7, 100, 0.5, 3.14159]
NODE_STRINGS = ["0", "0", "1", "1.5", "-2.25", "0.1", "1e-7", "1.5e-7", "0.000001", "0.00001", "123456789012", "1e+21"]
NODE_STRINGS += ["1.2e+21", "9007199254740992", "9007199254740994", "10000000000000000", "12345678.9", "5e-324"]
NODE_STRINGS += ["1.7976931348623157e+308", "-1e-7", "100", "0.5", "3.14159"]


def test_numbers_print_as_in_javascript() -> None:
    assert [js_number_to_string(n) for n in NUMBERS] == NODE_STRINGS
    assert [js_to_fixed(n, d) for n, d in [(1.25, 1), (0.05, 1), (1.35, 1), (2.5, 0), (0.045, 2), (1234.5678, 1)]] == [
        "1.3",
        "0.1",
        "1.4",
        "3",
        "0.04",
        "1234.6",
    ]
    assert [js_round(x) for x in (2.5, -2.5, 0.49999999999999994)] == [3, -2, 0]


def test_number_parsing_follows_number_of_a_string() -> None:
    assert [js_number(s) for s in ("", " 12 ", "0x10", "1e1", ".5", "5.", "+Infinity", "0b11", "\xa012\ufeff")] == [
        0,
        12,
        16,
        10,
        0.5,
        5,
        math.inf,
        3,
        12,
    ]
    assert all(math.isnan(js_number(s)) for s in ("1_0", "- 1", "-0x10", "inf", "nan", "12abc"))
    # Node: ASCII digits only, and no "_", sign or space after a 0x/0o/0b prefix
    not_numbers = ("0x1_0", "0b1_1", "0x 1", "0x-1", "0x+1", "0x", "0o", "0o8", "00x1", "\u0665", "\u0661\u0662")
    assert [s for s in not_numbers if not math.isnan(js_number(s))] == []
    assert all(math.isnan(js_number(s)) for s in ("\uff11\uff12", "1\u0660"))
    assert [js_number(s) for s in ("0X1F", "0O17", "0B11", "0x" + "f" * 300, "1e400")] == [
        31,
        15,
        3,
        math.inf,
        math.inf,
    ]


def test_number_options_reject_what_number_rejects() -> None:
    for value in ("0x1_0", "\u0665", "0b1_1"):
        with pytest.raises(UsageError, match=r'^--max-steps must be a number >= 1, got "'):
            parse_cli(["task", "--max-steps", value], env={}, terminal=False)


def test_json_stringify_orders_integer_keys_first_and_escapes_like_javascript() -> None:
    value = {
        "b": 1,
        "2": {"10": [1.0, "é\ud83d😀\u0007"], "01": 2, "4294967295": 3, "4294967294": 4},
        "a": None,
        "": True,
    }
    assert (
        js_json(value)
        == '{"2":{"10":[1,"é\\ud83d😀\\u0007"],"4294967294":4,"01":2,"4294967295":3},"b":1,"a":null,"":true}'
    )
    assert js_json({"x": [], "y": {}, "z": [{}], "w": "a\u2028b"}, 2) == (
        '{\n  "x": [],\n  "y": {},\n  "z": [\n    {}\n  ],\n  "w": "a\u2028b"\n}'
    )


def test_strings_are_measured_and_cut_in_utf16_units_and_trimmed_with_javascript_whitespace() -> None:
    assert js_len("a😀") == 3
    assert js_slice("a😀b", 0, 2) == "a\ud83d"  # half a surrogate pair, as JavaScript leaves it
    assert js_slice("a😀b", -1) == "b"
    assert js_trim("\ufeff\u3000 x \u2028") == "x"
    assert js_trim("\x1cx\x85") == "\x1cx\x85"  # not whitespace in JavaScript


def test_style_text_matches_node_util_style_text() -> None:
    assert style_text(["bold", "cyan"], "x") == "\x1b[1m\x1b[36mx\x1b[39m\x1b[22m"
    assert style_text("dim", "a\x1b[22mb") == "\x1b[2ma\x1b[22m\x1b[2mb\x1b[22m"
    assert (
        style_text(["bold", "yellow"], "a\x1b[39mb\x1b[22mc")
        == "\x1b[1m\x1b[33ma\x1b[33mb\x1b[22m\x1b[1mc\x1b[39m\x1b[22m"
    )


OPTIONS = {
    "model": Option("string"),
    "quiet": Option("boolean", short="q"),
    "help": Option("boolean", short="h"),
    "no-vision": Option("boolean"),
}


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (
            ["--interactve"],
            "Unknown option '--interactve'. To specify a positional argument starting with a '-', place it at the "
            "end of the command after '--', as in '-- \"--interactve\"",
        ),
        (["--model"], "Option '--model <value>' argument missing"),
        (["--quiet=1"], "Option '-q, --quiet' does not take an argument"),
        (
            ["--model", "--quiet"],
            "Option '--model' argument is ambiguous.\nDid you forget to specify the option argument for '--model'?\n"
            "To specify an option argument starting with a dash use '--model=-XYZ'.",
        ),
        (
            ["-qx"],
            "Unknown option '-x'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-x\"",
        ),
        (["--no-vision=true"], "Option '--no-vision' does not take an argument"),
    ],
)
def test_parse_args_rejects_what_node_parse_args_rejects_with_its_messages(args: list[str], message: str) -> None:
    with pytest.raises(ParseArgsError) as info:
        parse_args(args, OPTIONS, allow_positionals=True)
    assert str(info.value) == message


def test_parse_args_accepts_what_node_parse_args_accepts() -> None:
    assert parse_args(["-qh", "a"], OPTIONS, allow_positionals=True) == ({"quiet": True, "help": True}, ["a"])
    assert parse_args(["--model=", "a"], OPTIONS, allow_positionals=True) == ({"model": ""}, ["a"])
    assert parse_args(["a", "--", "--model", "b"], OPTIONS, allow_positionals=True) == ({}, ["a", "--model", "b"])
    assert parse_args(["--model", "a", "--model", "b"], OPTIONS, allow_positionals=True) == ({"model": "b"}, [])
    with pytest.raises(
        ParseArgsError, match=re.escape("Unexpected argument 'x'. This command does not take positional arguments")
    ):
        parse_args(["x"], OPTIONS)


def test_the_request_body_encoder_reuses_json_only_while_it_is_still_the_same() -> None:
    messages: list[dict[str, Any]] = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task é"}]
    for i in range(10):
        messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": str(i), "type": "function", "function": {"name": "t", "arguments": "{}"}}],
            }
        )
        messages.append({"role": "tool", "tool_call_id": str(i), "content": "😀" * 3000})
    tools = [
        {
            "type": "function",
            "function": {
                "name": "t",
                "description": "d",
                "parameters": {"type": "object", "properties": {"1": {}, "b": {}}},
            },
        }
    ]
    encoder = BodyEncoder()
    body: dict[str, Any] = {
        "model": "m",
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 8192,
        "tools": tools,
        "stream": True,
    }
    assert encoder.encode(body) == js_json(body)
    compact_history(messages, 20_000)  # replaces the content of older results
    messages.append({"role": "user", "content": [{"type": "text", "text": "img"}]})
    assert encoder.encode(body) == js_json(body)
    assert encoder.encode({"1": "x", "model": "m"}) == js_json({"1": "x", "model": "m"})


@pytest.mark.anyio
async def test_the_stdin_asker_reads_lines_ending_in_lf_crlf_or_cr_and_returns_none_at_the_end() -> None:
    read_fd, write_fd = os.pipe()
    written: list[str] = []
    try:
        asker = StdinAsker(AbortController().signal, fd=read_fd, write=written.append, terminal=lambda: False)
        os.write(write_fd, "a\r\nb\rc\nd é".encode())
        os.close(write_fd)
        answers = [await asker.ask("? ") for _ in range(5)]
    finally:
        os.close(read_fd)
    assert answers == ["a", "b", "c", "d é", None]
    assert written == ["? ", "\n"] * 5  # the prompt line ends, as Enter would end it in a terminal
