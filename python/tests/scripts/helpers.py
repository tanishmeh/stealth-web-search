"""Helpers for the tests of the standard-library scripts: the interpreters to run them with, and
importing a script as a module."""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType

SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"


def _version(python: str) -> tuple[int, int, int] | None:
    try:
        res = subprocess.run(
            [python, "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    major, minor, micro = (int(part) for part in res.stdout.strip().split("."))
    return major, minor, micro


def _system_python_usable(path: str) -> bool:
    # without the Command Line Tools, macOS's /usr/bin/python3 is a stub that opens an installer dialog
    if sys.platform != "darwin" or not path.startswith("/usr/bin/"):
        return True
    return subprocess.run(["xcode-select", "-p"], capture_output=True, check=False).returncode == 0


def script_pythons() -> list[tuple[str, str]]:
    """(id, interpreter) for each distinct Python 3.9+ version available."""
    configured = os.environ.get("SWS_SCRIPT_PYTHONS")
    candidates = (
        configured.split(os.pathsep)
        if configured
        else [sys.executable, "/usr/bin/python3", shutil.which("python3"), shutil.which("python3.9")]
    )
    found: dict[tuple[int, int, int], str] = {}
    for candidate in candidates:
        if not candidate or not Path(candidate).exists() or not _system_python_usable(candidate):
            continue
        version = _version(candidate)
        if version and version >= (3, 9) and version not in found:
            found[version] = candidate
    return [(f"py{'.'.join(map(str, v))}", python) for v, python in found.items()]


def load_script(name: str) -> ModuleType:
    """Import scripts/<name>.py as a module (it only runs main() under __main__)."""
    path = SCRIPTS_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"sws_script_{name}", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    writes, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # no __pycache__ in scripts/
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = writes
    return module
