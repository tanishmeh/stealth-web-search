"""Command line of `sws-lmstudio-agent` (npm run lmstudio:agent): a local LM Studio model as a
browser agent against the Stealth Web Search server.

In a terminal it is interactive: when the model ends its turn while a sub-agent run it started
waits for an answer (a purchase the task did not approve), it asks you and hands your reply back to
the model (--no-interactive turns this off).
"""

from __future__ import annotations

import contextlib
import dataclasses
import logging
import math
import os
import signal
import sys
import traceback
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .._shutdown import skip_final_collection
from ._args import Option, ParseArgsError, parse_args
from ._js import js_json, js_number, js_number_to_string, js_trim
from .errors import AgentError
from .options import DEFAULT_LMSTUDIO_URL, DEFAULT_MCP_URL, REASONING_MODES, AgentOptions
from .output import is_terminal, stdout_closed, utf8_stdio, write_stderr, write_stdout

if TYPE_CHECKING:
    import asyncio

    from .abort import AbortController
    from .agent import AgentResult

USAGE = f"""Usage: npm run lmstudio:agent -- "task" [options]
       sws-lmstudio-agent "task" [options]

Runs a local LM Studio model as a browser agent against the Stealth Web Search server.

Options:
  --model <id>             LM Studio model (default: LMSTUDIO_MODEL, else the first loaded tool-use LLM)
  --max-steps <n>          model rounds before giving up (default 25)
  --reasoning <mode>       none | low | medium | high | on (default low; "on" keeps the model default)
  --tools <a,b,...>        only offer these tools
  --toolsets <g,...>       only offer tools from these groups (or tool names): core, content, forms, tabs, state, debug, capture, agents, scripts, snapshots, or all
  --no-vision              never send screenshots to the model as images
  --interactive            ask you when a sub-agent run waits for your answer, e.g. to approve a purchase
                           (default: on when stdin and stdout are a terminal and --quiet is not set)
  --no-interactive         never ask: an order the task did not approve is refused and left for you to place
  --json <file>            write the full transcript as JSON
  --quiet                  print only the final answer
  --temperature <t>        sampling temperature (default 0.2)
  --max-tokens <n>         output token limit per model response (default 8192)
  --max-result-chars <n>   truncate tool results to this many characters (default 12000)
  --instructions <text>    extra system prompt instructions
  --mcp-url <url>          MCP endpoint (default MCP_URL or {DEFAULT_MCP_URL})
  --lmstudio-url <url>     LM Studio server (default LMSTUDIO_URL or {DEFAULT_LMSTUDIO_URL})
  -h, --help

Environment: MCP_URL, AUTH_TOKEN (MCP server token), LMSTUDIO_URL, LM_API_TOKEN, LMSTUDIO_MODEL, NO_COLOR.
Exit codes: 0 final answer, 1 error, 2 usage error, 3 step limit reached, 130 interrupted."""

OPTIONS: dict[str, Option] = {
    "model": Option("string"),
    "max-steps": Option("string"),
    "reasoning": Option("string"),
    "tools": Option("string"),
    "toolsets": Option("string"),
    "no-vision": Option("boolean"),
    "vision": Option("boolean"),
    "interactive": Option("boolean"),
    "no-interactive": Option("boolean"),
    "json": Option("string"),
    "quiet": Option("boolean", short="q"),
    "temperature": Option("string"),
    "max-tokens": Option("string"),
    "max-result-chars": Option("string"),
    "instructions": Option("string"),
    "mcp-url": Option("string"),
    "lmstudio-url": Option("string"),
    "help": Option("boolean", short="h"),
}


class UsageError(AgentError):
    """A command-line mistake (exit code 2); `show_usage` adds the usage text."""

    def __init__(self, message: str, show_usage: bool) -> None:
        super().__init__(message)
        self.show_usage = show_usage


@dataclass
class CliArgs:
    help: bool
    interactive: bool
    """Ask the user when a sub-agent run waits for an answer (main adds the ask callback)."""
    options: AgentOptions
    json: str | None = None
    """Where to write the JSON transcript."""


def _csv(value: str | None) -> list[str] | None:
    if value is None:
        return None
    items = [js_trim(s) for s in value.split(",")]
    items = [s for s in items if s]
    return items or None


def _integral(n: float) -> float | int:
    # JavaScript has one number type: 12 and 12.0 are the same value and print as 12
    return int(n) if n.is_integer() and abs(n) < 2**53 else n


def _number_option(name: str, value: str | None, minimum: float) -> float | int | None:
    if value is None:
        return None
    n = js_number(value)
    if not math.isfinite(n) or n < minimum:
        raise AgentError(f'--{name} must be a number >= {js_number_to_string(minimum)}, got "{value}"')
    return _integral(n)


def _str(values: Mapping[str, str | bool], name: str) -> str | None:
    value = values.get(name)
    return value if isinstance(value, str) else None


def parse_cli(argv: Sequence[str], env: Mapping[str, str] | None = None, terminal: bool | None = None) -> CliArgs:
    """Parse the command line. `terminal` (stdin and stdout are both a terminal) decides the default
    of --interactive; by default it is checked on the real streams."""
    env = os.environ if env is None else env
    try:
        values, positionals = parse_args(argv, OPTIONS, allow_positionals=True)
    except ParseArgsError as exc:
        raise UsageError(str(exc), True) from exc
    task = js_trim(" ".join(positionals))
    if values.get("help"):
        return CliArgs(help=True, interactive=False, options=AgentOptions(task=task))
    if not task:
        raise UsageError("Missing task.", True)
    reasoning = _str(values, "reasoning")
    try:
        if reasoning and reasoning not in REASONING_MODES:
            raise AgentError(f"--reasoning must be one of {', '.join(REASONING_MODES)}")
        model = _str(values, "model")
        mcp_url = _str(values, "mcp-url")
        lmstudio_url = _str(values, "lmstudio-url")
        options = AgentOptions(
            task=task,
            model=model if model is not None else env.get("LMSTUDIO_MODEL"),
            max_steps=_number_option("max-steps", _str(values, "max-steps"), 1),
            reasoning=reasoning,
            tools=_csv(_str(values, "tools")),
            toolsets=_csv(_str(values, "toolsets")),
            vision=False if values.get("no-vision") else True if values.get("vision") else None,
            quiet=True if values.get("quiet") else None,
            temperature=_number_option("temperature", _str(values, "temperature"), 0),
            max_tokens=_number_option("max-tokens", _str(values, "max-tokens"), 64),
            max_result_chars=_number_option("max-result-chars", _str(values, "max-result-chars"), 500),
            instructions=_str(values, "instructions"),
            mcp_url=mcp_url if mcp_url is not None else env.get("MCP_URL"),
            lmstudio_url=lmstudio_url if lmstudio_url is not None else env.get("LMSTUDIO_URL"),
            auth_token=env.get("AUTH_TOKEN"),
            lm_api_token=env.get("LM_API_TOKEN"),
        )
    except AgentError as exc:
        raise UsageError(exc.message, False) from exc
    # nobody to answer a prompt when stdin is not a terminal, nobody sees it when stdout goes to a file
    # or a pipe, and --quiet wants only the final answer
    if values.get("no-interactive"):
        interactive = False
    elif values.get("interactive"):
        interactive = True
    else:
        interactive = (is_terminal() if terminal is None else terminal) and not values.get("quiet")
    return CliArgs(help=False, interactive=interactive, json=_str(values, "json"), options=options)


def transcript(options: AgentOptions, interactive: bool, result: AgentResult) -> dict[str, Any]:
    """The --json file: the task, the command-line options (never the tokens) and the result."""
    fields: dict[str, Any] = {
        "task": options.task,
        "model": options.model,
        "maxSteps": options.max_steps,
        "reasoning": options.reasoning,
        "tools": options.tools,
        "toolsets": options.toolsets,
        "vision": options.vision,
        "quiet": options.quiet,
        "temperature": options.temperature,
        "maxTokens": options.max_tokens,
        "maxResultChars": options.max_result_chars,
        "instructions": options.instructions,
        "mcpUrl": options.mcp_url,
        "lmstudioUrl": options.lmstudio_url,
    }
    cli_options = {k: v for k, v in fields.items() if v is not None}
    cli_options["interactive"] = interactive
    return {"task": options.task, "options": cli_options, **result.to_json()}


def exit_code(result: AgentResult) -> int:
    if result.ok:
        return 0
    return {"max_steps": 3, "aborted": 130}.get(result.stop_reason, 1)


def _quiet_sdk_logs() -> None:
    # the MCP SDK logs recoverable problems (e.g. a failed session DELETE) as warnings; the
    # transcript already says what matters
    for name in ("mcp", "httpx2", "httpcore2"):
        logging.getLogger(name).addHandler(logging.NullHandler())


def _install_sigint(loop: asyncio.AbstractEventLoop, controller: AbortController) -> Callable[[], None]:
    """First Ctrl+C: stop the run (it ends as "aborted", exit 130). Second: exit 130 at once.
    Returns the function that puts the previous handling back."""
    interrupted = False

    def on_sigint() -> None:
        nonlocal interrupted
        if interrupted:
            for stream in (sys.stdout, sys.stderr):
                with contextlib.suppress(Exception):
                    stream.flush()
            os._exit(130)
        interrupted = True
        write_stderr("\nInterrupted; stopping...\n")
        controller.abort()

    try:
        loop.add_signal_handler(signal.SIGINT, on_sigint)
    except (NotImplementedError, RuntimeError, ValueError):
        # Windows: no loop signal handlers; hand the signal over to the loop thread
        previous = signal.signal(signal.SIGINT, lambda _sig, _frame: loop.call_soon_threadsafe(on_sigint))

        def restore_handler() -> None:
            signal.signal(signal.SIGINT, previous)

        return restore_handler

    def remove_handler() -> None:
        loop.remove_signal_handler(signal.SIGINT)

    return remove_handler


async def _run(cli: CliArgs) -> AgentResult:
    # imported here: the MCP SDK takes a few hundred ms to import, which --help and usage errors skip
    import asyncio

    from .abort import AbortController
    from .agent import run_agent
    from .stdin import StdinAsker

    controller = AbortController()
    restore = _install_sigint(asyncio.get_running_loop(), controller)
    try:
        asker = StdinAsker(controller.signal) if cli.interactive else None
        run_options = dataclasses.replace(cli.options, ask=asker.ask if asker else None, signal=controller.signal)
        try:
            return await run_agent(run_options)
        finally:
            if asker:
                asker.close()
    finally:
        restore()


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command with `argv` (default: sys.argv[1:]) and return the process exit code."""
    try:
        utf8_stdio()
        try:
            cli = parse_cli(sys.argv[1:] if argv is None else argv)
        except UsageError as exc:
            write_stderr(f"{exc.message}\n\n{USAGE}\n" if exc.show_usage else f"{exc.message}\n")
            return 2
        if cli.help:
            write_stdout(f"{USAGE}\n")
            return 0
        _quiet_sdk_logs()
        skip_final_collection()
        import asyncio

        result = asyncio.run(_run(cli))
        if cli.json:
            with open(cli.json, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(f"{js_json(transcript(cli.options, cli.interactive, result), 2)}\n")
            if not cli.options.quiet:
                write_stdout(f"Transcript written to {cli.json}\n")
        return exit_code(result)
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        return stdout_closed()
    except Exception as exc:
        write_stderr(f"fatal: {''.join(traceback.format_exception(exc)).rstrip()}\n")
        return 1
