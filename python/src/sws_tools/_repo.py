"""Locating the Stealth Web Search repository checkout the tools work on."""

from __future__ import annotations

import json
import os
from pathlib import Path

PACKAGE_NAME = "stealth-web-search"


def _is_repo_root(path: Path) -> bool:
    try:
        data = json.loads((path / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("name") == PACKAGE_NAME


def find_repo_root(start: Path | None = None) -> Path | None:
    """The repository root: $SWS_REPO_ROOT, else the nearest ancestor of `start` (default: the
    working directory) or of this package that holds the project's package.json. None when the
    package runs without a checkout (for example installed with uvx)."""
    override = os.environ.get("SWS_REPO_ROOT")
    if override:
        root = Path(override).resolve()
        return root if _is_repo_root(root) else None
    for base in (start or Path.cwd(), Path(__file__)):
        base = base.resolve()
        for candidate in (base, *base.parents):
            if _is_repo_root(candidate):
                return candidate
    return None


def repo_root(start: Path | None = None) -> Path:
    """Like find_repo_root, but raises when there is no checkout."""
    root = find_repo_root(start)
    if root is None:
        raise RuntimeError(
            "Cannot find the stealth-web-search repository (a folder whose package.json is named "
            f"{PACKAGE_NAME!r}). Run from inside the checkout or set SWS_REPO_ROOT."
        )
    return root
