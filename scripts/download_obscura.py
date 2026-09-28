#!/usr/bin/env python3
"""Download the Obscura release binary for this machine into ./.obscura/ (for running the server or
the tests without Docker). The Docker image downloads its own copy.

    npm run obscura:download
    npm run obscura:download -- --version v0.2.2 --variant default --force
    python3 scripts/download_obscura.py --dest /tmp/obscura

The release defaults to the one the Dockerfile pins (ARG OBSCURA_VERSION), so local runs and the
image use the same engine. The archive is streamed to disk, its SHA-256 is checked against the
digest GitHub publishes, and the binary is swapped in with a rename, so a running server keeps its
copy. `.obscura/VERSION` records "<version> <asset>"; a matching marker skips the download.

Environment: OBSCURA_VERSION, OBSCURA_VARIANT (defaults for the options), GITHUB_TOKEN (sent to
the GitHub API only, which raises its rate limit in CI), OBSCURA_API_URL (a GitHub API mirror;
default https://api.github.com).

Standard library only, for any Python 3.9 or newer (the macOS python3 works).
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import platform
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from pathlib import Path
from typing import Any, NoReturn

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DEST = ROOT / ".obscura"
REPO = "h4ckf0r0day/obscura"
FALLBACK_VERSION = "v0.2.2"
DEFAULT_API = "https://api.github.com"
USER_AGENT = "stealth-web-search"
TIMEOUT = 120  # seconds without progress before a request fails
CHUNK = 1 << 20

ARCHES = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "amd64": "x86_64", "x64": "x86_64"}
SYSTEMS = {"darwin": "macos", "linux": "linux", "win32": "windows"}

CERT_HINT = (
    "Python could not verify GitHub's HTTPS certificate (CERTIFICATE_VERIFY_FAILED).\n"
    "With the python.org installer on macOS, run 'Install Certificates.command' from its folder in\n"
    "/Applications (Python 3.x), point SSL_CERT_FILE at a CA bundle, or run this script with another\n"
    "Python, for example /usr/bin/python3."
)


class Failure(Exception):
    """Stop with this message and exit code 1."""


def fail(message: str) -> NoReturn:
    raise Failure(message)


def pinned_version(root: Path = ROOT) -> str:
    """The release the Dockerfile installs (ARG OBSCURA_VERSION), so local runs match the image."""
    try:
        match = re.search(r"ARG OBSCURA_VERSION=(\S+)", (root / "Dockerfile").read_text(encoding="utf-8"))
    except OSError:
        return FALLBACK_VERSION
    return match.group(1) if match else FALLBACK_VERSION


def target(system: str, machine: str) -> tuple[str, str]:
    """(arch, os) in the release asset names, e.g. ("aarch64", "macos")."""
    arch, os_name = ARCHES.get(machine.lower()), SYSTEMS.get(system)
    if not arch or not os_name:
        fail(f"Unsupported platform {system}/{machine}")
    return arch, os_name


def asset_name(arch: str, os_name: str, variant: str) -> str:
    suffix = "-stealth" if variant == "stealth" else ""
    ext = "zip" if os_name == "windows" else "tar.gz"
    return f"obscura-{arch}-{os_name}{suffix}.{ext}"


def marker_text(version: str, asset: str) -> str:
    """Contents of .obscura/VERSION (the same format the earlier JavaScript downloader wrote)."""
    return f"{version} {asset}\n"


def is_installed(dest: Path, bin_name: str, version: str, asset: str) -> bool:
    try:
        marker = (dest / "VERSION").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return (dest / bin_name).is_file() and marker.strip() == marker_text(version, asset).strip()


def shown(path: Path) -> str:
    """How messages name a folder: relative to the checkout when inside it."""
    try:
        return f"{path.relative_to(ROOT).as_posix()}/"
    except ValueError:
        return f"{path}{os.sep}"


# ---------------------------------------------------------------- HTTP


def _open(url: str, headers: dict[str, str]) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **headers})
    try:
        return urllib.request.urlopen(request, timeout=TIMEOUT)
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as err:
        reason = err.reason
        if isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
            fail(CERT_HINT)
        fail(f"Cannot reach {urllib.parse.urlsplit(url).netloc}: {reason}")
    except OSError as err:  # timeouts and resets before the response started
        fail(f"Cannot reach {urllib.parse.urlsplit(url).netloc}: {err}")


def find_release_asset(api: str, version: str, asset: str) -> dict[str, Any]:
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"  # avoids API rate limits in CI
    url = f"{api.rstrip('/')}/repos/{REPO}/releases/tags/{urllib.parse.quote(version, safe='')}"
    try:
        with _open(url, headers) as res:
            release = json.load(res)
    except urllib.error.HTTPError as err:
        hint = ""
        if err.code in (403, 429) and not token:
            hint = "\nThe GitHub API rate limit may be exhausted: set GITHUB_TOKEN, or try again later."
        fail(f"GitHub API returned {err.code} for release {version}{hint}")
    except (ValueError, OSError) as err:
        fail(f"GitHub API sent an unreadable answer for release {version}: {err}")
    assets = release.get("assets") if isinstance(release, dict) else None
    if not isinstance(assets, list):
        fail(f"GitHub API sent an unexpected answer for release {version}")
    for meta in assets:
        if isinstance(meta, dict) and meta.get("name") == asset:
            return meta
    names = ", ".join(str(a.get("name")) for a in assets if isinstance(a, dict))
    fail(f"Asset {asset} not found in release {version}. Available: {names}")


def download(url: str, file: Path, size: int | None) -> str:
    """Stream `url` into `file` and return its sha256 hex digest."""
    digest = hashlib.sha256()
    progress = sys.stderr.isatty() and bool(size)
    done = 0
    try:
        with _open(url, {}) as res, open(file, "wb") as out:
            while True:
                chunk = res.read(CHUNK)
                if not chunk:
                    break
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                if progress and size:
                    sys.stderr.write(f"\r  {done * 100 // size:3d}% of {size / 1048576:.0f} MB")
    except urllib.error.HTTPError as err:
        fail(f"Download failed: HTTP {err.code}")
    except OSError as err:
        fail(f"Download failed: {err}")
    finally:
        if progress:
            sys.stderr.write("\r" + " " * 24 + "\r")
    if size and done != size:
        fail(f"Download failed: got {done} of {size} bytes")
    return digest.hexdigest()


# ---------------------------------------------------------------- unpacking


def extract(archive: Path, into: Path, is_zip: bool, name: str) -> None:
    try:
        if is_zip:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(into)  # drops absolute paths and ".." parts
        elif hasattr(tarfile, "data_filter"):  # 3.12+, and 3.9.17+/3.10.12+/3.11.4+
            with tarfile.open(archive, "r:gz") as tf:
                tf.extractall(into, filter="data")  # refuses links and paths that leave `into`
        else:
            # an older Python without extraction filters: the system tar, as the JavaScript version did
            subprocess.run(["tar", "-xzf", str(archive), "-C", str(into)], check=True)
    except (tarfile.TarError, zipfile.BadZipFile, EOFError, zlib.error, OSError, subprocess.CalledProcessError) as err:
        fail(f"Could not unpack {name}: {err}")


def install(staging: Path, dest: Path) -> None:
    """Move what was unpacked into `dest`; renames, so a running binary keeps its old file."""
    for entry in staging.iterdir():
        final = dest / entry.name
        if final.is_dir() and not final.is_symlink():
            shutil.rmtree(final)
        os.replace(entry, final)


def binary_version(binary: Path) -> str:
    try:
        res = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=60, check=True)
    except (OSError, subprocess.SubprocessError) as err:
        fail(f"The downloaded binary does not run ({binary}): {err}")
    return res.stdout.strip()


# ---------------------------------------------------------------- main


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="download_obscura.py",
        description="Download the Obscura release binary for this machine into .obscura/.",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--version",
        default=os.environ.get("OBSCURA_VERSION") or None,
        help="release tag (default: $OBSCURA_VERSION, else the Dockerfile's ARG OBSCURA_VERSION)",
    )
    parser.add_argument(
        "--variant",
        default=os.environ.get("OBSCURA_VARIANT") or "stealth",
        help="stealth (default, $OBSCURA_VARIANT) or default",
    )
    parser.add_argument("--force", action="store_true", help="download again even when .obscura/VERSION matches")
    parser.add_argument("--dest", type=Path, default=DEFAULT_DEST, help="folder to install into (default: .obscura/)")
    args = parser.parse_args(argv)
    if args.variant not in ("stealth", "default"):
        parser.error(f"--variant must be stealth or default, got {args.variant!r}")
    return args


def run(argv: list[str]) -> int:
    args = parse_args(argv)
    version: str = args.version or pinned_version()
    arch, os_name = target(sys.platform, platform.machine())
    asset = asset_name(arch, os_name, args.variant)
    bin_name = "obscura.exe" if os_name == "windows" else "obscura"
    dest: Path = args.dest.expanduser().resolve()

    if not args.force and is_installed(dest, bin_name, version, asset):
        print(f"Obscura {version} ({asset}) already present in {shown(dest)}")
        return 0

    print(f"Looking up {asset} in {REPO} {version}…")
    meta = find_release_asset(os.environ.get("OBSCURA_API_URL") or DEFAULT_API, version, asset)
    expected = re.sub(r"^sha256:", "", str(meta.get("digest") or "")).lower()
    url = str(meta.get("browser_download_url") or "")
    if not url:
        fail(f"Asset {asset} in release {version} has no download URL")
    size = meta.get("size") if isinstance(meta.get("size"), int) else None

    dest.mkdir(parents=True, exist_ok=True)
    archive = dest / f"{asset}.part"
    staging = Path(tempfile.mkdtemp(prefix=".unpack-", dir=dest))
    try:
        print(f"Downloading {url} ({int(size / 1048576 + 0.5) if size else '?'} MB)…")
        actual = download(url, archive, size)
        if expected and actual != expected:
            fail(f"Checksum mismatch for {asset}: expected {expected}, got {actual}")
        print(f"sha256 verified: {actual}" if expected else f"sha256 (no digest published to compare): {actual}")

        extract(archive, staging, is_zip=asset.endswith(".zip"), name=asset)
        if not (staging / bin_name).is_file():
            fail(f"{asset} does not contain {bin_name}")
        binary = staging / bin_name
        if os_name != "windows":
            binary.chmod(0o755)
        if os_name == "macos":
            # a quarantined binary would be blocked by Gatekeeper; the attribute is usually absent
            subprocess.run(["xattr", "-d", "com.apple.quarantine", str(binary)], capture_output=True, check=False)
        out = binary_version(binary)
        # the old marker goes first, so an interrupted install never claims the old version
        (dest / "VERSION").unlink(missing_ok=True)
        install(staging, dest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        with contextlib.suppress(FileNotFoundError):
            archive.unlink()
    (dest / "VERSION").write_bytes(marker_text(version, asset).encode("utf-8"))  # "\n" on Windows too
    print(f"Installed {out} → {shown(dest)}{bin_name}")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):  # not a text stream
            stream.reconfigure(errors="backslashreplace", line_buffering=True)  # type: ignore[attr-defined]
    try:
        return run(sys.argv[1:] if argv is None else argv)
    except Failure as err:
        print(err, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    except OSError as err:
        print(f"download-obscura: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
