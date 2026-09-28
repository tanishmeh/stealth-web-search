"""Command line of `sws-site`: builds the website into _site/, and with --serve also serves it.

npm run site:build            # writes _site/
npm run site:serve            # builds, then serves _site/ on http://127.0.0.1:4173
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from .._repo import repo_root
from .build import BuildError, build
from .serve import create_server

DEFAULT_PORT = 4173


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a port number: {value!r}") from None
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError(f"not a port number: {value!r}")
    return port


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sws-site",
        description=(
            "Build the Stealth Web Search website (GitHub Pages) into _site/: the landing page from "
            "site/index.html and one page per Markdown document. Fails on a broken link or anchor."
        ),
        allow_abbrev=False,
    )
    parser.add_argument("--serve", action="store_true", help="after the build, serve _site/ on 127.0.0.1")
    parser.add_argument(
        "--port",
        type=_port,
        default=None,
        help=f"port for --serve (default: $PORT, else {DEFAULT_PORT})",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command with `argv` (default: sys.argv[1:]) and return the process exit code."""
    parser = _parser()
    args = parser.parse_args(argv)
    port: int = args.port if args.port is not None else DEFAULT_PORT
    if args.port is None and os.environ.get("PORT"):
        try:
            port = _port(os.environ["PORT"])
        except argparse.ArgumentTypeError as e:
            parser.error(f"PORT: {e}")
    try:
        root = repo_root()
        out = root / "_site"
        pages = build(root, out)
        print(f"site built: {pages} pages in {_relative(out, root)}/")
        if args.serve:
            server = create_server(out, port)
            with server:
                print(f"serving {_relative(out, root)}/ on http://127.0.0.1:{server.server_address[1]}/", flush=True)
                server.serve_forever()
    except BuildError as e:
        print(f"sws-site: {e}", file=sys.stderr)
        return 1
    except (RuntimeError, OSError) as e:
        print(f"sws-site: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)
