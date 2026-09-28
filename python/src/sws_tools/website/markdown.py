"""Markdown to HTML for the documentation pages (GitHub-flavoured, rendered with markdown-it-py).

The output follows the TypeScript builder it replaced, which used marked: heading ids from the
GitHub slugger with a '#' anchor on h2-h6, fenced code in a box with a language label and a Copy
button, mermaid fences left for the browser to draw, rewritten links, raw HTML shown as text, tables
in a scrolling wrapper, and marked's escaping and line breaks.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from linkify_it import LinkifyIt  # type: ignore[import-untyped]
from markdown_it import MarkdownIt
from markdown_it.common.utils import unescapeAll
from markdown_it.renderer import RendererHTML
from markdown_it.rules_core import StateCore
from markdown_it.token import Token
from markdown_it.utils import EnvType, OptionsDict

from .escaping import esc, escape_text, strip_tags
from .highlight import highlight, is_known
from .jscompat import JS_WHITESPACE_RUN, js_slice, js_trim
from .links import LinkRewriter
from .pages import SITE
from .slugger import Slugger

_FIRST_PARAGRAPH = re.compile(r"<p>([\s\S]*?)</p>")


@dataclass(frozen=True)
class TocEntry:
    level: int
    id: str
    text: str


@dataclass
class Rendered:
    title: str
    description: str
    html: str
    toc: list[TocEntry]
    mermaid: bool


@dataclass
class _Page:
    """What rendering one document collects (passed to the renderer rules in env['page'])."""

    src: str
    rewrite: LinkRewriter
    slug: Slugger = field(default_factory=Slugger)
    toc: list[TocEntry] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    """The document's lines (an HTML block's ending depends on the line after it)."""
    title: str = ""
    mermaid: bool = False


def _page(env: EnvType) -> _Page:
    page = env["page"]
    assert isinstance(page, _Page)
    return page


class _Renderer(RendererHTML):
    """markdown-it's HTML renderer with the site's rules; each method named after a token type
    renders that token."""

    def renderToken(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        # markdown-it's own, without its line breaks after <li> and before a block that follows a
        # tight list item's text, which marked does not write
        token = tokens[idx]
        if token.hidden:
            return ""
        result = ("</" if token.nesting == -1 else "<") + token.tag + self.renderAttrs(token)
        need_lf = token.block and token.type != "list_item_open"
        if need_lf and token.nesting == 1 and idx + 1 < len(tokens):
            following = tokens[idx + 1]
            # no break before inline content, or between an opening and its closing tag
            if (
                following.type == "inline"
                or following.hidden
                or (following.nesting == -1 and following.tag == token.tag)
            ):
                need_lf = False
        return result + (">\n" if need_lf else ">")

    # --------------------------------------------------------------------------------- headings

    def heading_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        page = _page(env)
        depth = int(tokens[idx].tag[1])
        inline = tokens[idx + 1]
        inner = self.renderInline(inline.children or [], options, env)
        inline.children = []  # rendered here, with the anchor
        text = strip_tags(inner)
        anchor = page.slug(text)
        if depth == 1 and not page.title:
            page.title = text
            return f'<h1 id="{anchor}">{inner}'
        if depth in (2, 3):
            page.toc.append(TocEntry(depth, anchor, text))
        return (
            f'<h{depth} id="{anchor}"><a class="anchor" href="#{anchor}" aria-label="Link to this section"></a>{inner}'
        )

    def heading_close(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return f"</{tokens[idx].tag}>\n"

    # ------------------------------------------------------------------------------------- code

    def fence(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        token = tokens[idx]
        info = js_trim(unescapeAll(token.info)) if token.info else ""
        language = JS_WHITESPACE_RUN.split(info)[0].lower() if info else ""
        # marked leaves out the final line break of the code
        text = token.content.rstrip("\n") if token.type == "code_block" else token.content.removesuffix("\n")
        if language == "mermaid":
            _page(env).mermaid = True
            return f'<div class="diagram"><pre class="mermaid">{esc(text)}</pre></div>\n'
        known = is_known(language)
        body = highlight(text, language) if known else None
        label = esc(language) if language and language not in ("text", "plaintext") else ""
        language_class = f" language-{language}" if known else ""
        return (
            f'<div class="code"><div class="code-head"><span class="code-lang">{label}</span>'
            '<button class="copy" type="button" aria-label="Copy code">Copy</button></div>'
            f'<pre><code class="hljs{language_class}">{body if body is not None else esc(text)}</code></pre></div>\n'
        )

    code_block = fence

    def code_inline(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return f"<code>{escape_text(tokens[idx].content, entities=False)}</code>"

    # ------------------------------------------------------------------------- links and images

    def link_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        page = _page(env)
        token = tokens[idx]
        target = page.rewrite(str(token.attrGet("href") or ""), page.src)
        title = token.attrGet("title")
        title_attr = f' title="{esc(str(title))}"' if title else ""
        external = re.match(r"https?:", target) is not None and not target.startswith(SITE)
        rel = ' rel="noopener"' if external else ""
        return f'<a href="{esc(target)}"{title_attr}{rel}>'

    def image(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        page = _page(env)
        token = tokens[idx]
        target = page.rewrite(str(token.attrGet("src") or ""), page.src)
        alt = re.sub(r"\\([\[\]])", r"\1", token.content)  # the label as written, like marked
        title = token.attrGet("title")
        title_attr = f' title="{esc(str(title))}"' if title else ""
        return f'<img src="{esc(target)}" alt="{esc(alt)}"{title_attr} loading="lazy" decoding="async">'

    # ----------------------------------------------------------------------------------- tables

    def table_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return '<div class="table-wrap"><table>'

    def table_close(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return "</table></div>\n"

    def thead_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return "<thead>"

    def thead_close(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        has_body = idx + 1 < len(tokens) and tokens[idx + 1].type == "tbody_open"
        return "</thead>" if has_body else "</thead><tbody></tbody>"

    def tbody_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return "<tbody>"

    def tbody_close(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return "</tbody>"

    def tr_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return "<tr>"

    def tr_close(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        # body rows are separated by a line break
        return "</tr>\n" if idx + 1 < len(tokens) and tokens[idx + 1].type == "tr_open" else "</tr>"

    def th_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return self._cell(tokens[idx])

    td_open = th_open

    def th_close(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return f"</{tokens[idx].tag}>"

    td_close = th_close

    @staticmethod
    def _cell(token: Token) -> str:
        style = token.attrGet("style")
        return f'<{token.tag} style="{style}">' if style else f"<{token.tag}>"

    # --------------------------------------------------------------------------- inline and HTML

    def text(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return escape_text(tokens[idx].content)

    def named_entity(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return tokens[idx].markup

    def hardbreak(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return "<br>"

    def s_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return "<del>"

    def s_close(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return "</del>"

    def html_block(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        token = tokens[idx]
        content = token.content
        lines = _page(env).lines
        if token.map and token.map[1] < len(lines) and not lines[token.map[1]].strip(" \t"):
            content = content.rstrip("\n")  # marked drops the line break when a blank line follows
        return _raw_html(content)

    def html_inline(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        return _raw_html(tokens[idx].content)


def _raw_html(html: str) -> str:
    # raw HTML in a document would become live markup on the site (a stray <select> swallows the
    # page): it is shown as text; comments pass through
    return html if html.lstrip().startswith("<!--") else esc(html)


class _Markdown(MarkdownIt):
    """Link destinations and autolink texts stay as written (marked does not percent-encode them)."""

    def normalizeLink(self, url: str) -> str:
        return url

    def normalizeLinkText(self, link: str) -> str:
        return link


class _GitHubAutolinks(LinkifyIt):  # type: ignore[misc]
    """GitHub's autolinks: URLs with a scheme, www. addresses (as http:// links) and e-mail addresses,
    but not bare domains such as example.com."""

    # every link needs one of these (a scheme, www. or the @ of an e-mail address)
    _HINT = re.compile(r"https?:|ftp:|mailto:|www\.|@", re.IGNORECASE)

    def __init__(self) -> None:
        super().__init__(options={"fuzzy_link": False})
        self._www_tail = re.compile(self.re["src_host_port_strict"] + self.re["src_path"], re.IGNORECASE)
        # bound methods: linkify-it-py would attach plain functions to its class
        self.add("www.", {"validate": self._validate_www, "normalize": self._normalize_www})
        self.add("//", None)  # no protocol-relative //host/path links

    def pretest(self, text: str) -> bool:
        # the same answer as linkify-it's pretest for these options, several times faster (it runs on
        # every paragraph)
        return self._HINT.search(text) is not None

    def _validate_www(self, text: str, pos: int) -> int:
        m = self._www_tail.match(text, pos)
        return len(m.group()) if m else 0

    def _normalize_www(self, match: Any) -> None:
        match.url = f"http://{match.url}"


def _keep_named_entities(state: StateCore) -> None:
    """Named character references (&copy;) stay as written, as marked leaves them (the heading
    slugger sees them too); numeric ones become their character."""
    for token in state.tokens:
        for child in token.children or []:
            if child.type == "text_special" and child.info == "entity" and not child.markup.startswith("&#"):
                child.type = "named_entity"


def create_markdown() -> MarkdownIt:
    """The Markdown parser for the site: GitHub-flavoured (tables, strikethrough, autolinks)."""
    md = _Markdown("gfm-like", {"xhtmlOut": False}, renderer_cls=_Renderer)
    md.core.ruler.before("text_join", "keep_named_entities", _keep_named_entities)
    md.linkify = _GitHubAutolinks()
    return md


def render(md: MarkdownIt, text: str, src: str, rewrite: LinkRewriter) -> Rendered:
    """Render the Markdown document `text` (the file `src`, relative to the repository root)."""
    page = _Page(src, rewrite, lines=text.replace("\r\n", "\n").replace("\r", "\n").split("\n"))
    html = md.render(text, {"page": page})
    m = _FIRST_PARAGRAPH.search(html)
    description = js_slice(js_trim(JS_WHITESPACE_RUN.sub(" ", strip_tags(m.group(1) if m else ""))), 200)
    return Rendered(page.title or src, description, html, page.toc, page.mermaid)
