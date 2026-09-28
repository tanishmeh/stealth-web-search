"""HTML escaping as the site's templates and the Markdown renderer need it."""

from __future__ import annotations

import re

_ENTITY_SAFE = re.compile(r"[<>\"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)", re.ASCII)
_ALL = re.compile(r"[&<>\"']")
_REPLACEMENTS = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}
_TAG = re.compile(r"<[^>]+>")


def esc(text: str) -> str:
    """For attribute values and text in the templates (& < > and double quotes)."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def escape_text(text: str, *, entities: bool = True) -> str:
    """Document text the way the Markdown renderer escapes it (quotes as &quot; and &#39;). With
    `entities`, an '&' that starts a character reference is kept, so &copy; stays an entity."""
    pattern = _ENTITY_SAFE if entities else _ALL
    return pattern.sub(lambda m: _REPLACEMENTS[m.group()[0]], text)


def strip_tags(html: str) -> str:
    """The text of an HTML fragment: tags removed, the five basic entities decoded."""
    return (
        _TAG.sub("", html)
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&amp;", "&")
    )
