"""JavaScript string and path semantics the site builder depends on.

The builder must produce the same anchors, links and link-check results as the TypeScript version
it replaced, and a few JavaScript built-ins behave differently from their closest Python
counterparts: `decodeURI` keeps reserved escapes such as %2F, `path.posix.join` does not restart at
an absolute segment and `path.posix.normalize` keeps a trailing slash, `String.trim` and the regex
`\\s` use their own whitespace set, and `String.slice` counts UTF-16 code units.
"""

from __future__ import annotations

import re

# ECMAScript WhiteSpace and LineTerminator: what String.prototype.trim removes and what \s matches
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
JS_WHITESPACE_RUN = re.compile(f"[{JS_WHITESPACE}]+")

# characters decodeURI leaves encoded
_URI_RESERVED = frozenset(";/?:@&=+$,#")
_HEX = frozenset("0123456789abcdefABCDEF")


def js_trim(text: str) -> str:
    """String.prototype.trim."""
    return text.strip(JS_WHITESPACE)


def js_slice(text: str, end: int) -> str:
    """text.slice(0, end), which counts UTF-16 code units. A surrogate pair cut in half leaves a lone
    surrogate in JavaScript, which Node writes as U+FFFD; the replacement here gives the same bytes."""
    units = text.encode("utf-16-le")
    if len(units) <= end * 2:
        return text
    return units[: end * 2].decode("utf-16-le", errors="replace")


class URIError(ValueError):
    """A malformed percent-encoding (JavaScript throws URIError: URI malformed)."""


def _decode(text: str, reserved: frozenset[str]) -> str:
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch != "%":
            out.append(ch)
            i += 1
            continue
        start = i
        first = _hex_byte(text, i)
        i += 3
        if first < 0x80:
            char = chr(first)
            out.append(text[start:i] if char in reserved else char)
            continue
        if first & 0xE0 == 0xC0:
            length = 2
        elif first & 0xF0 == 0xE0:
            length = 3
        elif first & 0xF8 == 0xF0:
            length = 4
        else:
            raise URIError("URI malformed")
        data = bytearray([first])
        for _ in range(length - 1):
            byte = _hex_byte(text, i)
            if byte & 0xC0 != 0x80:
                raise URIError("URI malformed")
            data.append(byte)
            i += 3
        try:
            out.append(bytes(data).decode("utf-8"))  # rejects overlong forms and surrogates, like V8
        except UnicodeDecodeError:
            raise URIError("URI malformed") from None
    return "".join(out)


def _hex_byte(text: str, i: int) -> int:
    pair = text[i + 1 : i + 3]
    if text[i : i + 1] != "%" or len(pair) != 2 or not set(pair) <= _HEX:
        raise URIError("URI malformed")
    return int(pair, 16)


def decode_uri(text: str) -> str:
    """decodeURI: decodes %XX escapes except those of reserved characters (; / ? : @ & = + $ , #)."""
    return _decode(text, _URI_RESERVED)


def decode_uri_component(text: str) -> str:
    """decodeURIComponent: decodes every %XX escape."""
    return _decode(text, frozenset())


def posix_normalize(path: str) -> str:
    """Node's path.posix.normalize: resolves '.' and '..' and repeated slashes, keeps a trailing slash."""
    if not path:
        return "."
    absolute = path.startswith("/")
    trailing = path.endswith("/")
    parts: list[str] = []
    for segment in path.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if parts and parts[-1] != "..":
                parts.pop()
            elif not absolute:
                parts.append("..")
            continue
        parts.append(segment)
    result = "/".join(parts)
    if not result:
        if absolute:
            return "/"
        return "./" if trailing else "."
    if trailing:
        result += "/"
    return f"/{result}" if absolute else result


def posix_join(*paths: str) -> str:
    """Node's path.posix.join: joins the non-empty parts with '/' (an absolute part does not restart
    the path), then normalizes."""
    joined = "/".join(p for p in paths if p)
    return posix_normalize(joined) if joined else "."


def posix_dirname(path: str) -> str:
    """Node's path.posix.dirname for the relative file paths the builder uses ('docs/A.md' gives
    'docs', 'A.md' gives '.')."""
    head, sep, _ = path.rstrip("/").rpartition("/")
    if not sep:
        return "."
    return head or "/"
