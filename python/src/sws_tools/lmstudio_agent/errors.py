"""Errors with a message meant for the user."""

from __future__ import annotations

import errno


class AgentError(Exception):
    """An error whose message is shown as is (no stack trace). `transient`: worth retrying."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.transient = transient


class HttpStatusError(AgentError):
    """LM Studio answered with an HTTP error (or sent an error event in the stream)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def exception_leaves(exc: BaseException, *, causes: bool = False) -> list[BaseException]:
    """The exceptions inside a (nested) exception group; with `causes`, also each one's __cause__ chain."""
    inner = getattr(exc, "exceptions", None)
    if isinstance(inner, tuple):  # BaseExceptionGroup (a builtin from Python 3.11)
        return [leaf for e in inner if isinstance(e, BaseException) for leaf in exception_leaves(e, causes=causes)]
    leaves = [exc]
    if causes and exc.__cause__ is not None:
        leaves.extend(exception_leaves(exc.__cause__, causes=True))
    return leaves


def sole_exception(exc: BaseException) -> BaseException:
    """The one exception inside a (nested) exception group, or `exc` itself. anyio's task groups wrap
    whatever their body raises in a group, even a lone error meant for the user."""
    leaves = exception_leaves(exc)
    return leaves[0] if len(leaves) == 1 else exc


def error_message(exc: BaseException) -> str:
    """A one-line description of a (possibly grouped) exception."""
    leaf = exception_leaves(exc)[0]
    return str(leaf) or type(leaf).__name__


def error_code(exc: BaseException) -> str | None:
    """The errno name (ECONNREFUSED, ...) behind a network error, as Node reports it in err.code;
    ETIMEDOUT for a timeout."""
    seen: set[int] = set()
    stack: list[BaseException] = [exc]
    while stack:
        current = stack.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        code = current.errno if isinstance(current, OSError) else None
        if isinstance(code, int) and code in errno.errorcode:
            return errno.errorcode[code]
        if isinstance(current, TimeoutError) or type(current).__name__.endswith("Timeout"):
            return "ETIMEDOUT"
        inner = getattr(current, "exceptions", None)
        if isinstance(inner, tuple):
            stack.extend(e for e in inner if isinstance(e, BaseException))
        stack.extend(e for e in (current.__cause__, current.__context__) if e is not None)
    return None
