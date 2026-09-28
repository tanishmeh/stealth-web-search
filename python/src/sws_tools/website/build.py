"""Builds the project website (GitHub Pages) into _site/: the landing page from site/index.html and
one page per Markdown document (docs/*.md and the project files). Links between documents become
links between pages; links to other repository files point to GitHub. The build fails on a broken
internal link or anchor, so the site never ships dead links."""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import templates
from .escaping import esc
from .highlight import highlight
from .jscompat import JS_WHITESPACE
from .links import LinkRewriter, check_links
from .markdown import create_markdown, render
from .pages import LM_STUDIO_INSTALL, NAME, PAGES, REPO, SITE

TOOLS_MANIFEST = "docs/tools.json"
_PLACEHOLDER = re.compile(r"\{\{([A-Z_]+)\}\}")
_CODE_SAMPLE = re.compile(r'<code data-hl="([a-z]+)">([\s\S]*?)</code>')


class BuildError(Exception):
    """The site cannot be built (a missing document, a broken link, a bad placeholder)."""


@dataclass(frozen=True)
class ToolCounts:
    all: int
    browser: int
    agents: int
    scripts: int


def tool_counts(root: Path) -> ToolCounts:
    """The tool counts the landing page shows, from docs/tools.json (written by `npm run docs:tools`
    from the TypeScript tool registry, which Python cannot import)."""
    path = root / TOOLS_MANIFEST
    hint = "run `npm run docs:tools` to regenerate it"
    try:
        data: Any = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BuildError(f"{TOOLS_MANIFEST} is missing: {hint}") from None
    except ValueError as e:
        raise BuildError(f"{TOOLS_MANIFEST} is not valid JSON ({e}): {hint}") from None
    try:
        groups = data["groups"]
        names = [name for group in groups.values() for name in group["tools"]]
        counts = ToolCounts(
            all=int(data["total"]),
            browser=int(data["browser"]),
            agents=len(groups["agents"]["tools"]),
            scripts=len(groups["scripts"]["tools"]),
        )
        consistent = (
            counts.all == len(names)
            and counts.browser == sum(name.startswith("browser_") for name in names)
            and all(group["count"] == len(group["tools"]) for group in groups.values())
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        raise BuildError(f"{TOOLS_MANIFEST} does not have the expected shape: {hint}") from None
    if not consistent:
        raise BuildError(f"{TOOLS_MANIFEST} is inconsistent (its counts do not match its tool lists): {hint}")
    return counts


def _landing(root: Path, counts: ToolCounts) -> str:
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    models_example = (root / "config" / "models.example.json").read_text(encoding="utf-8").rstrip(JS_WHITESPACE)
    variables = {
        "VERSION": str(version),
        "TOOLS_ALL": str(counts.all),
        "TOOLS_BROWSER": str(counts.browser),
        "TOOLS_AGENTS": str(counts.agents),
        "TOOLS_SCRIPTS": str(counts.scripts),
        "REPO": REPO,
        "SITE": SITE,
        "LM_STUDIO_INSTALL": esc(LM_STUDIO_INSTALL),
        "MODELS_EXAMPLE": esc(models_example),
    }
    landing = (root / "site" / "index.html").read_text(encoding="utf-8")
    page_head = templates.head(
        title=f"{NAME}: a stealth browser and research agents for your AI, over MCP",
        description=(
            f"{NAME} gives AI agents a real, JavaScript-rendering, stealthy web browser over MCP, plus sub-agents "
            "that browse, automate and cross-check the web on their own. One Docker container, full logs, a live "
            "view, and LM Studio integration."
        ),
        canonical=SITE,
        base="",
    )
    landing = (
        landing.replace("<!-- @head -->", page_head, 1)
        .replace("<!-- @icons -->", templates.ICONS, 1)
        .replace("<!-- @header -->", templates.header("", "home"), 1)
        .replace("<!-- @footer -->", templates.footer(""), 1)
    )

    def placeholder(m: re.Match[str]) -> str:
        if m.group(1) not in variables:
            raise BuildError(f"site/index.html: unknown placeholder {m.group()}")
        return variables[m.group(1)]

    landing = _PLACEHOLDER.sub(placeholder, landing)

    # code samples on the landing page are highlighted at build time, like the docs
    def code_sample(m: re.Match[str]) -> str:
        language = m.group(1)
        text = (
            m.group(2)
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
            .replace("&#39;", "'")
            .replace("&amp;", "&")
        )
        body = highlight(text, language)
        if body is None:
            raise BuildError(f'site/index.html: unknown code language "{language}"')
        return f'<code class="hljs language-{language}">{body}</code>'

    return _CODE_SAMPLE.sub(code_sample, landing)


def build(root: Path, out: Path | None = None) -> int:
    """Build the site of the checkout at `root` into `out` (default: root/_site). Returns the number of
    pages written; raises BuildError when the site is not fit to publish."""
    out = out or root / "_site"
    shutil.rmtree(out, ignore_errors=True)
    (out / "docs").mkdir(parents=True)
    shutil.copytree(root / "site" / "assets", out / "assets")
    shutil.copytree(root / "docs" / "images", out / "docs" / "images")
    # the landing page shows the screenshots too
    shutil.copytree(root / "docs" / "images", out / "assets" / "img")
    (out / ".nojekyll").write_bytes(b"")

    missing = [p.src for p in PAGES if not (root / p.src).exists()]
    if missing:
        raise BuildError(f"missing documents: {', '.join(missing)}")
    md = create_markdown()
    rewrite = LinkRewriter(root)
    for index, page in enumerate(PAGES):
        rendered = render(md, (root / page.src).read_text(encoding="utf-8"), page.src, rewrite)
        _write(out / "docs" / f"{page.slug}.html", templates.doc_page(page, rendered, index))
    _write(out / "docs" / "index.html", templates.docs_index())

    _write(out / "index.html", _landing(root, tool_counts(root)))
    _write(out / "404.html", templates.not_found())
    _write(out / "sitemap.xml", templates.sitemap())
    _write(out / "robots.txt", templates.robots())

    problems = [*rewrite.broken, *check_links(out)]
    if problems:
        raise BuildError("broken links:\n  " + "\n  ".join(problems))
    return len(PAGES) + 1


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="")
