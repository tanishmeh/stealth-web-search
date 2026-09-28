"""`sws-tools`: lists the package's commands and shows which Python runs them."""

from __future__ import annotations

import argparse
import json
import platform
import sys
from collections.abc import Sequence
from importlib.metadata import entry_points
from pathlib import Path

from . import __version__
from ._repo import find_repo_root

DIST_NAME = "stealth-web-search-tools"

COMMANDS: dict[str, str] = {
    "sws-lmstudio-agent": "LM Studio CLI agent host (npm run lmstudio:agent)",
    "sws-lmstudio-e2e": "LM Studio end-to-end scenarios (npm run lmstudio:e2e)",
    "sws-agents-e2e": "live sub-agent scenarios (npm run agents:e2e)",
    "sws-site": "website builder (npm run site:build, npm run site:serve)",
}


def installed_commands() -> list[str]:
    """Console commands this distribution declares, as installed."""
    return sorted(ep.name for ep in entry_points(group="console_scripts") if ep.value.startswith("sws_tools."))


def info() -> dict[str, object]:
    root = find_repo_root()
    return {
        "version": __version__,
        "python": platform.python_version(),
        "executable": sys.executable,
        "package": str(Path(__file__).resolve().parent),
        "repo": str(root) if root else None,
        "commands": installed_commands(),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sws-tools",
        description="Python tools for Stealth Web Search. The commands below run from npm scripts as well.",
        allow_abbrev=False,
    )
    parser.add_argument("--version", action="version", version=f"{DIST_NAME} {__version__}")
    sub = parser.add_subparsers(dest="action")
    sub.add_parser("info", help="print the interpreter, package and repository in use, as JSON")
    args = parser.parse_args(argv)

    if args.action == "info":
        print(json.dumps(info(), indent=2))
        return 0

    width = max(len(name) for name in COMMANDS)
    print(f"{DIST_NAME} {__version__}\n")
    for name, what in COMMANDS.items():
        print(f"  {name:<{width}}  {what}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
