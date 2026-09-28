"""Fixtures for the website builder tests: a small, complete checkout to build."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from sws_tools.website.pages import PAGES

LANDING = """<!doctype html>
<!-- @head -->
<body>
<!-- @icons -->
<!-- @header -->
<main id="main">
  <section id="features"></section><section id="agents"></section><section id="integrations"></section>
  <p>{{TOOLS_BROWSER}} browser tools, {{TOOLS_ALL}} in all ({{TOOLS_AGENTS}} agents, {{TOOLS_SCRIPTS}} scripts), v{{VERSION}}</p>
  <a href="{{REPO}}">repo</a> <a href="{{LM_STUDIO_INSTALL}}">install</a> <a href="docs/tools.html#details">details</a>
  <img src="assets/img/shot.png" alt="">
  <pre><code data-hl="json">{{MODELS_EXAMPLE}}</code></pre>
  <pre><code data-hl="bash">npm run site:build &amp;&amp; echo &quot;done&quot;</code></pre>
</main>
<!-- @footer -->
</body>
</html>
"""

MANIFEST: dict[str, Any] = {
    "$comment": "test manifest",
    "total": 5,
    "browser": 3,
    "groups": {
        "core": {"count": 2, "tools": ["browser_navigate", "browser_click"]},
        "content": {"count": 1, "tools": ["browser_markdown"]},
        "agents": {"count": 1, "tools": ["agent_run"]},
        "scripts": {"count": 1, "tools": ["script_run"]},
        "snapshots": {"count": 0, "tools": []},
    },
}

MakeRepo = Callable[..., Path]


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def make_repo(tmp_path: Path) -> MakeRepo:
    """`make_repo(docs={src: markdown}, landing=..., manifest=...)`: a checkout with every document the
    site lists (a heading and a paragraph each, unless `docs` gives its text), site/ assets, one
    image, the models example, package.json and docs/tools.json."""

    def make(
        docs: dict[str, str] | None = None,
        landing: str = LANDING,
        manifest: object = MANIFEST,
    ) -> Path:
        root = tmp_path / "repo"
        write(root / "package.json", json.dumps({"name": "stealth-web-search", "version": "9.8.7"}))
        write(root / "config" / "models.example.json", '[\n  { "name": "Example", "models": ["m"] }\n]\n')
        write(root / "site" / "index.html", landing)
        write(root / "site" / "assets" / "site.css", "body { color: black }\n")
        write(root / "site" / "assets" / "site.js", "// site\n")
        write(root / "site" / "assets" / "logo.svg", "<svg/>\n")
        (root / "docs" / "images").mkdir(parents=True)
        (root / "docs" / "images" / "shot.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        write(root / "src" / "main.ts", "// main\n")
        if manifest is not None:
            write(root / "docs" / "tools.json", json.dumps(manifest, indent=2))
        for page in PAGES:
            write(root / page.src, f"# {page.nav}\n\nAbout {page.nav.lower()}.\n\n## Details\n\nMore.\n")
        for src, text in (docs or {}).items():
            write(root / src, text)
        return root

    return make
