"""Fixtures for the standard-library scripts (scripts/setup_lmstudio.py, scripts/download_obscura.py).

Tests that take `script_python` run once per Python 3.9+ interpreter found: this venv's, the
system python3 (3.9 on macOS), and whatever else $SWS_SCRIPT_PYTHONS lists (os.pathsep-separated),
since the scripts promise to work on all of them.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from tests.scripts.helpers import script_pythons

_PYTHONS = script_pythons()


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "script_python" in metafunc.fixturenames:
        metafunc.parametrize("script_python", [p for _, p in _PYTHONS], ids=[i for i, _ in _PYTHONS])


@pytest.fixture
def script_env(tmp_path: Path) -> dict[str, str]:
    """A clean environment for running a script: no token or settings from the developer's shell,
    a scratch HOME, and no .pyc files written next to the scripts."""
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("GITHUB_TOKEN", "OBSCURA_VERSION", "OBSCURA_VARIANT", "OBSCURA_API_URL", "LMSTUDIO_HOME")
    }
    home = tmp_path / "home"
    home.mkdir()
    env.update(HOME=str(home), USERPROFILE=str(home), PYTHONDONTWRITEBYTECODE="1")
    return env
