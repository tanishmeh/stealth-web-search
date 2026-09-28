"""The JavaScript semantics the builder keeps (checked against Node for the values below)."""

from __future__ import annotations

import pytest

from sws_tools.website.jscompat import (
    URIError,
    decode_uri,
    decode_uri_component,
    js_slice,
    js_trim,
    posix_dirname,
    posix_join,
    posix_normalize,
)


@pytest.mark.parametrize(
    ("text", "decoded"),
    [
        ("GETTING%20STARTED.md", "GETTING STARTED.md"),
        ("caf%C3%A9.md", "café.md"),
        ("%F0%9F%9A%80", "🚀"),
        ("a%2Fb%23c%3Fd%3B%40%26%3D%2B%24%2C", "a%2Fb%23c%3Fd%3B%40%26%3D%2B%24%2C"),  # reserved: kept
        ("%2f%3a", "%2f%3a"),
        ("100%25", "100%"),
        ("plain", "plain"),
    ],
)
def test_decode_uri(text: str, decoded: str) -> None:
    assert decode_uri(text) == decoded


def test_decode_uri_component_decodes_everything() -> None:
    assert decode_uri_component("a%2Fb%23c%20d") == "a/b#c d"


@pytest.mark.parametrize("text", ["%", "%zz", "%E0%A4%A", "%C3", "%C3%28", "%C0%AF", "%ED%A0%80", "%F8%80%80%80%80"])
def test_malformed_percent_encoding_raises(text: str) -> None:
    with pytest.raises(URIError):
        decode_uri(text)
    with pytest.raises(URIError):
        decode_uri_component(text)


@pytest.mark.parametrize(
    ("parts", "joined"),
    [
        (("docs", "TOOLS.md"), "docs/TOOLS.md"),
        (("docs", "../README.md"), "README.md"),
        ((".", "docs/A.md"), "docs/A.md"),
        (("docs", "../src/"), "src/"),  # a trailing slash stays
        (("docs", ""), "docs"),
        (("docs", "/abs.md"), "docs/abs.md"),  # an absolute part does not restart the path
        (("docs", "../../outside.md"), "../outside.md"),
        (("docs", "./images/./a.png"), "docs/images/a.png"),
        (("", ""), "."),
    ],
)
def test_posix_join(parts: tuple[str, str], joined: str) -> None:
    assert posix_join(*parts) == joined


@pytest.mark.parametrize(
    ("path", "normalized"),
    [("", "."), ("./", "./"), ("a//b/../c/", "a/c/"), ("/a/../..", "/"), ("../a/..", ".."), ("a/..", ".")],
)
def test_posix_normalize(path: str, normalized: str) -> None:
    assert posix_normalize(path) == normalized


@pytest.mark.parametrize(
    ("path", "dirname"), [("docs/A.md", "docs"), ("A.md", "."), ("a/b/c.md", "a/b"), ("/A.md", "/")]
)
def test_posix_dirname(path: str, dirname: str) -> None:
    assert posix_dirname(path) == dirname


def test_js_trim_uses_the_javascript_whitespace_set() -> None:
    assert js_trim("\ufeff\u00a0 x \u2028\n") == "x"
    assert js_trim("\x1cx\x1f") == "\x1cx\x1f"  # Python's str.strip() would remove these


def test_js_slice_counts_utf16_code_units() -> None:
    assert js_slice("abc", 2) == "ab"
    assert js_slice("🚀🚀", 2) == "🚀"  # one astral character is two units
    assert js_slice("a🚀", 2) == "a\ufffd"  # half a surrogate pair, as Node writes it
    assert js_slice("short", 200) == "short"
