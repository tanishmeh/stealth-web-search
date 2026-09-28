"""Command line of `sws-agents-e2e` (`npm run agents:e2e`): live checks of the sub-agents with the
model the server is configured with (AGENT_LLM_URL or config/models.json on the server).

    npm run agents:e2e                                    # all scenarios against http://127.0.0.1:8931/mcp
    npm run agents:e2e -- --only automate --repeat 3
    MCP_URL=http://127.0.0.1:8931/mcp AUTH_TOKEN=... npm run agents:e2e -- --json results.json

The scenarios (run, automate, find, parallel) are described in `sws_tools.agents_e2e.scenarios`.
Exit codes: 0 every scenario passed, 1 a scenario failed or the server could not be used,
2 a usage error or a server without the agent tools, 130 interrupted.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
import sys
import traceback
from collections.abc import Sequence
from typing import NoReturn

from .._shutdown import skip_final_collection
from .runner import Options, error_message, first_error, leaf_errors, run
from .scenarios import SCENARIOS

PROG = "agents-e2e"
DEFAULT_MCP_URL = "http://127.0.0.1:8931/mcp"
USAGE = (
    "Usage: npm run agents:e2e -- [--only run,automate,find,parallel] [--repeat N] [--mcp-url URL] [--json FILE]\n"
    "   or: sws-agents-e2e [--only ...] [--repeat N] [--mcp-url URL] [--json FILE]"
)


class UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise UsageError(message)


def parse(argv: Sequence[str]) -> Options | None:
    """The options, or None for --help. Raises UsageError."""
    parser = _Parser(prog=PROG, add_help=False, allow_abbrev=False)
    parser.add_argument("--only")
    parser.add_argument("--repeat")
    parser.add_argument("--mcp-url")
    parser.add_argument("--json")
    parser.add_argument("-h", "--help", action="store_true")
    args = parser.parse_args(list(argv))
    if args.help:
        return None
    only = [s.strip() for s in args.only.split(",")] if args.only else list(SCENARIOS)
    unknown = [s for s in only if s not in SCENARIOS]
    if unknown:
        raise UsageError(f"Unknown scenario(s): {', '.join(unknown)}. Available: {', '.join(SCENARIOS)}")
    repeat = 1
    if args.repeat is not None:
        try:
            repeat = max(1, int(args.repeat.strip()))
        except ValueError:
            raise UsageError(f'--repeat must be a whole number, got "{args.repeat}"') from None
    mcp_url = args.mcp_url or os.environ.get("MCP_URL") or DEFAULT_MCP_URL
    return Options(only=only, repeat=repeat, mcp_url=mcp_url, json_file=args.json)


def _interrupted(err: BaseException) -> bool:
    return any(isinstance(e, KeyboardInterrupt) for e in leaf_errors(err))


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command with `argv` (default: sys.argv[1:]) and return the process exit code."""
    for stream in (sys.stdout, sys.stderr):
        # page and model text in the messages must not stop the run on a console that cannot show it
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(errors="backslashreplace")
    try:
        options = parse(sys.argv[1:] if argv is None else argv)
    except UsageError as err:
        message = str(err)
        # argparse's own messages get the usage text, like Node's parseArgs errors did
        print(message if message.startswith("Unknown scenario") else f"{message}\n\n{USAGE}", file=sys.stderr)
        return 2
    if options is None:
        print(USAGE)
        return 0
    skip_final_collection()
    try:
        return asyncio.run(run(options))
    except KeyboardInterrupt:
        print(file=sys.stderr)
        return 130
    except BaseException as err:
        if _interrupted(err):
            print(file=sys.stderr)
            return 130
        leaf = first_error(err)
        if isinstance(leaf, (OSError, TimeoutError)) or type(leaf).__module__.split(".")[0] in ("httpx2", "mcp"):
            print(f"{PROG}: cannot use the MCP server at {options.mcp_url}: {error_message(err)}", file=sys.stderr)
        else:
            print(f"{PROG}: {''.join(traceback.format_exception(leaf)).rstrip()}", file=sys.stderr)
        return 1
