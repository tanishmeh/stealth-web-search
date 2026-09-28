"""`sws-site` (npm run site:build / site:serve) and the preview server."""

from __future__ import annotations

import http.client
import os
import signal
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from sws_tools.website.build import build
from sws_tools.website.cli import main
from sws_tools.website.serve import create_server

from .conftest import MakeRepo


def test_build_command(
    make_repo: MakeRepo, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SWS_REPO_ROOT", str(make_repo()))
    assert main([]) == 0
    assert capsys.readouterr().out == "site built: 15 pages in _site/\n"


def test_a_failed_build_exits_1(
    make_repo: MakeRepo, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SWS_REPO_ROOT", str(make_repo({"docs/TOOLS.md": "# Tools\n\n[x](gone.md)\n"})))
    assert main([]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.startswith(
        "sws-site: broken links:\n  docs/TOOLS.md: link to gone.md (docs/gone.md does not exist)\n"
    )


def test_outside_a_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SWS_REPO_ROOT", str(tmp_path))
    assert main([]) == 1
    assert "Cannot find the stealth-web-search repository" in capsys.readouterr().err


def test_a_bad_port_is_a_usage_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PORT", "http")
    with pytest.raises(SystemExit) as exit_info:
        main(["--serve"])
    assert exit_info.value.code == 2
    with pytest.raises(SystemExit) as exit_info:
        main(["--port", "70000"])
    assert exit_info.value.code == 2


# ------------------------------------------------------------------------------------------ serve


@pytest.fixture
def server(make_repo: MakeRepo) -> Iterator[tuple[str, int]]:
    root = make_repo()
    build(root)
    srv = create_server(root / "_site", 0)
    thread = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    yield "127.0.0.1", srv.server_address[1]
    srv.shutdown()
    srv.server_close()


def get(address: tuple[str, int], path: str, method: str = "GET") -> tuple[int, str, bytes]:
    conn = http.client.HTTPConnection(*address, timeout=10)
    try:
        conn.request(method, path)
        res = conn.getresponse()
        return res.status, res.getheader("Content-Type") or "", res.read()
    finally:
        conn.close()


@pytest.mark.parametrize(
    ("path", "status", "content_type", "marker"),
    [
        ("/", 200, "text/html; charset=utf-8", b"<p>3 browser tools"),
        ("/index.html", 200, "text/html; charset=utf-8", b"<p>3 browser tools"),
        # the GitHub Pages prefix works too, and a folder answers with its index.html
        ("/stealth-web-search/", 200, "text/html; charset=utf-8", b"<p>3 browser tools"),
        ("/stealth-web-search/docs/", 200, "text/html; charset=utf-8", b'url=getting-started.html"'),
        ("/docs/tools.html?x=1", 200, "text/html; charset=utf-8", b"<title>Tool reference"),
        ("/assets/site.css", 200, "text/css", b"body"),
        ("/assets/logo.svg", 200, "image/svg+xml", b"<svg/>"),
        ("/sitemap.xml", 200, "application/xml", b"<urlset"),
        ("/robots.txt", 200, "text/plain", b"User-agent"),
        ("/assets/img/shot.png", 200, "image/png", b"PNG"),
        ("/.nojekyll", 200, "application/octet-stream", b""),
        ("/docs/nope.html", 404, "text/html; charset=utf-8", b"<h1>Page not found</h1>"),
        ("/docs/%00x", 404, "text/html; charset=utf-8", b"<h1>Page not found</h1>"),
        ("/../package.json", 403, "text/plain", b""),
        ("/%2e%2e/package.json", 403, "text/plain", b""),
        ("/%E0%A4%A", 400, "text/plain", b"Bad request"),
    ],
)
def test_served_paths(server: tuple[str, int], path: str, status: int, content_type: str, marker: bytes) -> None:
    got_status, got_type, body = get(server, path)
    assert (got_status, got_type) == (status, content_type)
    assert marker in body


def test_head_requests(server: tuple[str, int]) -> None:
    assert get(server, "/", "HEAD")[:2] == (200, "text/html; charset=utf-8")


@pytest.mark.skipif(os.name == "nt", reason="POSIX signals")
def test_serve_command_until_ctrl_c(make_repo: MakeRepo, python_env: dict[str, str]) -> None:
    env = {**python_env, "SWS_REPO_ROOT": str(make_repo()), "PORT": "0"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "sws_tools.website", "--serve"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert proc.stdout is not None
        assert proc.stdout.readline() == "site built: 15 pages in _site/\n"
        line = proc.stdout.readline()
        assert line.startswith("serving _site/ on http://127.0.0.1:"), line
        port = int(line.rsplit(":", 1)[1].rstrip("/\n"))
        assert get(("127.0.0.1", port), "/docs/")[0] == 200
        proc.send_signal(signal.SIGINT)
        assert proc.wait(timeout=30) == 130
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_python_m_runs_the_same_command(make_repo: MakeRepo, python_env: dict[str, str]) -> None:
    env = {**python_env, "SWS_REPO_ROOT": str(make_repo())}
    res = subprocess.run(
        [sys.executable, "-m", "sws_tools.website"], capture_output=True, text=True, env=env, timeout=120
    )
    assert (res.returncode, res.stdout, res.stderr) == (0, "site built: 15 pages in _site/\n", "")
