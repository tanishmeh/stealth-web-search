"""Code highlighting for the website: Pygments lexers, written out with the highlight.js class names
(hljs-*) that site/assets/site.css colours.

Pygments tokenizes differently from highlight.js, so the classes come from a map per language, with a
few refinements where highlight.js marks something Pygments has no token for (JSON keys, JavaScript
method calls and properties, the shell commands highlight.js knows, the value types of .env/INI
lines). The target is the same colours as the TypeScript builder's highlight.js output, not the same
bytes.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator
from functools import cache
from typing import Any

# Pygments has no type hints
from pygments.lexer import Lexer  # type: ignore[import-untyped]
from pygments.lexers import get_lexer_by_name  # type: ignore[import-untyped]
from pygments.token import (  # type: ignore[import-untyped]
    Comment,
    Generic,
    Keyword,
    Literal,
    Name,
    Number,
    Operator,
    Punctuation,
    String,
    Text,
    Token,
)

Tokens = list[tuple[Any, str]]
"""A lexer's output: (Pygments token type, text)."""
Piece = tuple[str | None, str]
"""(hljs class without the 'hljs-' prefix, or None for plain text; the text)."""
ClassMap = tuple[tuple[Any, str | None], ...]
"""Pygments token type -> hljs class, most specific first; a type matches its subtypes too."""
Refiner = Callable[[Tokens], Iterable[Piece]]

# Every language name the TypeScript builder's highlight.js accepted (registered names, their
# highlight.js aliases and the extra aliases it registered), with the Pygments lexer and the class
# rules used for it. A fence in any other language is shown as plain, escaped text.
_FAMILIES: dict[tuple[str, str], tuple[str, ...]] = {
    ("bash", "bash"): ("bash", "sh", "shell", "console", "zsh"),
    ("docker", "docker"): ("dockerfile", "docker"),
    ("ini", "ini"): ("ini", "env", "dotenv"),
    ("toml", "toml"): ("toml",),
    ("javascript", "js"): ("javascript", "js", "mjs", "cjs", "jsx"),
    ("typescript", "js"): ("typescript", "ts", "tsx", "mts", "cts"),
    ("json", "json"): ("json", "jsonc", "json5"),
    ("text", "text"): ("plaintext", "text", "txt"),
    ("xml", "xml"): ("xml", "rss", "atom", "xjb", "xsd", "xsl", "plist", "svg", "wsf"),
    ("html", "xml"): ("html", "xhtml"),
    ("yaml", "yaml"): ("yaml", "yml"),
}
LANGUAGES: dict[str, tuple[str, str]] = {name: family for family, names in _FAMILIES.items() for name in names}


def is_known(language: str) -> bool:
    """Whether a fence in `language` is highlighted (what hljs.getLanguage answered)."""
    return language in LANGUAGES


def escape(text: str) -> str:
    """highlight.js's escaping of code text."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )


def highlight(text: str, language: str) -> str | None:
    """`text` as highlighted HTML, or None when `language` is not one the site highlights."""
    family = LANGUAGES.get(language)
    if family is None:
        return None
    lexer_name, rules = family
    if rules == "text":
        return escape(text)
    # lexed with a final line break (some rules, such as bash comments, need one), which is then
    # taken off again
    tokens = list(_lexer(lexer_name).get_tokens(text))
    if not text.endswith("\n") and tokens and tokens[-1][1].endswith("\n"):
        ttype, value = tokens[-1]
        tokens[-1] = (ttype, value[:-1])
    return _emit(_REFINERS[rules](tokens))


@cache
def _lexer(name: str) -> Lexer:
    return get_lexer_by_name(name, stripnl=False, ensurenl=True)


def _emit(pieces: Iterable[Piece]) -> str:
    """Spans for classed pieces, adjacent pieces of the same class merged into one span. Line breaks
    at the edges of a piece stay outside its span, so a span never runs over a line end."""
    out: list[str] = []
    current: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            text = escape("".join(buffer))
            out.append(f'<span class="hljs-{current}">{text}</span>' if current else text)
            buffer.clear()

    for cls, value in pieces:
        if not value:
            continue
        core = value.strip("\n")
        if cls and core:
            start = value.index(core)
            lead, trail = value[:start], value[start + len(core) :]
        else:
            cls, lead, core, trail = None, "", value, ""
        for part_cls, part in ((None, lead), (cls, core), (None, trail)):
            if not part:
                continue
            if part_cls != current:
                flush()
                current = part_cls
            buffer.append(part)
    flush()
    return "".join(out)


def _words(text: str) -> frozenset[str]:
    return frozenset(text.split())


def _classify(ttype: Any, table: ClassMap) -> str | None:
    for token_type, cls in table:
        if ttype in token_type:
            return cls
    return None


# Pygments token type -> hljs class, most specific first. None: no span (plain text).
_BASE: ClassMap = (
    (Comment.Hashbang, "meta"),
    (Comment.Preproc, "meta"),
    (Comment, "comment"),
    (Keyword.Constant, "literal"),
    (Keyword.Type, "type"),
    (Keyword, "keyword"),
    (Operator.Word, "keyword"),
    (Name.Builtin.Pseudo, "variable language_"),
    (Name.Builtin, "built_in"),
    (Name.Tag, "name"),
    (Name.Attribute, "attr"),
    (Name.Variable, "variable"),
    (Name.Function, "title function_"),
    (Name.Class, "title class_"),
    (Name.Decorator, "meta"),
    (Name.Entity, "symbol"),
    (String.Regex, "regexp"),
    (String.Interpol, "subst"),
    (Literal.Scalar.Plain, "string"),
    (String, "string"),
    (Number, "number"),
    (Literal.Date, "number"),
    (Generic.Inserted, "addition"),
    (Generic.Deleted, "deletion"),
    (Generic.Heading, "section"),
    (Generic.Subheading, "section"),
    (Generic.Emph, "emphasis"),
    (Generic.Strong, "strong"),
    (Token, None),
)


# ---------------------------------------------------------------------------------------------- JSON

_JSON = (
    (Name.Tag, "attr"),  # keys
    # highlight.js nests a keyword span in the literal one for true/false/null, so they take the
    # keyword colour
    (Keyword.Constant, "keyword"),
    (Punctuation, "punctuation"),
    *_BASE,
)


def _json(tokens: Tokens) -> Iterator[Piece]:
    for ttype, value in tokens:
        yield _classify(ttype, _JSON), value


# ---------------------------------------------------------------------------------------------- YAML

# highlight.js colours every C-style number in a plain scalar, so a version such as 0.0.1 is a number
_YAML_NUMBER = re.compile(r"(?:-?(?:0[xX][a-fA-F0-9]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?))+")
_YAML_LITERAL = _words("true false yes no null on off ~")
_YAML = ((Name.Tag, "attr"), (Punctuation.Indicator, None), *_BASE)


def _yaml(tokens: Tokens) -> Iterator[Piece]:
    previous: str | None = None
    for ttype, value in tokens:
        cls = _classify(ttype, _YAML)
        if ttype in Punctuation.Indicator and value.strip() == "-":
            cls = "bullet"
        elif ttype in Literal.Scalar.Plain or ttype in Name.Variable:  # plain scalars, also in [a, b]
            cls = "string"
            word = value.strip()
            if _YAML_NUMBER.fullmatch(word):
                cls = "number"
            elif word.lower() in _YAML_LITERAL:
                cls = "literal"
        elif ttype in Punctuation and value == ":" and previous == "attr":
            cls = "attr"  # highlight.js includes the colon in the key
        if value.strip():
            previous = cls
        yield cls, value


# ------------------------------------------------------------------------------------ INI, .env, TOML

# highlight.js's INI/TOML grammar colours the parts of a value: quoted strings, numbers, booleans and
# $variables; the rest of an unquoted value stays plain
_INI_VALUE = re.compile(
    r"""(?P<string>"(?:[^"\\]|\\.)*"?|'[^']*'?)"""
    r"|(?P<variable>\$\{[^}]*\}|\$[\w\"][\w]*)"
    r"|(?P<literal>\b(?:on|off|true|false|yes|no)\b)"
    r"|(?P<number>\b\d+(?:\.\d+)?)",
    re.ASCII | re.IGNORECASE,
)
_INI = ((Keyword, "section"), (Name.Attribute, "attr"), *_BASE)


def _ini_value(value: str) -> Iterator[Piece]:
    pos = 0
    for m in _INI_VALUE.finditer(value):
        if m.start() > pos:
            yield None, value[pos : m.start()]
        yield m.lastgroup, m.group()
        pos = m.end()
    if pos < len(value):
        yield None, value[pos:]


def _ini(tokens: Tokens) -> Iterator[Piece]:
    value_parts: list[str] = []  # Pygments splits a quoted value into quote, text, quote
    for ttype, value in tokens:
        if ttype in String and ttype not in String.Escape:
            value_parts.append(value)
            continue
        if value_parts:
            yield from _ini_value("".join(value_parts))
            value_parts.clear()
        yield _classify(ttype, _INI), value
    if value_parts:
        yield from _ini_value("".join(value_parts))


_TOML = ((Keyword.Constant, "literal"), (Keyword, "section"), (Name, "attr"), *_BASE)


def _toml(tokens: Tokens) -> Iterator[Piece]:
    for ttype, value in tokens:
        yield _classify(ttype, _TOML), value


# ---------------------------------------------------------------------------------------------- bash

# highlight.js's bash grammar: which words it colours, wherever they stand (outside strings, comments
# and /paths), and how it finds them
_BASH_KEYWORDS = _words("if then else elif fi time for while until in do done case esac coproc function select")
_BASH_LITERALS = _words("true false")
_BASH_BUILT_INS = _words(
    """
    break cd continue eval exec exit export getopts hash pwd readonly return shift test times trap umask
    unset alias bind builtin caller command declare echo enable help let local logout mapfile printf read
    readarray source sudo type typeset ulimit unalias set shopt autoload bg bindkey bye cap chdir clone
    comparguments compcall compctl compdescribe compfiles compgroups compquote comptags comptry
    compvalues dirs disable disown echotc echoti emulate fc fg float functions getcap getln history
    integer jobs kill limit log noglob popd print pushd pushln rehash sched setcap setopt stat suspend
    ttyctl unfunction unhash unlimit unsetopt vared wait whence where which zcompile zformat zftp zle
    zmodload zparseopts zprof zpty zregexparse zsocket zstyle ztcp chcon chgrp chown chmod cp dd df dir
    dircolors ln ls mkdir mkfifo mknod mktemp mv realpath rm rmdir shred sync touch truncate vdir b2sum
    base32 base64 cat cksum comm csplit cut expand fmt fold head join md5sum nl numfmt od paste ptx pr
    sha1sum sha224sum sha256sum sha384sum sha512sum shuf sort split sum tac tail tr tsort unexpand uniq
    wc arch basename chroot date dirname du env expr factor groups hostid id link logname nice nohup
    nproc pathchk pinky printenv readlink runcon seq sleep stdbuf stty tee timeout tty uname unlink
    uptime users who whoami yes
    """
)
_BASH_WORD = re.compile(r"(?P<path>(?:/[a-z._-]+)+)|\b[a-z][a-z0-9._-]+\b", re.ASCII)


def _bash_word_class(word: str) -> str | None:
    if word in _BASH_KEYWORDS:
        return "keyword"
    if word in _BASH_LITERALS:
        return "literal"
    if word in _BASH_BUILT_INS:
        return "built_in"
    return None


def _bash_words(value: str) -> Iterator[Piece]:
    pos = 0
    for m in _BASH_WORD.finditer(value):
        cls = None if m.group("path") else _bash_word_class(m.group())
        if cls:
            if m.start() > pos:
                yield None, value[pos : m.start()]
            yield cls, m.group()
            pos = m.end()
    if pos < len(value):
        yield None, value[pos:]


_BASH = (
    (Comment.Hashbang, "meta"),
    (Comment, "comment"),
    (String.Interpol, "variable"),  # ${ and } around a variable
    (String, "string"),
    *_BASE,
)


def _bash(tokens: Tokens) -> Iterator[Piece]:
    in_string = False  # inside "...": what Pygments splits out of the string keeps the string colour
    for i, (ttype, value) in enumerate(tokens):
        if ttype in String.Double and value == '"':
            in_string = not in_string
            yield "string", value
        elif ttype in Name.Variable:
            assignment = i + 1 < len(tokens) and tokens[i + 1][0] in Operator and tokens[i + 1][1] in ("=", "+=")
            if value.startswith("$") or (not assignment and i > 0 and tokens[i - 1][0] in String.Interpol):
                yield "variable", value
            else:
                yield ("string" if in_string else None), value
        elif ttype in String.Escape and not in_string:
            yield None, value  # a \ line continuation
        elif ttype in Comment or ttype in String:
            yield _classify(ttype, _BASH), value
        elif in_string:
            yield "string", value
        elif ttype in Keyword or ttype in Name.Builtin:
            # re-checked against highlight.js's word lists; `$(` and `)` stay plain
            yield _bash_word_class(value) if value.isalpha() else None, value
        elif ttype in Text:
            yield from _bash_words(value)
        else:
            yield None, value  # numbers, operators and punctuation are plain in highlight.js's bash


# ------------------------------------------------------------------------------- JavaScript/TypeScript

_JS_LANGUAGE_VARIABLES = _words(
    "this super arguments console window document localStorage sessionStorage module global"
)
_JS_IDENTIFIER = re.compile(r"[A-Za-z_$][\w$]*")
_JS_CLASS_NAME = re.compile(r"JSON|[A-Z][a-z]+(?:[A-Z][a-z]*|\d)*|[A-Z]{2,}[a-z]+(?:[A-Z][a-z]+|\d)*")
_JS_NUMBER = re.compile(r"(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?)n?")
_JS = ((Keyword.Constant, "literal"), (Keyword, "keyword"), (Operator.Word, "keyword"), *_BASE)


def _js_name(tokens: Tokens, i: int, before: str, after: str) -> str | None:
    """The class of a name, from what surrounds it (Pygments has one token type for all names)."""
    ttype, value = tokens[i]
    if value in _JS_LANGUAGE_VARIABLES:
        return "variable language_"
    if before == ".":
        return "title function_" if after == "(" else "property"
    if ttype in Name and _JS_CLASS_NAME.fullmatch(value):
        return "title class_"  # Promise, JSON, HashChangeEvent: highlight.js colours class names
    if ttype in Name.Builtin:
        return "built_in"  # encodeURIComponent
    if after == "(" and (ttype in Name or ttype in Keyword.Reserved):
        return "title function_"
    if ttype in Name.Other and i + 1 < len(tokens) and tokens[i + 1][1] == ":":
        return "attr"  # a key, or a parameter or variable with a type: highlight.js's `name:` rule
    return _classify(ttype, _JS)


def _js(tokens: Tokens) -> Iterator[Piece]:
    significant = [i for i, (_, value) in enumerate(tokens) if value.strip()]
    position = {index: n for n, index in enumerate(significant)}

    def neighbour(i: int, step: int) -> str:
        n = position[i] + step
        return tokens[significant[n]][1] if 0 <= n < len(significant) else ""

    template_depth = 0  # inside ${...} of a template string, plain code keeps the string colour
    for i, (ttype, value) in enumerate(tokens):
        cls = _classify(ttype, _JS)
        if ttype in String.Interpol:
            template_depth += 1 if value.startswith("$") else -1
            cls = "string"
        elif not value.strip():
            pass
        elif _JS_NUMBER.fullmatch(value):
            cls = "number"
        elif (ttype in Name or ttype in Keyword) and _JS_IDENTIFIER.fullmatch(value):
            cls = _js_name(tokens, i, neighbour(i, -1), neighbour(i, 1))
            if template_depth and cls in ("property", "attr", "title function_", "title class_", None):
                cls = "string"
        elif template_depth and cls is None:
            cls = "string"
        yield cls, value


# ------------------------------------------------------------------------------------------- XML/HTML


def _xml(tokens: Tokens) -> Iterator[Piece]:
    for ttype, value in tokens:
        if ttype in Name.Tag:
            # highlight.js colours the tag's name, not its brackets
            m = re.fullmatch(r"(</?|)([^<>/\s]*)(\s*/?>|)", value)
            if m:
                yield None, m.group(1)
                yield "name", m.group(2)
                yield None, m.group(3)
                continue
        if ttype in Name.Attribute and value.endswith("="):
            yield "attr", value[:-1]
            yield None, "="
        elif ttype in Comment.Preproc and (doctype := re.fullmatch(r"(<!\w+)(\s+)([^>]*)(>)", value)):
            yield "meta", doctype.group(1)
            yield None, doctype.group(2)
            yield "keyword", doctype.group(3)  # <!doctype html>
            yield "meta", doctype.group(4)
        elif ttype in Comment.Preproc:
            # <?xml version="1.0"?>: the quoted values keep the string colour
            for n, part in enumerate(re.split(r"(\"[^\"]*\"|'[^']*')", value)):
                yield ("string" if n % 2 else "meta"), part
        else:
            yield _classify(ttype, _BASE), value


# ------------------------------------------------------------------------------------------ Dockerfile

_NUMBER = re.compile(r"\b\d+(?:\.\d+)?")


def _numbers(value: str) -> Iterator[Piece]:
    pos = 0
    for m in _NUMBER.finditer(value):
        yield None, value[pos : m.start()]
        yield "number", m.group()
        pos = m.end()
    yield None, value[pos:]


def _docker(tokens: Tokens) -> Iterator[Piece]:
    # instructions are keywords, their plain arguments show only numbers (FROM node:24, EXPOSE 8931),
    # and the shell parts (RUN, CMD) are highlighted as bash
    shell: Tokens = []
    for ttype, value in tokens:
        if ttype in Keyword and value.isalpha() and value.isupper() and value != "AS":
            yield from _bash(shell)
            shell = []
            yield "keyword", value
        elif ttype is String:
            yield from _bash(shell)
            shell = []
            yield from _numbers(value)
        elif ttype in Name.Variable and not value.startswith("$"):
            shell.append((Text, value))  # ENV NAME=value
        else:
            shell.append((ttype, value))
    yield from _bash(shell)


_REFINERS: dict[str, Refiner] = {
    "docker": _docker,
    "json": _json,
    "yaml": _yaml,
    "ini": _ini,
    "toml": _toml,
    "bash": _bash,
    "js": _js,
    "xml": _xml,
}
