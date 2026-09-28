"""JavaScript-compatible string, number and JSON helpers.

The agent host started as a TypeScript program, and what it sends to the model, prints and writes
to transcripts must stay the same. JavaScript differs from Python in ways that change that output:

- string length and slicing count UTF-16 code units (an emoji is 2), not code points;
- trim() and the regex class \\s use their own whitespace set (U+FEFF yes, U+001C-U+001F and U+0085 no);
- JSON.stringify writes no spaces, keeps non-ASCII characters, puts integer-like object keys first,
  prints 1.0 as 1 and 0.00001 as 0.00001, and escapes lone surrogates;
- Number("0x10") is 16, Number("") is 0, Math.round rounds halves up and toFixed(1) rounds 1.25 to 1.3.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

# JavaScript WhiteSpace and LineTerminator code points (the set trim() removes and \s matches)
JS_WS = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
WS = f"[{JS_WS}]"
"""A regex class for JavaScript's \\s."""

_TRIM_START = re.compile(f"^{WS}+")
_TRIM_END = re.compile(f"{WS}+$")
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_MAX_SAFE_INTEGER = 2**53 - 1


def js_trim(text: str) -> str:
    """String.prototype.trim()."""
    return _TRIM_END.sub("", _TRIM_START.sub("", text))


def js_trim_end(text: str) -> str:
    """String.prototype.trimEnd()."""
    return _TRIM_END.sub("", text)


def js_len(text: str) -> int:
    """String length in UTF-16 code units."""
    if text.isascii():
        return len(text)
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _clamp_index(value: float, length: int) -> int:
    if math.isnan(value):
        return 0
    if value < 0:
        return max(length + math.ceil(value), 0) if value != -math.inf else 0
    return min(math.floor(value), length) if value != math.inf else length


def js_slice(text: str, start: float, end: float | None = None) -> str:
    """String.prototype.slice(start, end) in UTF-16 code units (may leave a lone surrogate, as JS does)."""
    if text.isascii():
        length = len(text)
        return text[_clamp_index(start, length) : length if end is None else _clamp_index(end, length)]
    units = text.encode("utf-16-le", "surrogatepass")
    length = len(units) // 2
    lo = _clamp_index(start, length)
    hi = length if end is None else _clamp_index(end, length)
    if hi <= lo:
        return ""
    return units[2 * lo : 2 * hi].decode("utf-16-le", "surrogatepass")


def well_formed(text: str) -> str:
    """Replace lone surrogates with U+FFFD, as Node does when it writes a string as UTF-8."""
    return _LONE_SURROGATE.sub("\ufffd", text) if not text.isascii() else text


def js_round(value: float) -> int:
    """Math.round: halves round up (toward +Infinity)."""
    lower = math.floor(value)
    return lower + 1 if value - lower >= 0.5 else lower


def js_to_fixed(value: float, digits: int) -> str:
    """Number.prototype.toFixed(digits) for values below 1e21 (rounds the exact binary value half up)."""
    if not math.isfinite(value) or abs(value) >= 1e21:
        return js_number_to_string(value)
    if value == 0:
        value = 0.0  # -0 prints as 0
    return f"{Decimal(value).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP):f}"


def js_number_to_string(value: float | int) -> str:
    """Number.prototype.toString() (and how JSON.stringify writes a number)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) <= _MAX_SAFE_INTEGER:
            return str(value)
        value = float(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    sign, digit_tuple, exponent = Decimal(repr(value)).normalize().as_tuple()
    assert isinstance(exponent, int)
    digits = "".join(map(str, digit_tuple))
    k = len(digits)
    n = exponent + k
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        out = "0." + "0" * -n + digits
    else:
        e = n - 1
        out = digits[0] + (f".{digits[1:]}" if k > 1 else "") + f"e{'+' if e >= 0 else '-'}{abs(e)}"
    return f"-{out}" if sign else out


# ASCII digits only: Number() takes no other digits, and no "_" separators
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_PREFIXED = re.compile(r"0(?:[xX](?P<x>[0-9a-fA-F]+)|[oO](?P<o>[0-7]+)|[bB](?P<b>[01]+))")
_RADIX = {"x": 16, "o": 8, "b": 2}


def js_number(text: str) -> float:
    """Number(string): trims JS whitespace, "" is 0, accepts 0x/0o/0b and [+-]Infinity; NaN otherwise."""
    s = js_trim(text)
    if s == "":
        return 0.0
    if _DECIMAL.fullmatch(s):
        return float(s)
    if s in ("Infinity", "+Infinity"):
        return math.inf
    if s == "-Infinity":
        return -math.inf
    prefixed = _PREFIXED.fullmatch(s)
    if prefixed:
        radix = next(name for name, digits in prefixed.groupdict().items() if digits)
        try:
            return float(int(prefixed[radix], _RADIX[radix]))
        except OverflowError:  # beyond the largest double, as Number("0x" + "f".repeat(300))
            return math.inf
    return math.nan


def js_truthy(value: Any) -> bool:
    """JavaScript truthiness for JSON-shaped values: {} and [] are true; "", 0, NaN and null are false."""
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return value != ""
    if isinstance(value, (int, float)):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    return True


def js_string(value: Any) -> str:
    """String(value) for JSON-shaped values."""
    if value is None:
        return "null"
    if isinstance(value, str):
        return value
    if isinstance(value, (bool, int, float)):
        return js_number_to_string(value)
    if isinstance(value, (list, tuple)):
        return ",".join("" if v is None else js_string(v) for v in value)
    if isinstance(value, Mapping):
        return "[object Object]"
    return str(value)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


def js_parse(text: str) -> Any:
    """JSON.parse: like json.loads, but NaN and Infinity are not JSON."""
    return json.loads(text, parse_constant=_reject_constant)


def _quote(text: str) -> str:
    quoted = json.dumps(text, ensure_ascii=False)
    if quoted.isascii():
        return quoted
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", quoted)


def is_array_index(key: str) -> bool:
    """A key JSON.stringify writes before the others (a canonical array index)."""
    return key.isascii() and key.isdigit() and (key == "0" or key[0] != "0") and int(key) < 4294967295


def _key_order(obj: Mapping[str, Any]) -> list[str]:
    indices = [k for k in obj if is_array_index(k)]
    if not indices:
        return list(obj)
    indices.sort(key=int)
    return indices + [k for k in obj if not is_array_index(k)]


def _encode(value: Any, indent: str | None, current: str) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, int):
        return js_number_to_string(value)
    if isinstance(value, float):
        return js_number_to_string(value) if math.isfinite(value) else "null"
    if isinstance(value, Mapping):
        keys = _key_order(value)
        if not keys:
            return "{}"
        if indent is None:
            return "{" + ",".join(f"{_quote(str(k))}:{_encode(value[k], None, '')}" for k in keys) + "}"
        inner = current + indent
        body = ",\n".join(f"{inner}{_quote(str(k))}: {_encode(value[k], indent, inner)}" for k in keys)
        return "{\n" + body + "\n" + current + "}"
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        if not value:
            return "[]"
        if indent is None:
            return "[" + ",".join(_encode(v, None, "") for v in value) + "]"
        inner = current + indent
        body = ",\n".join(f"{inner}{_encode(v, indent, inner)}" for v in value)
        return "[\n" + body + "\n" + current + "]"
    raise TypeError(f"cannot serialize {type(value).__name__} as JSON")


def js_json(value: Any, indent: int | None = None) -> str:
    """JSON.stringify(value) (indent: JSON.stringify(value, null, indent))."""
    return _encode(value, None if indent is None else " " * indent, "")
