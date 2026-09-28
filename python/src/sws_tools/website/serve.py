"""A local preview server for the built site, with GitHub Pages' /stealth-web-search/ prefix."""

from __future__ import annotations

import os
import re
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .jscompat import URIError, decode_uri_component

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "text/javascript",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".xml": "application/xml",
    ".txt": "text/plain",
}
_PREFIX = re.compile(r"^/stealth-web-search")


class SiteHandler(BaseHTTPRequestHandler):
    """Serves files from `out`: a folder answers with its index.html, a missing file with 404.html."""

    server_version = "sws-site"

    def __init__(self, *args: Any, out: Path, **kwargs: Any) -> None:
        self.out = os.path.normpath(out)
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        self._respond(body=True)

    def do_HEAD(self) -> None:
        self._respond(body=False)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # quiet, like the TypeScript server

    def _resolve(self) -> str | None:
        """The file for the request path, '' when it is outside the site, None when it is malformed."""
        path = _PREFIX.sub("", urlsplit(self.path).path)
        try:
            decoded = decode_uri_component(path)
        except URIError:
            return None
        candidate = os.path.normpath(f"{self.out}/{decoded}")
        if candidate != self.out and not candidate.startswith(self.out + os.sep):
            return ""
        if os.path.isdir(candidate):
            candidate = os.path.join(candidate, "index.html")
        return candidate

    def _respond(self, *, body: bool) -> None:
        file = self._resolve()
        if file is None:
            self._send(400, "text/plain", b"Bad request\n", body)
        elif not file:
            self._send(403, "text/plain", b"", body)
        elif "\0" in file or not os.path.isfile(file):
            self._send(404, CONTENT_TYPES[".html"], Path(self.out, "404.html").read_bytes(), body)
        else:
            content_type = CONTENT_TYPES.get(os.path.splitext(file)[1], "application/octet-stream")
            self._send(200, content_type, Path(file).read_bytes(), body)

    def _send(self, status: int, content_type: str, data: bytes, body: bool) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if body:
            self.wfile.write(data)


def create_server(out: Path, port: int, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    """A server for `out` on host:port (port 0 picks a free one); call serve_forever() on it."""
    return ThreadingHTTPServer((host, port), partial(SiteHandler, out=out))
