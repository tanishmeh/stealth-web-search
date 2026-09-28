"""The JavaScript value rules the scenarios' checks and messages were written with.

The scenarios judge JSON the server returns, where a missing key (JavaScript's `undefined`) and
`null` read differently in messages, and where `String(x)`, `JSON.stringify(x)` and truthiness
decide what counts as a match. These helpers keep the checks and messages the same as in the
TypeScript runner this package replaced.
"""

from __future__ import annotations

import json
import math
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final


class _Undefined:
    """JavaScript's `undefined`: a key that is not there."""

    _instance: _Undefined | None = None

    def __new__(cls) -> _Undefined:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "undefined"

    def __bool__(self) -> bool:
        return False


UNDEFINED: Final = _Undefined()

# JavaScript's \s and String.prototype.trim() (WhiteSpace and LineTerminator)
JS_SPACE_CHARS: Final = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
JS_SPACES: Final = re.compile(f"[{JS_SPACE_CHARS}]+")


def get(obj: Any, key: str) -> Any:
    """`obj?.[key]`: UNDEFINED when obj is not an object or has no such key."""
    return obj.get(key, UNDEFINED) if isinstance(obj, dict) else UNDEFINED


def at(seq: Any, index: int) -> Any:
    """`seq?.[index]` for an array."""
    return seq[index] if isinstance(seq, list) and 0 <= index < len(seq) else UNDEFINED


def nullish(value: Any) -> bool:
    return value is None or value is UNDEFINED


def coalesce(value: Any, default: Any) -> Any:
    """`value ?? default`."""
    return default if nullish(value) else value


def truthy(value: Any) -> bool:
    """JavaScript truthiness: empty arrays and objects are true, 0, NaN and "" are false."""
    if nullish(value) or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    if isinstance(value, str):
        return value != ""
    return True


def number_string(value: float) -> str:
    """String(number) for the cases that come up here (integral floats print without ".0")."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    return repr(value)


def js_string(value: Any) -> str:
    """`String(value)`."""
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        return number_string(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join("" if nullish(v) else js_string(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def strip_undefined(value: Any) -> Any:
    """The value as JSON.stringify sees it: object keys whose value is undefined are dropped, undefined
    array items become null, and integral floats are plain integers (JavaScript has one number type)."""
    if isinstance(value, dict):
        return {k: strip_undefined(v) for k, v in value.items() if v is not UNDEFINED}
    if isinstance(value, list):
        return [None if v is UNDEFINED else strip_undefined(v) for v in value]
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return int(value)
    return value


def _json_default(value: Any) -> Any:
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def stringify(value: Any) -> str:
    """`JSON.stringify(value)` as it reads in a message (undefined prints as "undefined")."""
    if value is UNDEFINED:
        return "undefined"
    return json.dumps(strip_undefined(value), ensure_ascii=False, separators=(",", ":"), default=_json_default)


def trim(text: str) -> str:
    return text.strip(JS_SPACE_CHARS)


def to_fixed(value: float, digits: int) -> str:
    """`Number.prototype.toFixed`: rounds half away from zero on the exact binary value."""
    if not math.isfinite(value):
        return number_string(value)
    quantum = Decimal(1).scaleb(-digits)
    return str(Decimal(value).quantize(quantum, rounding=ROUND_HALF_UP))
