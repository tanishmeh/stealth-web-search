"""Start the TypeScript MCP server (`node src/main.ts`) as a child process.

The Python counterpart of test/helpers/harness.ts `startTestServer()`, used by the pytest suite and
by the e2e runners when no server is running. The server gets random ports, a temporary log folder
and the same safe environment as the TS harness: never the developer's config/models.json
(AGENT_MODELS_FILE=none), saved sign-ins or snapshot key (a temporary SNAPSHOTS_DIR, an empty
SNAPSHOTS_KEY), and it exits by itself if this process dies (SBM_EXIT_WITH_PARENT=1).
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import Any

from ._repo import repo_root

HEALTHY_TIMEOUT = 45.0
STOP_TIMEOUT = 8.0

# straight to the server, never through a proxy from HTTP_PROXY/HTTPS_PROXY (as Node fetch does)
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ServerStartError(RuntimeError):
    """The server exited early or did not become healthy; the message holds its output."""


def free_port() -> int:
    """A TCP port on 127.0.0.1 that is free right now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


def obscura_binary(root: Path | None = None) -> Path | None:
    """The Obscura binary the server will use ($OBSCURA_BIN, else .obscura/ from
    `npm run obscura:download`), or None when it is missing."""
    configured = os.environ.get("OBSCURA_BIN")
    if configured:
        path = Path(configured)
    else:
        name = "obscura.exe" if sys.platform == "win32" else "obscura"
        path = (root or repo_root()) / ".obscura" / name
    return path if path.is_file() else None


def node_binary() -> str | None:
    """The node executable ($NODE, else `node` on PATH)."""
    return os.environ.get("NODE") or shutil.which("node")


def auth_headers() -> dict[str, str]:
    """The Authorization header for a server that requires AUTH_TOKEN (empty when it is unset)."""
    token = os.environ.get("AUTH_TOKEN")
    return {"Authorization": f"Bearer {token}"} if token else {}


def is_healthy(base_url: str, timeout: float = 1.0) -> bool:
    """True when GET {base_url}/healthz answers 2xx."""
    try:
        with _opener.open(f"{base_url.rstrip('/')}/healthz", timeout=timeout) as res:
            status: int = res.status
    except OSError:  # URLError and HTTPError included
        return False
    return 200 <= status < 300


@dataclass
class TsServer:
    """A running server. `process` is None when it was started elsewhere (see `external`)."""

    base_url: str
    mcp_url: str
    log_dir: Path | None = None
    snapshots_dir: Path | None = None
    process: subprocess.Popen[bytes] | None = None
    output: list[str] = field(default_factory=list)

    @classmethod
    def external(cls, mcp_url: str) -> TsServer:
        """A server that is already running (MCP_URL mode, e.g. the Docker container)."""
        base = mcp_url.rstrip("/")
        base = base[: -len("/mcp")] if base.endswith("/mcp") else base
        return cls(base_url=base, mcp_url=mcp_url)

    def get_json(self, path: str, timeout: float = 10.0) -> Any:
        """GET {base_url}{path} (e.g. /api/state) as JSON, with AUTH_TOKEN as the bearer token when set."""
        req = urllib.request.Request(f"{self.base_url}{path}", headers=auth_headers())
        with _opener.open(req, timeout=timeout) as res:
            return json.load(res)

    def logs(self) -> list[dict[str, Any]]:
        """Parsed JSON lines from LOG_DIR/current.log (only for a server started here)."""
        if self.log_dir is None:
            return []
        try:
            text = (self.log_dir / "current.log").read_text(encoding="utf-8")
        except OSError:
            return []
        return [json.loads(line) for line in text.splitlines() if line]

    def stop(self, timeout: float = STOP_TIMEOUT) -> None:
        """SIGTERM, then SIGKILL after `timeout` seconds. Safe to call twice."""
        proc = self.process
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    def __enter__(self) -> TsServer:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.stop()


def _drain(stream: Any, sink: list[str]) -> None:
    for raw in iter(stream.readline, b""):
        sink.append(raw.decode("utf-8", "replace"))
    stream.close()


def start_ts_server(
    env: Mapping[str, str] | None = None,
    *,
    root: Path | None = None,
    log_dir: Path | None = None,
    snapshots_dir: Path | None = None,
    healthy_timeout: float = HEALTHY_TIMEOUT,
) -> TsServer:
    """Spawn `node src/main.ts` and wait for GET /healthz. `env` overrides the defaults (for
    example AGENT_LLM_URL for a fake model). The caller stops it with `.stop()` or a `with` block."""
    root = root or repo_root()
    node = node_binary()
    if node is None:
        raise ServerStartError("node (24 or newer) is not on PATH; set NODE to its path")
    port = free_port()
    cdp_port = free_port()
    while cdp_port == port:
        cdp_port = free_port()
    log_dir = log_dir or Path(tempfile.mkdtemp(prefix="sbm-test-logs-"))
    snapshots_dir = snapshots_dir or Path(tempfile.mkdtemp(prefix="sbm-test-snapshots-"))
    child_env = {
        **os.environ,
        "PORT": str(port),
        "HOST": "127.0.0.1",
        "OBSCURA_CDP_PORT": str(cdp_port),
        "LOG_DIR": str(log_dir),
        "LOG_FORMAT": "json",
        "LOG_LEVEL": "warn",
        "LOG_FILE_LEVEL": "debug",
        "ALLOW_PRIVATE_NETWORK": "true",
        # stop the server if this process dies without cleaning up
        "SBM_EXIT_WITH_PARENT": "1",
        # never the developer's own config/models.json: callers configure their model themselves
        "AGENT_MODELS_FILE": "none",
        # never the developer's saved sign-ins or key
        "SNAPSHOTS_DIR": str(snapshots_dir),
        "SNAPSHOTS_KEY": "",
        **(env or {}),
    }
    proc = subprocess.Popen(
        [node, "src/main.ts"],
        cwd=root,
        env=child_env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    base_url = f"http://127.0.0.1:{port}"
    server = TsServer(
        base_url=base_url,
        mcp_url=f"{base_url}/mcp",
        log_dir=log_dir,
        snapshots_dir=snapshots_dir,
        process=proc,
    )
    for stream in (proc.stdout, proc.stderr):
        threading.Thread(target=_drain, args=(stream, server.output), daemon=True).start()

    deadline = time.monotonic() + healthy_timeout
    while True:
        code = proc.poll()
        if code is not None:
            time.sleep(0.1)  # let the drain threads catch the last lines
            raise ServerStartError(f"server exited early (code {code}):\n{''.join(server.output)}")
        if is_healthy(base_url):
            return server
        if time.monotonic() > deadline:
            proc.kill()
            proc.wait()
            raise ServerStartError(f"server did not become healthy:\n{''.join(server.output)}")
        time.sleep(0.2)
