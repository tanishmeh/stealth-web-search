"""Command-line parsing with the rules and messages of Node's util.parseArgs (strict mode).

The CLIs keep the syntax they had as TypeScript scripts: options and positionals in any order,
`--name value` and `--name=value`, `-q` short aliases and groups such as `-qh`, `--` to end the
options, the last repeat of an option wins, and the same error texts.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from ._js import js_json


@dataclass(frozen=True)
class Option:
    type: Literal["string", "boolean"]
    short: str | None = None


class ParseArgsError(ValueError):
    """A command-line mistake; the message is the one Node's parseArgs gives."""


@dataclass
class _Token:
    kind: Literal["option", "positional"]
    name: str = ""
    raw_name: str = ""
    value: str | None = None
    inline_value: bool | None = None


def _long_for_short(short: str, options: Mapping[str, Option]) -> str:
    for name, option in options.items():
        if option.short == short:
            return name
    return short


def _type(name: str, options: Mapping[str, Option]) -> str | None:
    option = options.get(name)
    return option.type if option else None


def _tokens(args: Sequence[str], options: Mapping[str, Option]) -> list[_Token]:
    tokens: list[_Token] = []
    remaining = list(args)
    while remaining:
        arg = remaining.pop(0)
        next_arg = remaining[0] if remaining else None
        if arg == "--":
            tokens.extend(_Token("positional", value=rest) for rest in remaining)
            break
        if len(arg) == 2 and arg[0] == "-" and arg[1] != "-":  # -f
            name = _long_for_short(arg[1], options)
            value = None
            inline = None
            if _type(name, options) == "string" and next_arg is not None:
                value = remaining.pop(0)
                inline = False
            tokens.append(_Token("option", name, arg, value, inline))
            continue
        if len(arg) > 2 and arg[0] == "-" and arg[1] != "-":
            first = _long_for_short(arg[1], options)
            if _type(first, options) != "string":  # a group: -abc
                expanded: list[str] = []
                for i in range(1, len(arg)):
                    name = _long_for_short(arg[i], options)
                    if _type(name, options) != "string" or i == len(arg) - 1:
                        expanded.append(f"-{arg[i]}")
                    else:
                        expanded.append(f"-{arg[i:]}")
                        break
                remaining[:0] = expanded
                continue
            tokens.append(_Token("option", first, f"-{arg[1]}", arg[2:], True))  # -fVALUE
            continue
        if len(arg) > 2 and arg.startswith("--"):
            if "=" not in arg[3:]:  # --foo
                name = arg[2:]
                value = None
                inline = None
                if _type(name, options) == "string" and next_arg is not None:
                    value = remaining.pop(0)
                    inline = False
                tokens.append(_Token("option", name, arg, value, inline))
            else:  # --foo=bar
                eq = arg.index("=")
                name = arg[2:eq]
                tokens.append(_Token("option", name, f"--{name}", arg[eq + 1 :], True))
            continue
        tokens.append(_Token("positional", value=arg))
    return tokens


def parse_args(
    args: Sequence[str], options: Mapping[str, Option], *, allow_positionals: bool = False
) -> tuple[dict[str, str | bool], list[str]]:
    """Return (values, positionals) like parseArgs({ args, options, allowPositionals, strict: true })."""
    values: dict[str, str | bool] = {}
    positionals: list[str] = []
    for token in _tokens(args, options):
        if token.kind == "positional":
            assert token.value is not None
            if not allow_positionals:
                raise ParseArgsError(
                    f"Unexpected argument '{token.value}'. This command does not take positional arguments"
                )
            positionals.append(token.value)
            continue
        option = options.get(token.name)
        if option is None:
            hint = (
                ". To specify a positional argument starting with a '-', place it at the end of the command "
                f"after '--', as in '-- {js_json(token.raw_name)}"
                if allow_positionals
                else ""
            )
            raise ParseArgsError(f"Unknown option '{token.raw_name}'{hint}")
        short_and_long = f"{f'-{option.short}, ' if option.short else ''}--{token.name}"
        if option.type == "string" and token.value is None:
            raise ParseArgsError(f"Option '{short_and_long} <value>' argument missing")
        if option.type == "boolean" and token.value is not None:
            raise ParseArgsError(f"Option '{short_and_long}' does not take an argument")
        if not token.inline_value and token.value is not None and len(token.value) > 1 and token.value[0] == "-":
            example = (
                f"'{token.raw_name}=-XYZ'"
                if token.raw_name.startswith("--")
                else f"'--{token.name}=-XYZ' or '{token.raw_name}-XYZ'"
            )
            raise ParseArgsError(
                f"Option '{token.raw_name}' argument is ambiguous.\n"
                f"Did you forget to specify the option argument for '{token.raw_name}'?\n"
                f"To specify an option argument starting with a dash use {example}."
            )
        values[token.name] = True if token.value is None else token.value
    return values, positionals
