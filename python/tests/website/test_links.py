"""Link rewriting between the documents, and the link and anchor check of the built site."""

from __future__ import annotations

from pathlib import Path

import pytest

from sws_tools.website.links import LinkRewriter, check_links
from sws_tools.website.pages import REPO

from .conftest import write


@pytest.fixture
def rewrite(tmp_path: Path) -> LinkRewriter:
    root = tmp_path / "repo"
    for name in ("docs/TOOLS.md", "docs/images/a.png", "src/main.ts", "examples/x.json", ".env.example", "LICENSE"):
        write(root / name, "x")
    return LinkRewriter(root)


@pytest.mark.parametrize(
    ("href", "src", "target"),
    [
        # absolute URLs and same-page anchors are left alone
        ("https://example.com/a?b=1#c", "docs/A.md", "https://example.com/a?b=1#c"),
        ("mailto:someone@example.com", "docs/A.md", "mailto:someone@example.com"),
        ("//cdn.example.com/x.js", "docs/A.md", "//cdn.example.com/x.js"),
        ("#section", "docs/A.md", "#section"),
        # links between the documents become links between pages, keeping the anchor
        ("TOOLS.md", "docs/CLIENTS.md", "tools.html"),
        ("TOOLS.md#browser_click", "docs/CLIENTS.md", "tools.html#browser_click"),
        ("./CONFIGURATION.md#sub-agents", "docs/MODELS.md", "configuration.html#sub-agents"),
        ("docs/TOOLS.md", "CONTRIBUTING.md", "tools.html"),
        ("../CHANGELOG.md", "docs/GETTING_STARTED.md", "changelog.html"),
        ("TOOLS.md#a#b", "docs/CLIENTS.md", "tools.html#a"),  # like JS split(/(?=#)/): the rest is dropped
        # images in docs/images stay on the site
        ("images/a.png", "docs/AGENTS.md", "images/a.png"),
        ("docs/images/a.png", "CONTRIBUTING.md", "images/a.png"),
        # any other file of the repository points to GitHub: blob for files, tree for folders
        ("../src/main.ts", "docs/ARCHITECTURE.md", f"{REPO}/blob/main/src/main.ts"),
        ("../src/main.ts#L10", "docs/ARCHITECTURE.md", f"{REPO}/blob/main/src/main.ts#L10"),
        ("../src/", "docs/ARCHITECTURE.md", f"{REPO}/tree/main/src/"),
        ("../src", "docs/ARCHITECTURE.md", f"{REPO}/tree/main/src"),
        ("../.env.example", "docs/CONFIGURATION.md", f"{REPO}/blob/main/.env.example"),
        ("LICENSE", "CONTRIBUTING.md", f"{REPO}/blob/main/LICENSE"),
        # %20 and friends are decoded to find the file; reserved escapes such as %2F are not
        ("../examples/x%2Ejson", "docs/CLIENTS.md", f"{REPO}/blob/main/examples/x.json"),
    ],
)
def test_rewrite(rewrite: LinkRewriter, href: str, src: str, target: str) -> None:
    assert rewrite(href, src) == target
    assert rewrite.broken == []


@pytest.mark.parametrize(
    ("href", "problem"),
    [
        ("./missing.md", "docs/A.md: link to ./missing.md (docs/missing.md does not exist)"),
        ("../../outside.md", "docs/A.md: link to ../../outside.md (../outside.md does not exist)"),
        ("../examples%2Fx.json", "docs/A.md: link to ../examples%2Fx.json (examples%2Fx.json does not exist)"),
        ("GETTING%20STARTED.md", "docs/A.md: link to GETTING%20STARTED.md (docs/GETTING STARTED.md does not exist)"),
        ("bad%E0%A4%A.md", "docs/A.md: link to bad%E0%A4%A.md (malformed percent-encoding)"),
    ],
)
def test_broken_links_are_collected_and_left_as_written(rewrite: LinkRewriter, href: str, problem: str) -> None:
    assert rewrite(href, "docs/A.md") == href
    assert rewrite.broken == [problem]


def test_a_link_out_of_the_checkout_is_broken_even_when_the_file_exists(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    write(tmp_path / "secret.txt", "x")
    rewrite = LinkRewriter(root)
    assert rewrite("../../secret.txt", "docs/A.md") == "../../secret.txt"
    assert rewrite.broken == ["docs/A.md: link to ../../secret.txt (../secret.txt does not exist)"]


# ------------------------------------------------------------------------------------ check_links


@pytest.fixture
def site(tmp_path: Path) -> Path:
    out = tmp_path / "_site"
    write(out / "assets" / "site.css", "")
    write(out / "docs" / "images" / "a.png", "")
    write(
        out / "docs" / "tools.html",
        '<h2 id="browser_click">x</h2><h3 id="caf%C3%A9">y</h3><h3 id="café">z</h3><p id="a&amp;b">w</p>',
    )
    return out


def page(site: Path, body: str, name: str = "docs/page.html") -> None:
    write(
        site / name, f'<html><head><link rel="stylesheet" href="../assets/site.css"></head><body>{body}</body></html>'
    )


def test_a_site_with_good_links_passes(site: Path) -> None:
    page(
        site,
        '<a href="tools.html">t</a> <a href="tools.html#browser_click">c</a> <a href="#top">self</a>'
        '<h1 id="top">Top</h1> <img src="images/a.png" alt=""> <a href="https://example.com/x#y">e</a>'
        '<a href="//example.com">p</a> <a href="mailto:x@example.com">m</a> <a href="tools.html#caf%C3%A9">u</a>'
        '<a href="../docs/">dir</a> <a href="tools.html?x=1&amp;y=2">q</a>',
    )
    problems = check_links(site)
    # a query string is part of the file name for the check, as in the TypeScript builder
    assert problems == ["docs/page.html: tools.html?x=1&y=2 (no such file)"]


def test_missing_files_and_anchors_are_reported(site: Path) -> None:
    page(
        site,
        '<a href="nope.html">a</a> <img src="images/missing.png"> <a href="tools.html#nope">b</a>'
        '<a href="#nowhere">c</a> <a href="tools.html#bad%E0%A4%A">d</a> <a href="tools.html#">e</a>',
    )
    assert check_links(site) == [
        "docs/page.html: nope.html (no such file)",
        "docs/page.html: images/missing.png (no such file)",
        "docs/page.html: tools.html#nope (no #nope on that page)",
        "docs/page.html: #nowhere (no #nowhere on that page)",
        "docs/page.html: tools.html#bad%E0%A4%A (malformed percent-encoding)",
    ]


def test_anchors_on_other_file_types_are_not_checked(site: Path) -> None:
    page(site, '<a href="../assets/site.css#anything">css</a>')
    assert check_links(site) == []


def test_the_404_page_is_skipped(site: Path) -> None:
    page(site, '<a href="/stealth-web-search/docs/missing.html">absolute</a>', name="404.html")
    assert check_links(site) == []
