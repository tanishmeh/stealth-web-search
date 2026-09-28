"""The transcript printer and text helpers (colours, durations, previews)."""

from __future__ import annotations

import contextlib
import io
import os
import re
import sys
from collections.abc import Callable, Sequence

from ._js import WS, js_len, js_slice, js_to_fixed, js_trim, js_trim_end, well_formed

# Node's util.inspect.colors: (open, close) SGR codes
_CODES = {
    "bold": (1, 22),
    "dim": (2, 22),
    "red": (31, 39),
    "green": (32, 39),
    "yellow": (33, 39),
    "magenta": (35, 39),
    "cyan": (36, 39),
}

Style = str | Sequence[str]


def _replace_close(text: str, close: str, opening: str, keep_close: bool) -> str:
    # Node's replaceCloseCode: a close code inside the text re-opens the style (except at the very end)
    index = text.find(close)
    if index == -1:
        return text
    replacement = close + opening if keep_close else opening
    result: list[str] = []
    last = 0
    while index != -1:
        after = index + len(close)
        if after >= len(text):
            break
        result.append(text[last:index] + replacement)
        last = after
        index = text.find(close, last)
    return "".join(result) + text[last:]


def style_text(fmt: Style, text: str) -> str:
    """util.styleText(fmt, text) with colours on."""
    opening = ""
    closing = ""
    for key in [fmt] if isinstance(fmt, str) else fmt:
        start, end = _CODES[key]
        open_seq, close_seq = f"\x1b[{start}m", f"\x1b[{end}m"
        opening += open_seq
        closing = close_seq + closing
        text = _replace_close(text, close_seq, open_seq, start in (1, 2))
    return opening + text + closing


def stdout_color() -> bool:
    """Colour by default: stdout is a terminal and NO_COLOR is unset or empty."""
    return sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def is_terminal() -> bool:
    """Someone at a terminal: stdin to answer a question, stdout to see it."""
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except (AttributeError, ValueError):
        return False


def utf8_stdio() -> None:
    """Write UTF-8 with \\n line ends whatever the locale, as Node does (also to a file or a pipe on
    Windows), so the model's text never meets a codec that cannot encode it."""
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper) and stream in (sys.__stdout__, sys.__stderr__):
            with contextlib.suppress(ValueError, OSError):
                stream.reconfigure(encoding="utf-8", errors="replace", newline="\n")


def write_stdout(text: str) -> None:
    sys.stdout.write(well_formed(text))
    sys.stdout.flush()


def stdout_closed() -> int:
    """The reader of stdout went away (`... | head`): stop writing to it and exit quietly (code 1)."""
    with contextlib.suppress(OSError, ValueError):
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, sys.stdout.fileno())
    return 1


def write_stderr(text: str) -> None:
    sys.stderr.write(well_formed(text))
    sys.stderr.flush()


class Printer:
    """Writes the transcript. `write` replaces stdout (errors then go there too); `quiet` prints
    only what `always` and `error` write."""

    def __init__(self, write: Callable[[str], None] | None, quiet: bool, color: bool | None) -> None:
        self._custom = write is not None
        self._write = write if write is not None else write_stdout
        self.quiet = quiet
        self.color = stdout_color() if color is None else color
        self._mid_line = False

    def style(self, fmt: Style, text: str) -> str:
        return style_text(fmt, text) if self.color else text

    def line(self, text: str = "") -> None:
        if self.quiet:
            return
        self.end_stream()
        self._write(f"{text}\n")

    def stream(self, text: str) -> None:
        if self.quiet or not text:
            return
        self._write(self.style("dim", text))
        self._mid_line = not text.endswith("\n")

    def end_stream(self) -> None:
        if self._mid_line:
            # cleared first: when the write fails, the error report after it must not try again
            self._mid_line = False
            self._write("\n")

    def always(self, text: str) -> None:
        self.end_stream()
        self._write(f"{text}\n")

    def error(self, text: str) -> None:
        self.end_stream()
        if self._custom:
            self._write(f"{text}\n")
        else:
            write_stderr(f"{text}\n")


def seconds(ms: int) -> str:
    return f"{ms} ms" if ms < 1000 else f"{js_to_fixed(ms / 1000, 1)} s"


_SPACES = re.compile(f"{WS}+")


def clip_line(text: str, limit: int) -> str:
    flat = js_trim(_SPACES.sub(" ", text))
    return f"{js_slice(flat, 0, limit - 3)}..." if js_len(flat) > limit else flat


def preview(text: str, max_lines: int = 3, width: int = 160) -> list[str]:
    lines = [js_trim_end(line) for line in text.split("\n")]
    lines = [line for line in lines if js_trim(line) != ""]
    shown = [f"{js_slice(line, 0, width - 3)}..." if js_len(line) > width else line for line in lines[:max_lines]]
    if len(lines) > max_lines:
        shown.append(f"... ({len(lines) - max_lines} more lines)")
    return shown
