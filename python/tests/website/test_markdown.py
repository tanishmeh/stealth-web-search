"""Markdown to HTML for the documentation pages. The expected HTML is what the TypeScript builder
(marked and highlight.js) wrote for the same input."""

from __future__ import annotations

from pathlib import Path

import pytest
from markdown_it import MarkdownIt

from sws_tools.website.links import LinkRewriter
from sws_tools.website.markdown import Rendered, TocEntry, create_markdown, render
from sws_tools.website.pages import REPO

from .conftest import write


@pytest.fixture(scope="module")
def md() -> MarkdownIt:
    return create_markdown()


@pytest.fixture
def root(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    for name in ("docs/TOOLS.md", "docs/images/shot.png", "README.md", "src/main.ts"):
        write(root / name, "x")
    return root


def run(md: MarkdownIt, root: Path, text: str, src: str = "docs/A.md") -> tuple[Rendered, list[str]]:
    rewrite = LinkRewriter(root)
    return render(md, text, src, rewrite), rewrite.broken


def test_headings_get_ids_anchors_and_a_toc(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, "# The title\n\n## Setup `npm`\n\n### Step one\n\n#### Deep\n\n## Setup `npm`\n")
    assert r.title == "The title"
    assert r.html == (
        '<h1 id="the-title">The title</h1>\n'
        '<h2 id="setup-npm"><a class="anchor" href="#setup-npm" aria-label="Link to this section"></a>'
        "Setup <code>npm</code></h2>\n"
        '<h3 id="step-one"><a class="anchor" href="#step-one" aria-label="Link to this section"></a>Step one</h3>\n'
        '<h4 id="deep"><a class="anchor" href="#deep" aria-label="Link to this section"></a>Deep</h4>\n'
        '<h2 id="setup-npm-1"><a class="anchor" href="#setup-npm-1" aria-label="Link to this section"></a>'
        "Setup <code>npm</code></h2>\n"
    )
    # h2 and h3 only, with the heading's text
    assert r.toc == [
        TocEntry(2, "setup-npm", "Setup npm"),
        TocEntry(3, "step-one", "Step one"),
        TocEntry(2, "setup-npm-1", "Setup npm"),
    ]


def test_only_the_first_h1_is_the_title(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, "Intro.\n\n# First\n\n# Second\n")
    assert r.title == "First"
    assert '<h1 id="second"><a class="anchor" href="#second"' in r.html


def test_without_h1_the_title_is_the_file(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, "## Only h2\n")
    assert r.title == "docs/A.md"


def test_description_is_the_first_paragraphs_text(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, "# T\n\nThe *first*\nparagraph, with [a link](https://example.com) & `code`.\n\nSecond.\n")
    assert r.description == "The first paragraph, with a link & code."
    long, _ = run(md, root, "# T\n\n" + "word " * 100 + "\n")
    assert len(long.description) == 200


def test_code_fences(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, "```bash\necho hi # note\n```\n\n```Text\n<plain> & 'text'\n```\n\n```\nno <lang>\n```\n")
    head = '<div class="code"><div class="code-head"><span class="code-lang">{}</span><button class="copy" type="button" aria-label="Copy code">Copy</button></div>'
    assert (
        r.html
        == (
            head.format("bash") + '<pre><code class="hljs language-bash"><span class="hljs-built_in">echo</span> hi '
            '<span class="hljs-comment"># note</span></code></pre></div>\n'
            # the language is lowercased; a text fence has no label; highlight.js escapes quotes
            + head.format("")
            + '<pre><code class="hljs language-text">&lt;plain&gt; &amp; &#x27;text&#x27;</code></pre></div>\n'
            + head.format("")
            + '<pre><code class="hljs">no &lt;lang&gt;</code></pre></div>\n'
        )
    )


def test_an_unknown_language_is_labelled_but_not_highlighted(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, '```nginx title="x"\nserver { listen 80; }\n```\n')
    assert '<span class="code-lang">nginx</span>' in r.html
    assert '<pre><code class="hljs">server { listen 80; }</code></pre>' in r.html


def test_mermaid_fences_are_left_for_the_browser(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, "```mermaid\ngraph LR; A-->B\n```\n")
    assert r.mermaid is True
    assert r.html == '<div class="diagram"><pre class="mermaid">graph LR; A--&gt;B</pre></div>\n'
    assert run(md, root, "text\n")[0].mermaid is False


def test_links_are_rewritten_and_external_ones_marked(md: MarkdownIt, root: Path) -> None:
    text = (
        '[tools](TOOLS.md#browser_click) [readme](../README.md "Read me") [ext](https://example.com) '
        "[site](https://tanishmeh.github.io/stealth-web-search/docs/) [gone](gone.md) https://example.org/x, "
        'www.example.net and example.com\n\n![Shot *one*](images/shot.png "T")\n'
    )
    r, broken = run(md, root, text)
    assert r.html == (
        '<p><a href="tools.html#browser_click">tools</a> '
        f'<a href="{REPO}/blob/main/README.md" title="Read me" rel="noopener">readme</a> '
        '<a href="https://example.com" rel="noopener">ext</a> '
        '<a href="https://tanishmeh.github.io/stealth-web-search/docs/">site</a> '
        '<a href="gone.md">gone</a> <a href="https://example.org/x" rel="noopener">https://example.org/x</a>, '
        # GitHub autolinks www. addresses, but not bare domains
        '<a href="http://www.example.net" rel="noopener">www.example.net</a> and example.com</p>\n'
        '<p><img src="images/shot.png" alt="Shot *one*" title="T" loading="lazy" decoding="async"></p>\n'
    )
    assert broken == ["docs/A.md: link to gone.md (docs/gone.md does not exist)"]


def test_raw_html_is_shown_as_text_but_comments_pass(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, "<!-- generated -->\n\n<select>\n<option>x</option>\n</select>\n\nInline <kbd>Ctrl</kbd>.\n")
    assert r.html == (
        "<!-- generated -->"
        "&lt;select&gt;\n&lt;option&gt;x&lt;/option&gt;\n&lt;/select&gt;"
        "<p>Inline &lt;kbd&gt;Ctrl&lt;/kbd&gt;.</p>\n"
    )


def test_tables_scroll_in_a_wrapper(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, "| A | B | C |\n|:--|:-:|--:|\n| `x \\| y` | 2 | 3 |\n| 4 | 5 | 6 |\n\n| Only |\n|---|\n")
    assert r.html == (
        '<div class="table-wrap"><table><thead><tr><th style="text-align:left">A</th>'
        '<th style="text-align:center">B</th><th style="text-align:right">C</th></tr></thead><tbody>'
        '<tr><td style="text-align:left"><code>x | y</code></td><td style="text-align:center">2</td>'
        '<td style="text-align:right">3</td></tr>\n'
        '<tr><td style="text-align:left">4</td><td style="text-align:center">5</td><td style="text-align:right">6</td></tr>'
        "</tbody></table></div>\n"
        '<div class="table-wrap"><table><thead><tr><th>Only</th></tr></thead><tbody></tbody></table></div>\n'
    )


def test_lists_and_text_are_written_like_marked(md: MarkdownIt, root: Path) -> None:
    r, _ = run(md, root, '- a\n- b\n  - c\n\n1. one\n\n2. two\n\n3) x\n\nIt\'s "q" &copy; ~~old~~ a  \nb\n')
    assert r.html == (
        "<ul>\n<li>a</li>\n<li>b<ul>\n<li>c</li>\n</ul>\n</li>\n</ul>\n"
        "<ol>\n<li><p>one</p>\n</li>\n<li><p>two</p>\n</li>\n</ol>\n"
        '<ol start="3">\n<li>x</li>\n</ol>\n'
        "<p>It&#39;s &quot;q&quot; &copy; <del>old</del> a<br>b</p>\n"
    )
