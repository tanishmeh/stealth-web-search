"""Process shutdown for the commands that load the MCP SDK."""

from __future__ import annotations

import atexit
import gc

_registered = False


def skip_final_collection() -> None:
    """Freeze every object at exit, so Python's shutdown does not garbage-collect them one by one.

    Importing the MCP SDK builds a large graph of pydantic models; collecting it at shutdown kept
    the process alive about 45 ms after the command had finished. Nothing in it needs finalizing:
    the commands close their files and connections themselves, and Python still flushes stdout
    and stderr. Registered once per process, so calling it again (tests run `main` many times) is
    harmless.
    """
    global _registered
    if not _registered:
        atexit.register(gc.freeze)
        _registered = True
