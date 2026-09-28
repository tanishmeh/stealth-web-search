"""The transcript printer and the run loop when the output itself fails (a stdout that cannot
encode the model's text, a closed pipe): the run still ends with a result, never an exception."""

from __future__ import annotations

import sys
from collections.abc import Callable

import anyio
import pytest

from sws_tools.lmstudio_agent.agent import AgentOptions, run_agent
from sws_tools.lmstudio_agent.errors import AgentError, sole_exception
from sws_tools.lmstudio_agent.output import Printer
from sws_tools.ts_server import free_port
from tests.lmstudio_agent.fakes import MODEL, FakeLmStudio


def failing_write(written: list[str]) -> Callable[[str], None]:
    def write(text: str) -> None:
        written.append(text)
        raise UnicodeEncodeError("latin-1", text, 0, 1, "ordinal not in range(256)")

    return write


def test_end_stream_does_not_write_the_line_end_again_after_a_failed_write() -> None:
    written: list[str] = []
    printer = Printer(failing_write(written), quiet=False, color=False)
    with pytest.raises(UnicodeEncodeError):
        printer.stream("thinking")
    printer._mid_line = True  # a stream chunk without a line end was written before
    with pytest.raises(UnicodeEncodeError):
        printer.end_stream()
    written.clear()
    printer.end_stream()
    assert written == [], "the pending line end was given up with the failed write"


@pytest.mark.anyio
async def test_a_failing_output_does_not_turn_the_result_into_an_exception(lms: FakeLmStudio) -> None:
    written: list[str] = []
    result = await run_agent(
        AgentOptions(
            task="anything",
            mcp_url=f"http://127.0.0.1:{free_port()}/mcp",
            lmstudio_url=lms.url,
            model=MODEL,
            client_name="lmstudio-agent-test",
            color=False,
            write=failing_write(written),
        )
    )
    assert result.ok is False
    assert result.stop_reason == "error"
    assert result.error is not None
    assert result.error.startswith("Cannot connect to the MCP server at "), result.error
    assert written, "the error was offered to the output"


@pytest.mark.anyio
async def test_sole_exception_unwraps_what_a_task_group_wrapped_and_keeps_anything_else() -> None:
    error = AgentError("one")
    assert sole_exception(error) is error
    grouped: Exception | None = None
    try:
        async with anyio.create_task_group():
            raise error
    except Exception as exc:
        grouped = exc
    assert grouped is not None
    assert grouped is not error, "anyio wraps the body's error in a group"
    assert sole_exception(grouped) is error
    if sys.version_info >= (3, 11):  # a builtin from 3.11
        two = ExceptionGroup("g", [error, ValueError("two")])  # noqa: F821
        assert sole_exception(two) is two
