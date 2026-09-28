"""The local fixture website (test/fixtures/site) with a recording form target.

A subset of test/helpers/fixture-server.ts: the static pages plus `/echo`, which renders the
method, query and body it received (the form pages post there). Every request is recorded in
`requests`, so a check can see what the browser really sent. Add the other dynamic endpoints of the
TS helper here when a test needs them, with the same behaviour.

FIXTURE_HOST overrides the host in `base_url` (host.docker.internal when the server under test runs
in a container). Like the TS helper, it listens on all interfaces so a containerised browser can
reach it.
"""

from __future__ import annotations

import html
import os
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import TracebackType
from urllib.parse import urlsplit

from ._repo import repo_root


@dataclass(frozen=True)
class RecordedRequest:
    method: str
    url: str  # path and query, as sent
    body: str
    headers: dict[str, str]  # lower-case names


def _escape(text: str) -> str:
    # the TS helper escapes only & < >
    return html.escape(text, quote=False)


@dataclass
class FixtureSite:
    base_url: str
    port: int
    requests: list[RecordedRequest] = field(default_factory=list)
    _server: ThreadingHTTPServer | None = None

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> FixtureSite:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()


def _content_type(path: Path) -> str:
    if path.suffix == ".html":
        return "text/html; charset=utf-8"
    if path.suffix == ".js":
        return "text/javascript"
    return "application/octet-stream"


def start_fixture_site(site_dir: Path | None = None, *, host: str | None = None) -> FixtureSite:
    """Serve `site_dir` (default: test/fixtures/site of the checkout) on a random port."""
    root = (site_dir or repo_root() / "test" / "fixtures" / "site").resolve()
    requests: list[RecordedRequest] = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:
            pass

        def _send(self, status: int, body: bytes, content_type: str, headers: dict[str, str] | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _html(self, status: int, markup: str) -> None:
            self._send(status, markup.encode("utf-8"), "text/html; charset=utf-8")

        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            requests.append(
                RecordedRequest(
                    method=self.command,
                    url=self.path,
                    body=body,
                    headers={k.lower(): v for k, v in self.headers.items()},
                )
            )
            url = urlsplit(self.path)
            if url.path == "/echo":
                query = f"?{url.query}" if url.query else ""
                self._html(
                    200,
                    f'<!doctype html><title>Echo</title><h1>Echo</h1><p id="method">{self.command}</p>'
                    f'<p id="query">{_escape(query)}</p><pre id="body">{_escape(body)}</pre>',
                )
                return
            name = "index.html" if url.path == "/" else url.path.lstrip("/")
            target = (root / name).resolve()
            if target != root and root not in target.parents:
                self._html(403, "forbidden")
                return
            try:
                content = target.read_bytes()
            except OSError:
                self._html(404, "<!doctype html><title>Not found</title><h1>Not found</h1>")
                return
            self._send(200, content, _content_type(target))

        do_GET = _handle
        do_POST = _handle
        do_PUT = _handle
        do_DELETE = _handle
        do_PATCH = _handle
        do_HEAD = _handle

    server = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, name="fixture-site", daemon=True).start()
    advertised = host or os.environ.get("FIXTURE_HOST") or "127.0.0.1"
    return FixtureSite(base_url=f"http://{advertised}:{port}", port=port, requests=requests, _server=server)
