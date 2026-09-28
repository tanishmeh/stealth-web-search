"""Stopping a run from outside: Ctrl+C in the CLI, a time limit in the e2e runner, a test.

The counterpart of the AbortController/AbortSignal the TypeScript host used. `abort()` must run on
the event loop's thread (a signal handler schedules it with loop.call_soon_threadsafe). Code that
waits on something the user may want to stop wraps the wait in `abortable()`: the wait is
cancelled at once and the given error is raised instead, and the run then ends as "aborted".
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

import anyio

T = TypeVar("T")


class AbortSignal:
    def __init__(self) -> None:
        self._aborted = False
        self._listeners: list[Callable[[], None]] = []

    @property
    def aborted(self) -> bool:
        return self._aborted

    def add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Call `listener` once on abort (at once when already aborted); returns a function that removes it."""
        if self._aborted:
            listener()
            return lambda: None
        self._listeners.append(listener)

        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    def _abort(self) -> None:
        if self._aborted:
            return
        self._aborted = True
        listeners, self._listeners = self._listeners, []
        for listener in listeners:
            listener()

    async def wait(self) -> None:
        """Return when the signal is aborted."""
        event = anyio.Event()
        remove = self.add_listener(event.set)
        try:
            await event.wait()
        finally:
            remove()


class AbortController:
    def __init__(self) -> None:
        self.signal = AbortSignal()

    def abort(self) -> None:
        self.signal._abort()

    def abort_after(self, seconds: float) -> asyncio.TimerHandle:
        """Abort after `seconds` (AbortSignal.timeout); cancel the returned handle to keep it running."""
        return asyncio.get_running_loop().call_later(seconds, self.abort)


async def abortable(
    signal: AbortSignal | None, wait: Callable[[], Awaitable[T]], error: Callable[[], BaseException]
) -> T:
    """Await `wait()`; when `signal` aborts first, cancel it and raise `error()`."""
    if signal is None:
        return await wait()
    if signal.aborted:
        raise error()
    with anyio.CancelScope() as scope:
        remove = signal.add_listener(scope.cancel)
        try:
            return await wait()
        finally:
            remove()
    raise error()


async def sleep(seconds: float, signal: AbortSignal | None) -> None:
    """Sleep, returning early when `signal` aborts."""
    with anyio.move_on_after(seconds) as scope:
        remove = signal.add_listener(scope.cancel) if signal is not None else lambda: None
        try:
            await anyio.sleep_forever()
        finally:
            remove()
