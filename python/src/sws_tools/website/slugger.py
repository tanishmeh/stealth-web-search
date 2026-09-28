"""GitHub's heading anchors, so links such as CONFIGURATION.md#sub-agents keep working on the site."""

from __future__ import annotations

import unicodedata

from .jscompat import js_trim


def _kept(ch: str) -> bool:
    # the TypeScript builder removed /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu (the re module has no \p{...})
    if ch in "- ":
        return True
    category = unicodedata.category(ch)
    return category[0] in "LMN" or category == "Pc"


class Slugger:
    """Heading ids for one page: lower case, punctuation removed, spaces as '-', and '-1', '-2', ...
    appended to repeats."""

    def __init__(self) -> None:
        self._seen: dict[str, int] = {}

    def __call__(self, text: str) -> str:
        base = "".join(ch for ch in js_trim(text.lower()) if _kept(ch)).replace(" ", "-")
        n = self._seen.get(base, 0)
        self._seen[base] = n + 1
        return f"{base}-{n}" if n else base
