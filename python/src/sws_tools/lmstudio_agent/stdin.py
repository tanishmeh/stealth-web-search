"""Reading the user's answers from stdin while the agent runs.

A daemon thread reads the input with os.read, so a question waiting for an answer never blocks the
event loop, Ctrl+C still works, and exiting never waits for a read that cannot be interrupted. Lines
end at \\n, \\r\\n or \\r, as in Node's readline; input is decoded as UTF-8.
"""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import os
import threading
from collections.abc import Callable

import anyio

from .abort import AbortSignal
from .output import is_terminal, write_stdout

_EOF = object()


class _LineReader:
    def __init__(self, fd: int, loop: asyncio.AbstractEventLoop) -> None:
        self._fd = fd
        self._loop = loop
        self._queue: asyncio.Queue[object] = asyncio.Queue()
        self._eof = False
        threading.Thread(target=self._read, name="stdin-reader", daemon=True).start()

    def _put(self, item: object) -> None:
        with contextlib.suppress(RuntimeError):  # the loop is closed: nobody is waiting any more
            self._loop.call_soon_threadsafe(self._queue.put_nowait, item)

    def _read(self) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        buffer = ""
        while True:
            try:
                chunk = os.read(self._fd, 65536)
            except OSError:
                chunk = b""
            buffer += decoder.decode(chunk, final=not chunk)
            while True:
                cut = min((i for i in (buffer.find("\n"), buffer.find("\r")) if i >= 0), default=-1)
                if cut < 0 or (buffer[cut] == "\r" and cut == len(buffer) - 1 and chunk):
                    break  # no line end yet, or a \r that may be the start of \r\n
                end = cut + 2 if buffer.startswith("\r\n", cut) else cut + 1
                self._put(buffer[:cut])
                buffer = buffer[end:]
            if not chunk:
                if buffer:
                    self._put(buffer)
                self._put(_EOF)
                return

    async def next_line(self) -> str | None:
        if self._eof:
            return None
        item = await self._queue.get()
        if item is _EOF:
            self._eof = True
            return None
        assert isinstance(item, str)
        return item


class StdinAsker:
    """`ask(prompt)` prints the prompt and returns the next line of stdin, or None at the end of
    the input or when `signal` aborts. Output that is not a terminal gets the line end the Enter key
    would have echoed."""

    def __init__(
        self,
        signal: AbortSignal,
        *,
        fd: int = 0,
        write: Callable[[str], None] = write_stdout,
        terminal: Callable[[], bool] = is_terminal,
    ) -> None:
        self._signal = signal
        self._fd = fd
        self._write = write
        self._terminal = terminal
        self._reader: _LineReader | None = None

    async def ask(self, prompt: str) -> str | None:
        if self._signal.aborted:
            return None
        if self._reader is None:
            self._reader = _LineReader(self._fd, asyncio.get_running_loop())
        echoed = self._terminal()
        self._write(prompt)
        line: str | None = None
        with anyio.CancelScope() as scope:
            remove = self._signal.add_listener(scope.cancel)
            try:
                line = await self._reader.next_line()
            finally:
                remove()
        if not echoed:
            # end the prompt line, as the Enter key does in a terminal (a piped answer is not echoed)
            self._write("\n")
        return line

    def close(self) -> None:
        """Nothing to release: the reader thread ends with the input or the process."""
