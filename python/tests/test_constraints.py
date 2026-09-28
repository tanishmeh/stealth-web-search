"""python/constraints.txt (what `npm run py:setup` installs without uv) pins exactly what uv.lock does."""

from __future__ import annotations

import re
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]


def _name(raw: str) -> str:
    return re.sub(r"[-_.]+", "-", raw).lower()


def locked() -> set[tuple[str, str]]:
    text = (PYTHON_DIR / "uv.lock").read_text(encoding="utf-8")
    packages = re.findall(r'^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"', text, re.M)
    return {(_name(name), version) for name, version in packages}


def constrained() -> set[tuple[str, str]]:
    text = (PYTHON_DIR / "constraints.txt").read_text(encoding="utf-8")
    pins = re.findall(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)", text, re.M)
    return {(_name(name), version) for name, version in pins}


def test_constraints_match_the_lock() -> None:
    lock = locked()
    pins = constrained()
    assert pins, "constraints.txt pins nothing"
    project = {p for p in lock if p[0] == "stealth-web-search-tools"}
    assert pins == lock - project, (
        "python/constraints.txt is out of date: run `uv export --project python --locked --extra dev --no-hashes "
        "--no-emit-project -o python/constraints.txt` from the repository root"
    )
