"""The package installs with its console commands, and `sws-tools` reports the environment."""

from __future__ import annotations

import json
import subprocess
import sys
from importlib.metadata import entry_points

import pytest

import sws_tools
from sws_tools.cli import COMMANDS, main


def test_console_commands_are_installed_and_load() -> None:
    eps = {ep.name: ep for ep in entry_points(group="console_scripts") if ep.value.startswith("sws_tools.")}
    # a stale install (pip install -e before an entry point was added) shows up here: rerun npm run py:setup
    assert set(eps) == {"sws-tools", *COMMANDS}
    for ep in eps.values():
        assert callable(ep.load()), ep.value


@pytest.mark.parametrize("module", ["lmstudio_agent", "lmstudio_e2e", "agents_e2e", "website"])
def test_each_tool_runs_as_a_module(module: str, python_env: dict[str, str]) -> None:
    res = subprocess.run(
        [sys.executable, "-m", f"sws_tools.{module}", "--help"],
        capture_output=True,
        text=True,
        timeout=60,
        env=python_env,
    )
    # the command exists and answers; its exit code and text belong to the tool
    assert "No module named" not in res.stderr, res.stderr
    assert "Traceback" not in res.stderr, res.stderr


def test_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["--version"])
    assert exit_info.value.code == 0
    assert capsys.readouterr().out.strip() == f"stealth-web-search-tools {sws_tools.__version__}"


def test_info_names_this_interpreter(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["info"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["executable"] == sys.executable
    assert data["version"] == sws_tools.__version__
    assert "sws-lmstudio-agent" in data["commands"]


def test_usage_error_exits_2(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["--no-such-option"])
    assert exit_info.value.code == 2
    assert "unrecognized arguments: --no-such-option" in capsys.readouterr().err
