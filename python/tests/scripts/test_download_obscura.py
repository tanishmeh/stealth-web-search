"""scripts/download_obscura.py against a local stand-in for the GitHub API and release downloads,
on every Python 3.9+ found (3.9.6 has no tarfile extraction filters and uses the system tar).

The real release is downloaded only with SWS_NETWORK_TESTS=1 (about 80 MB); CI exercises the real
download anyway in its "Download Obscura" step.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import subprocess
import sys
import tarfile
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from tests.scripts.helpers import SCRIPTS_DIR, load_script

SCRIPT = SCRIPTS_DIR / "download_obscura.py"
REPO_ROOT = SCRIPTS_DIR.parent
VERSION = "v9.9.9"
DEAD_API = "http://127.0.0.1:9"  # nothing listens on the discard port: any request fails at once

dl = load_script("download_obscura")
ARCH, OS_NAME = dl.target(sys.platform, platform.machine())
ASSET = dl.asset_name(ARCH, OS_NAME, "stealth")

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="the stand-in release is a tar.gz with a shell script")


def make_archive(members: dict[str, tuple[bytes, int]]) -> bytes:
    """A tar.gz with {name: (content, mode)}."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, (content, mode) in members.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(content), mode
            tf.addfile(info, io.BytesIO(content))
    return buf.getvalue()


def fake_binary(version_line: str = "obscura 9.9.9-test", code: int = 0) -> bytes:
    return f'#!/bin/sh\n[ "$1" = "--version" ] && echo "{version_line}"\nexit {code}\n'.encode()


GOOD_ARCHIVE = make_archive({"obscura": (fake_binary(), 0o755), "obscura-worker": (b"#!/bin/sh\n", 0o755)})


@dataclass
class Request:
    path: str
    headers: dict[str, str]


@dataclass
class FakeGitHub:
    """GET /repos/<repo>/releases/tags/<version> and GET /download/<asset>, recording each request."""

    base_url: str = ""
    archive: bytes = GOOD_ARCHIVE
    digest: str | None = None  # default: the archive's real sha256
    api_status: int = 200
    assets: list[str] = field(default_factory=lambda: [ASSET, "obscura-other.tar.gz"])
    requests: list[Request] = field(default_factory=list)

    def release(self) -> dict[str, Any]:
        digest = self.digest if self.digest is not None else f"sha256:{hashlib.sha256(self.archive).hexdigest()}"
        return {
            "tag_name": VERSION,
            "assets": [
                {
                    "name": name,
                    "size": len(self.archive),
                    "digest": digest or None,
                    "browser_download_url": f"{self.base_url}/download/{name}",
                }
                for name in self.assets
            ],
        }

    @property
    def downloads(self) -> list[Request]:
        return [r for r in self.requests if r.path.startswith("/download/")]


@pytest.fixture
def github() -> Iterator[FakeGitHub]:
    fake = FakeGitHub()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            fake.requests.append(Request(self.path, {k.lower(): v for k, v in self.headers.items()}))
            if self.path == f"/repos/h4ckf0r0day/obscura/releases/tags/{VERSION}" and fake.api_status == 200:
                self._send(200, json.dumps(fake.release()).encode(), "application/json")
            elif self.path.startswith("/repos/"):
                self._send(
                    fake.api_status if fake.api_status != 200 else 404, b'{"message":"Not Found"}', "application/json"
                )
            elif self.path == f"/download/{ASSET}":
                self._send(200, fake.archive, "application/octet-stream")
            else:
                self._send(404, b"not found", "text/plain")

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    fake.base_url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield fake
    server.shutdown()
    server.server_close()


def run(python: str, env: dict[str, str], *args: str, api: str | None = None) -> subprocess.CompletedProcess[str]:
    if api is not None:
        env = {**env, "OBSCURA_API_URL": api}
    return subprocess.run([python, str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=120)


def leftovers(dest: Path) -> list[str]:
    return sorted(p.name for p in dest.iterdir() if p.name.endswith(".part") or p.name.startswith(".unpack-"))


# ---------------------------------------------------------------- helpers (in process)


def test_maps_platforms_to_release_assets() -> None:
    assert dl.target("darwin", "arm64") == ("aarch64", "macos")
    assert dl.target("linux", "aarch64") == ("aarch64", "linux")
    assert dl.target("linux", "x86_64") == ("x86_64", "linux")
    assert dl.target("win32", "AMD64") == ("x86_64", "windows")
    with pytest.raises(dl.Failure, match=r"Unsupported platform linux/armv7l"):
        dl.target("linux", "armv7l")
    with pytest.raises(dl.Failure, match=r"Unsupported platform freebsd"):
        dl.target("freebsd14", "amd64")
    assert dl.asset_name("aarch64", "macos", "stealth") == "obscura-aarch64-macos-stealth.tar.gz"
    assert dl.asset_name("x86_64", "linux", "default") == "obscura-x86_64-linux.tar.gz"
    assert dl.asset_name("x86_64", "windows", "stealth") == "obscura-x86_64-windows-stealth.zip"


def test_defaults_to_the_release_the_dockerfile_pins() -> None:
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert f"ARG OBSCURA_VERSION={dl.pinned_version()}\n" in dockerfile
    assert dl.pinned_version(REPO_ROOT / "no-such-folder") == dl.FALLBACK_VERSION


def test_marker_format_is_version_space_asset() -> None:
    # the format the JavaScript downloader wrote: existing .obscura/ folders must not be re-downloaded
    assert (
        dl.marker_text("v0.2.2", "obscura-aarch64-macos-stealth.tar.gz")
        == "v0.2.2 obscura-aarch64-macos-stealth.tar.gz\n"
    )


# ---------------------------------------------------------------- the script, per interpreter


@posix_only
def test_installs_the_binary_and_writes_the_marker(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    dest = tmp_path / "obscura"
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    assert res.returncode == 0, res.stderr
    digest = hashlib.sha256(github.archive).hexdigest()
    assert res.stdout.splitlines() == [
        f"Looking up {ASSET} in h4ckf0r0day/obscura {VERSION}…",
        f"Downloading {github.base_url}/download/{ASSET} (0 MB)…",
        f"sha256 verified: {digest}",
        f"Installed obscura 9.9.9-test → {dest}{os.sep}obscura",
    ]
    assert (dest / "VERSION").read_text() == f"{VERSION} {ASSET}\n"
    assert os.access(dest / "obscura", os.X_OK)
    assert (dest / "obscura-worker").is_file()
    assert leftovers(dest) == []
    api, download = github.requests
    assert api.headers["accept"] == "application/vnd.github+json"
    assert api.headers["user-agent"] == "stealth-web-search"
    assert "authorization" not in api.headers
    assert "authorization" not in download.headers


@posix_only
def test_sends_github_token_to_the_api_only(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    env = {**script_env, "GITHUB_TOKEN": "ghs-test-token"}
    res = run(script_python, env, "--version", VERSION, "--dest", str(tmp_path / "o"), api=github.base_url)
    assert res.returncode == 0, res.stderr
    api, download = github.requests
    assert api.headers["authorization"] == "Bearer ghs-test-token"
    assert "authorization" not in download.headers


@posix_only
def test_second_run_is_a_no_op_until_the_release_changes_or_force(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    dest = tmp_path / "o"
    args = ("--version", VERSION, "--dest", str(dest))
    assert run(script_python, script_env, *args, api=github.base_url).returncode == 0
    again = run(script_python, script_env, *args, api=DEAD_API)
    assert again.returncode == 0, again.stderr
    assert again.stdout == f"Obscura {VERSION} ({ASSET}) already present in {dest}{os.sep}\n"
    assert len(github.downloads) == 1

    # another release in the marker: download again
    (dest / "VERSION").write_text(f"v0.0.1 {ASSET}\n")
    assert run(script_python, script_env, *args, api=github.base_url).returncode == 0
    assert len(github.downloads) == 2
    # --force: always
    assert run(script_python, script_env, *args, "--force", api=github.base_url).returncode == 0
    assert len(github.downloads) == 3
    # a missing binary: download again even though the marker matches
    (dest / "obscura").unlink()
    assert run(script_python, script_env, *args, api=github.base_url).returncode == 0
    assert len(github.downloads) == 4


@posix_only
def test_replaces_an_installed_binary_by_rename(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    # a server that is running the old binary keeps its file: the new one arrives as a new inode
    dest = tmp_path / "o"
    dest.mkdir()
    (dest / "obscura").write_bytes(b"old binary")
    (dest / "VERSION").write_text(f"v0.0.1 {ASSET}\n")
    os.link(dest / "obscura", tmp_path / "held-open")
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    assert res.returncode == 0, res.stderr
    assert (tmp_path / "held-open").read_bytes() == b"old binary"
    assert (dest / "obscura").read_bytes() == fake_binary()


@posix_only
def test_a_checksum_mismatch_installs_nothing(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    dest = tmp_path / "o"
    dest.mkdir()
    (dest / "obscura").write_bytes(b"old binary")
    (dest / "VERSION").write_text(f"v0.0.1 {ASSET}\n")
    github.digest = "sha256:" + "0" * 64
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    assert res.returncode == 1
    actual = hashlib.sha256(github.archive).hexdigest()
    assert res.stderr == f"Checksum mismatch for {ASSET}: expected {'0' * 64}, got {actual}\n"
    assert (dest / "obscura").read_bytes() == b"old binary"
    assert (dest / "VERSION").read_text() == f"v0.0.1 {ASSET}\n"
    assert leftovers(dest) == []


@posix_only
def test_without_a_published_digest_the_hash_is_shown(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    github.digest = ""
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(tmp_path / "o"), api=github.base_url)
    assert res.returncode == 0, res.stderr
    assert f"sha256 (no digest published to compare): {hashlib.sha256(github.archive).hexdigest()}\n" in res.stdout


def test_reports_api_errors_and_missing_assets(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    dest = tmp_path / "o"
    github.api_status = 404
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    assert (res.returncode, res.stderr) == (1, f"GitHub API returned 404 for release {VERSION}\n")

    github.api_status = 403
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    assert res.returncode == 1
    assert res.stderr.startswith(f"GitHub API returned 403 for release {VERSION}\nThe GitHub API rate limit")

    github.api_status = 200
    github.assets = ["obscura-other.tar.gz", "obscura-else.zip"]
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    assert res.returncode == 1
    assert (
        res.stderr
        == f"Asset {ASSET} not found in release {VERSION}. Available: obscura-other.tar.gz, obscura-else.zip\n"
    )

    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=DEAD_API)
    assert res.returncode == 1
    assert res.stderr.startswith("Cannot reach 127.0.0.1:9:")
    assert not dest.exists(), "nothing is written before the release is found"


@posix_only
def test_a_binary_that_does_not_run_is_not_installed(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    dest = tmp_path / "o"
    github.archive = make_archive({"obscura": (fake_binary(code=3), 0o755)})
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    assert res.returncode == 1
    assert "The downloaded binary does not run" in res.stderr
    assert not (dest / "obscura").exists()
    assert not (dest / "VERSION").exists()
    assert leftovers(dest) == []

    github.archive = make_archive({"README": (b"no binary here", 0o644)})
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    assert (res.returncode, res.stderr) == (1, f"{ASSET} does not contain obscura\n")


@posix_only
def test_archive_entries_cannot_leave_the_destination(
    script_python: str, script_env: dict[str, str], github: FakeGitHub, tmp_path: Path
) -> None:
    dest = tmp_path / "deep" / "o"
    github.archive = make_archive({"obscura": (fake_binary(), 0o755), "../../escaped.txt": (b"x", 0o644)})
    res = run(script_python, script_env, "--version", VERSION, "--dest", str(dest), api=github.base_url)
    # tarfile's "data" filter refuses the archive; an old Python's system tar refuses or strips the entry
    assert not (tmp_path / "escaped.txt").exists()
    assert not (tmp_path / "deep" / "escaped.txt").exists()
    if res.returncode != 0:
        assert f"Could not unpack {ASSET}" in res.stderr
        assert not (dest / "VERSION").exists()
    assert leftovers(dest) == []


def test_rejects_unknown_options(script_python: str, script_env: dict[str, str], tmp_path: Path) -> None:
    for args in (["--variant", "no-render"], ["--bogus"], ["positional"], ["--version"]):
        res = run(script_python, script_env, *args, "--dest", str(tmp_path / "o"), api=DEAD_API)
        assert res.returncode == 2, args
        assert "usage: download_obscura.py" in res.stderr
    assert not (tmp_path / "o").exists()


def test_honours_a_marker_written_by_the_javascript_downloader(
    script_python: str, script_env: dict[str, str], tmp_path: Path
) -> None:
    dest = tmp_path / ".obscura"
    dest.mkdir()
    binary = dest / ("obscura.exe" if OS_NAME == "windows" else "obscura")
    binary.write_bytes(b"binary")
    (dest / "VERSION").write_bytes(f"v0.2.2 {ASSET}\n".encode())  # exactly what the JavaScript downloader wrote
    res = run(script_python, script_env, "--version", "v0.2.2", "--dest", str(dest), api=DEAD_API)
    assert (res.returncode, res.stdout) == (0, f"Obscura v0.2.2 ({ASSET}) already present in {dest}{os.sep}\n")
    # the variant is part of the marker: another variant is another download
    res = run(
        script_python, script_env, "--version", "v0.2.2", "--variant", "default", "--dest", str(dest), api=DEAD_API
    )
    assert res.returncode == 1
    assert "Cannot reach" in res.stderr


def test_the_checkout_obscura_folder_is_honoured(script_python: str, script_env: dict[str, str]) -> None:
    """The repository's own .obscura/ (from `npm run obscura:download`) is used as is, without the network."""
    dest = REPO_ROOT / ".obscura"
    bin_name = "obscura.exe" if OS_NAME == "windows" else "obscura"
    version = dl.pinned_version()
    if not dl.is_installed(dest, bin_name, version, ASSET):
        pytest.skip(f".obscura/ does not hold {version} {ASSET}")
    before = {p.name: p.stat().st_mtime_ns for p in dest.iterdir()}
    res = run(script_python, script_env, api=DEAD_API)
    assert (res.returncode, res.stdout) == (0, f"Obscura {version} ({ASSET}) already present in .obscura/\n")
    assert {p.name: p.stat().st_mtime_ns for p in dest.iterdir()} == before


@pytest.mark.skipif(
    not os.environ.get("SWS_NETWORK_TESTS"), reason="downloads the real release (~80 MB); set SWS_NETWORK_TESTS=1"
)
def test_downloads_the_pinned_release(script_python: str, script_env: dict[str, str], tmp_path: Path) -> None:
    if os.environ.get("GITHUB_TOKEN"):
        script_env = {**script_env, "GITHUB_TOKEN": os.environ["GITHUB_TOKEN"]}
    dest = tmp_path / "obscura"
    res = run(script_python, script_env, "--dest", str(dest))
    assert res.returncode == 0, res.stderr
    assert "sha256 verified: " in res.stdout
    version = dl.pinned_version()
    assert (dest / "VERSION").read_text() == f"{version} {ASSET}\n"
    reported = subprocess.run([str(dest / "obscura"), "--version"], capture_output=True, text=True, check=True)
    assert version.lstrip("v") in reported.stdout
    again = run(script_python, script_env, "--dest", str(dest), api=DEAD_API)
    assert (again.returncode, again.stdout) == (0, f"Obscura {version} ({ASSET}) already present in {dest}{os.sep}\n")
