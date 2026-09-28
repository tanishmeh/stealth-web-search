"""The HTML around the content: head, top bar, footer, the documentation page and the small pages."""

from __future__ import annotations

from typing import Literal

from .escaping import esc
from .markdown import Rendered
from .pages import GROUPS, MERMAID, NAME, PAGES, REPO, SITE, Page

ICONS = """<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="i-github" viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M12 2.2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2.2z"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></symbol>
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></symbol>
</svg>"""

# Diagrams keep their natural size (the box scrolls) and are drawn again when the theme changes.
_MERMAID_SCRIPT = """
  <script type="module">
    import mermaid from '{MERMAID}';
    const nodes = [...document.querySelectorAll('pre.mermaid')];
    for (const n of nodes) n.dataset.src = n.textContent;
    const dark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const draw = () => {
      for (const n of nodes) { n.removeAttribute('data-processed'); n.textContent = n.dataset.src; }
      const d = dark();
      // the site's own colours, so diagrams match the page in both themes
      const themeVariables = d
        ? { background: '#121722', primaryColor: '#1e2534', primaryTextColor: '#e9edf5', primaryBorderColor: '#3b4760', lineColor: '#8a94a7', secondaryColor: '#171d2a', tertiaryColor: '#151b27', clusterBkg: '#151b27', clusterBorder: '#313b4e', edgeLabelBackground: '#121722', titleColor: '#e9edf5' }
        : { background: '#ffffff', primaryColor: '#eef1fb', primaryTextColor: '#111621', primaryBorderColor: '#b9c1dc', lineColor: '#5c667a', secondaryColor: '#f3f5fa', tertiaryColor: '#f6f7fb', clusterBkg: '#f6f7fb', clusterBorder: '#dfe3ec', edgeLabelBackground: '#ffffff', titleColor: '#111621' };
      mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: { ...themeVariables, fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif', fontSize: '14px' }, securityLevel: 'strict', flowchart: { useMaxWidth: false } });
      mermaid.run({ nodes });
    };
    draw();
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  </script>""".replace("{MERMAID}", MERMAID)


def head(*, title: str, description: str, canonical: str, base: str, extra: str = "") -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}">
  <link rel="canonical" href="{canonical}">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#0b0e15" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#f6f7fb" media="(prefers-color-scheme: light)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="{NAME}">
  <meta property="og:title" content="{esc(title)}">
  <meta property="og:description" content="{esc(description)}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{SITE}assets/social-preview.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="{base}assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="{base}assets/site.css">
  <script>try{{var t=localStorage.getItem('sws-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}}catch(e){{}}</script>
  <script src="{base}assets/site.js" defer></script>{extra}
</head>"""


def header(base: str, current: Literal["home", "docs"]) -> str:
    docs_current = ' aria-current="page"' if current == "docs" else ""
    return f"""<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="{base}index.html" aria-label="{NAME} home"><img src="{base}assets/logo.svg" alt="" width="28" height="28"><span>{NAME}</span></a>
    <nav class="topnav" aria-label="Main">
      <a href="{base}index.html#features">Features</a>
      <a href="{base}index.html#agents">Sub-agents</a>
      <a href="{base}index.html#integrations">Integrations</a>
      <a href="{base}docs/getting-started.html"{docs_current}>Docs</a>
    </nav>
    <div class="topbar-actions">
      <button class="icon-btn theme-toggle" type="button" aria-label="Switch between dark and light theme"><svg class="i i-moon"><use href="#i-moon"/></svg><svg class="i i-sun"><use href="#i-sun"/></svg></button>
      <a class="icon-btn" href="{REPO}" aria-label="{NAME} on GitHub" rel="noopener"><svg class="i"><use href="#i-github"/></svg></a>
    </div>
  </div>
</header>"""


def footer(base: str) -> str:
    return f"""<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand"><img src="{base}assets/logo.svg" alt="" width="22" height="22"><span>{NAME}</span></div>
    <nav class="footer-links" aria-label="Footer">
      <a href="{base}docs/getting-started.html">Getting started</a>
      <a href="{base}docs/lm-studio.html">LM Studio</a>
      <a href="{base}docs/models.html">models.json</a>
      <a href="{base}docs/tools.html">Tools</a>
      <a href="{REPO}" rel="noopener">GitHub</a>
      <a href="{REPO}/issues" rel="noopener">Issues</a>
    </nav>
    <p class="footer-note">Apache License 2.0. The browser engine is <a href="https://github.com/h4ckf0r0day/obscura" rel="noopener">Obscura</a> (Apache-2.0). See <a href="{REPO}/blob/main/NOTICE" rel="noopener">NOTICE</a>.</p>
  </div>
</footer>"""


def doc_page(page: Page, rendered: Rendered, index: int) -> str:
    """docs/<slug>.html: the sidebar, the rendered document, the pager and the table of contents."""
    base = "../"
    prev = PAGES[index - 1] if index > 0 else None
    next_ = PAGES[index + 1] if index + 1 < len(PAGES) else None
    current = ' aria-current="page"'
    nav = "".join(
        f'<div class="side-group"><p class="side-title">{esc(group.title)}</p><ul>'
        + "".join(
            f'<li><a href="{p.slug}.html"{current if p == page else ""}>{esc(p.nav)}</a></li>' for p in group.pages
        )
        + "</ul></div>"
        for group in GROUPS
    )
    toc = (
        '<nav class="toc" aria-label="On this page"><p class="side-title">On this page</p><ul>'
        + "".join(f'<li class="toc-{t.level}"><a href="#{t.id}">{esc(t.text)}</a></li>' for t in rendered.toc)
        + "</ul></nav>"
        if rendered.toc
        else ""
    )
    extra = _MERMAID_SCRIPT if rendered.mermaid else ""
    prev_link = (
        f'<a class="pager-prev" href="{prev.slug}.html"><span>Previous</span>{esc(prev.nav)}</a>'
        if prev
        else "<span></span>"
    )
    next_link = (
        f'<a class="pager-next" href="{next_.slug}.html"><span>Next</span>{esc(next_.nav)}</a>'
        if next_
        else "<span></span>"
    )
    page_head = head(
        title=f"{rendered.title} · {NAME}",
        description=rendered.description or f"{rendered.title}: {NAME} documentation.",
        canonical=f"{SITE}docs/{page.slug}.html",
        base=base,
        extra=extra,
    )
    return f"""{page_head}
<body class="docs">
{ICONS}
{header(base, "docs")}
<div class="docs-layout">
  <aside class="sidebar" id="sidebar" aria-label="Documentation">
    <button class="side-toggle" type="button" aria-expanded="false" aria-controls="side-nav"><svg class="i"><use href="#i-menu"/></svg><span>Documentation</span></button>
    <nav class="side-nav" id="side-nav">{nav}</nav>
  </aside>
  <main id="main" class="doc">
    <article class="prose">
{rendered.html}
    </article>
    <div class="doc-meta"><a href="{REPO}/edit/main/{page.src}" rel="noopener"><svg class="i"><use href="#i-edit"/></svg>Edit this page on GitHub</a></div>
    <nav class="pager" aria-label="Previous and next">
      {prev_link}
      {next_link}
    </nav>
  </main>
  {toc}
</div>
{footer(base)}
</body>
</html>
"""


def docs_index() -> str:
    """docs/index.html: /docs/ itself leads to the first guide (kept out of the sitemap)."""
    return (
        f'<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Documentation · {NAME}</title>'
        f'<link rel="canonical" href="{SITE}docs/getting-started.html"><meta name="robots" content="noindex">'
        '<meta http-equiv="refresh" content="0; url=getting-started.html"></head>'
        f'<body><p><a href="getting-started.html">Go to the {NAME} documentation</a></p></body></html>\n'
    )


def not_found() -> str:
    """404.html: GitHub Pages serves it for any missing path, so its links are absolute."""
    base = "/stealth-web-search/"
    page_head = head(
        title=f"Page not found · {NAME}", description="Page not found.", canonical=f"{SITE}404.html", base=base
    )
    return f"""{page_head}
<body>
{ICONS}
{header(base, "home")}
<main id="main" class="notfound"><h1>Page not found</h1><p>This page does not exist. Try the <a href="{base}docs/getting-started.html">documentation</a> or the <a href="{base}">home page</a>.</p></main>
{footer(base)}
</body>
</html>
"""


def sitemap() -> str:
    urls = ["", *(f"docs/{p.slug}.html" for p in PAGES)]
    entries = "\n".join(f"  <url><loc>{SITE}{u}</loc></url>" for u in urls)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{entries}\n</urlset>\n'


def robots() -> str:
    return f"User-agent: *\nAllow: /\nSitemap: {SITE}sitemap.xml\n"
