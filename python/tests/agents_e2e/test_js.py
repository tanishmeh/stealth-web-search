"""The JavaScript value rules the scenario checks rely on."""

from __future__ import annotations

import math
from typing import Any

import pytest

from sws_tools.agents_e2e.js import (
    UNDEFINED,
    at,
    coalesce,
    get,
    js_string,
    stringify,
    strip_undefined,
    to_fixed,
    truthy,
)


@pytest.mark.parametrize(
    ("value", "text"),
    [(1.25, "1.3"), (0.05, "0.1"), (0.25, "0.3"), (1.0, "1.0"), (0.04, "0.0"), (12.345, "12.3"), (math.nan, "NaN")],
)
def test_to_fixed_rounds_like_javascript(value: float, text: str) -> None:
    # (ms / 1000).toFixed(1): half away from zero on the exact binary value, where Python's format rounds to even
    assert to_fixed(value, 1) == text


def test_string_and_stringify() -> None:
    assert js_string(UNDEFINED) == "undefined"
    assert js_string(None) == "null"
    assert js_string(True) == "true"
    assert js_string(3.0) == "3"
    assert js_string(51.77) == "51.77"
    assert js_string([1, None, "a"]) == "1,,a"
    assert js_string({"a": 1}) == "[object Object]"
    assert stringify(UNDEFINED) == "undefined"
    assert stringify("£51.77") == '"£51.77"'
    assert stringify({"a": UNDEFINED, "b": [UNDEFINED, 2.0]}) == '{"b":[null,2]}'
    assert stringify(2.0) == "2"
    assert strip_undefined({"x": UNDEFINED, "y": {"z": UNDEFINED}}) == {"y": {}}


def test_truthiness_and_access() -> None:
    true_values: list[Any] = [[], {}, "0", 1, -1.5]
    assert [truthy(v) for v in true_values] == [True] * 5
    assert [truthy(v) for v in (None, UNDEFINED, False, 0, 0.0, "", math.nan)] == [False] * 7
    assert get({"a": None}, "a") is None
    assert get({"a": 1}, "b") is UNDEFINED
    assert get(["a"], "0") is UNDEFINED
    assert at([1, 2], 1) == 2
    assert at([1, 2], 2) is UNDEFINED
    assert at(UNDEFINED, 0) is UNDEFINED
    assert coalesce(UNDEFINED, "?") == "?"
    assert coalesce(0, "?") == 0
