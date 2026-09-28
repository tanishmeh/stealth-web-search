"""The whole build: pages, landing page, small files, the tool counts and the checks that fail it."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from sws_tools.website.build import BuildError, ToolCounts, build, tool_counts
from sws_tools.website.pages import MERMAID, PAGES, SITE

from .conftest import MANIFEST, MakeRepo, write


def test_builds_every_page(make_repo: MakeRepo) -> None:
    root = make_repo()
    assert build(root) == len(PAGES) + 1
    out = root / "_site"
    for name in (".nojekyll", "404.html", "robots.txt", "sitemap.xml", "index.html", "docs/index.html"):
        assert (out / name).is_file(), name
    for page in PAGES:
        assert (out / "docs" / f"{page.slug}.html").is_file(), page.slug
    # assets, and the screenshots twice: for the docs and for the landing page
    for name in ("assets/site.css", "assets/site.js", "assets/logo.svg", "docs/images/shot.png", "assets/img/shot.png"):
        assert (out / name).is_file(), name
    assert (out / ".nojekyll").read_bytes() == b""
    assert (out / "robots.txt").read_text() == f"User-agent: *\nAllow: /\nSitemap: {SITE}sitemap.xml\n"
    sitemap = (out / "sitemap.xml").read_text()
    assert re.findall(r"<loc>([^<]+)</loc>", sitemap) == [SITE, *(f"{SITE}docs/{p.slug}.html" for p in PAGES)]


def test_a_documentation_page(make_repo: MakeRepo) -> None:
    root = make_repo({"docs/CLIENTS.md": "# Connect clients\n\nHow to connect.\n\n## Claude Code\n\n### Setup\n"})
    build(root)
    html = (root / "_site" / "docs" / "clients.html").read_text()
    assert "<title>Connect clients · Stealth Web Search</title>" in html
    assert '<meta name="description" content="How to connect.">' in html
    assert f'<link rel="canonical" href="{SITE}docs/clients.html">' in html
    # the sidebar marks this page; the pager links its neighbours
    assert '<li><a href="clients.html" aria-current="page">Connect MCP clients</a></li>' in html
    assert '<a class="pager-prev" href="getting-started.html"><span>Previous</span>Getting started</a>' in html
    assert '<a class="pager-next" href="lm-studio.html"><span>Next</span>LM Studio</a>' in html
    assert (
        '<nav class="toc" aria-label="On this page"><p class="side-title">On this page</p><ul>'
        '<li class="toc-2"><a href="#claude-code">Claude Code</a></li><li class="toc-3"><a href="#setup">Setup</a></li>'
        "</ul></nav>"
    ) in html
    assert 'href="https://github.com/tanishmeh/stealth-web-search/edit/main/docs/CLIENTS.md"' in html
    assert MERMAID not in html  # the diagram script only where there is a diagram
    first = (root / "_site" / "docs" / "getting-started.html").read_text()
    assert '<span></span>\n      <a class="pager-next"' in first


def test_pages_with_diagrams_load_mermaid(make_repo: MakeRepo) -> None:
    root = make_repo({"docs/ARCHITECTURE.md": "# Architecture\n\n```mermaid\ngraph LR; A-->B\n```\n"})
    build(root)
    assert f"import mermaid from '{MERMAID}';" in (root / "_site" / "docs" / "architecture.html").read_text()


def test_the_landing_page(make_repo: MakeRepo) -> None:
    root = make_repo()
    build(root)
    html = (root / "_site" / "index.html").read_text()
    assert "{{" not in html
    assert "<!-- @" not in html
    assert "<p>3 browser tools, 5 in all (1 agents, 1 scripts), v9.8.7</p>" in html
    assert "<title>Stealth Web Search: a stealth browser and research agents for your AI, over MCP</title>" in html
    assert '<a href="https://lmstudio.ai/install-mcp?name=stealth-web-search&amp;config=' in html
    # code samples are highlighted at build time; the models example is escaped first, then highlighted
    assert (
        '<code class="hljs language-json"><span class="hljs-punctuation">[</span>\n  <span class="hljs-punctuation">{</span> '
        '<span class="hljs-attr">&quot;name&quot;</span>'
    ) in html
    assert (
        '<code class="hljs language-bash">npm run site:build &amp;&amp; <span class="hljs-built_in">echo</span> '
        '<span class="hljs-string">&quot;done&quot;</span></code>'
    ) in html


def test_a_rebuild_starts_from_scratch(make_repo: MakeRepo) -> None:
    root = make_repo()
    write(root / "_site" / "stale.html", '<a href="nowhere.html">x</a>')
    build(root)
    assert not (root / "_site" / "stale.html").exists()


def test_broken_links_and_anchors_fail_the_build(make_repo: MakeRepo) -> None:
    root = make_repo(
        {
            "docs/AGENTS.md": (
                "# Agents\n\n[missing](NOPE.md) [anchor](TOOLS.md#no-such-tool) [self](#nowhere) [ok](TOOLS.md#details)\n"
            ),
        }
    )
    with pytest.raises(BuildError) as error:
        build(root)
    assert str(error.value) == (
        "broken links:\n"
        "  docs/AGENTS.md: link to NOPE.md (docs/NOPE.md does not exist)\n"
        "  docs/agents.html: NOPE.md (no such file)\n"
        "  docs/agents.html: tools.html#no-such-tool (no #no-such-tool on that page)\n"
        "  docs/agents.html: #nowhere (no #nowhere on that page)"
    )


def test_a_missing_document_fails_the_build(make_repo: MakeRepo) -> None:
    root = make_repo()
    (root / "docs" / "LOGGING.md").unlink()
    (root / "SECURITY.md").unlink()
    with pytest.raises(BuildError, match=r"^missing documents: docs/LOGGING.md, SECURITY.md$"):
        build(root)


def test_an_unknown_placeholder_fails_the_build(make_repo: MakeRepo) -> None:
    root = make_repo(landing="<p>{{VERSION}} {{NOT_A_THING}}</p>")
    with pytest.raises(BuildError, match=r"^site/index.html: unknown placeholder \{\{NOT_A_THING\}\}$"):
        build(root)


def test_an_unknown_sample_language_fails_the_build(make_repo: MakeRepo) -> None:
    root = make_repo(landing='<pre><code data-hl="cobol">MOVE A TO B</code></pre>')
    with pytest.raises(BuildError, match=r'unknown code language "cobol"'):
        build(root)


# ---------------------------------------------------------------------------------------- counts


def test_tool_counts_come_from_the_manifest(make_repo: MakeRepo) -> None:
    assert tool_counts(make_repo()) == ToolCounts(all=5, browser=3, agents=1, scripts=1)


@pytest.mark.parametrize(
    ("manifest", "problem"),
    [
        (None, r"docs/tools.json is missing: run `npm run docs:tools`"),
        ({"total": 1}, r"docs/tools.json does not have the expected shape"),
        ({**MANIFEST, "groups": {"core": {"count": 1, "tools": ["browser_navigate"]}}}, r"expected shape"),
        ({**MANIFEST, "total": 6}, r"docs/tools.json is inconsistent"),
        ({**MANIFEST, "browser": 2}, r"inconsistent"),
        (
            {
                **MANIFEST,
                "groups": {**MANIFEST["groups"], "core": {"count": 3, "tools": ["browser_navigate", "browser_click"]}},
            },
            r"inconsistent",
        ),
    ],
)
def test_a_missing_or_bad_manifest_fails(make_repo: MakeRepo, manifest: object, problem: str) -> None:
    root = make_repo(manifest=manifest)
    with pytest.raises(BuildError, match=problem):
        tool_counts(root)


def test_invalid_json_in_the_manifest_fails(make_repo: MakeRepo) -> None:
    root = make_repo()
    (root / "docs" / "tools.json").write_text("{ not json")
    with pytest.raises(BuildError, match=r"docs/tools.json is not valid JSON .*npm run docs:tools"):
        tool_counts(root)


# ------------------------------------------------------------------------------ this repository


def test_the_manifest_matches_the_tool_reference(repo_root: Path) -> None:
    """docs/tools.json and docs/TOOLS.md are written together by `npm run docs:tools`: the same tools in
    the same groups (CI also checks that both match the registry)."""
    manifest = json.loads((repo_root / "docs" / "tools.json").read_text(encoding="utf-8"))
    groups: dict[str, list[str]] = {}
    group = None
    for line in (repo_root / "docs" / "TOOLS.md").read_text(encoding="utf-8").splitlines():
        if m := re.match(r"^## Group `(\w+)`$", line):
            group = m.group(1)
            groups[group] = []
        elif (m := re.match(r"^### (\S+)$", line)) and group:
            groups[group].append(m.group(1))
    assert {g: v["tools"] for g, v in manifest["groups"].items() if v["tools"]} == groups
    names = [name for tools in groups.values() for name in tools]
    assert manifest["total"] == len(names)
    assert manifest["browser"] == sum(name.startswith("browser_") for name in names)
    assert f"The server exposes {len(names)} tools" in (repo_root / "docs" / "TOOLS.md").read_text(encoding="utf-8")


def test_the_site_of_this_repository_builds(repo_root: Path, tmp_path: Path) -> None:
    out = tmp_path / "_site"
    assert build(repo_root, out) == len(PAGES) + 1
    counts = tool_counts(repo_root)
    landing = (out / "index.html").read_text(encoding="utf-8")
    assert f'<div class="stat"><b>{counts.all}</b><span>MCP tools</span></div>' in landing
    assert f"<p>{counts.browser} <code>browser_*</code> tools:" in landing
