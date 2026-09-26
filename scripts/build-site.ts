/**
 * Builds the project website (GitHub Pages) into _site/: the landing page from site/index.html and
 * one page per Markdown document (docs/*.md and the project files). Links between documents become
 * links between pages; links to other repository files point to GitHub. The build fails on a broken
 * internal link or anchor, so the site never ships dead links.
 *
 *   npm run site:build            # writes _site/
 *   npm run site:serve            # builds, then serves _site/ on http://127.0.0.1:4173
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import plaintext from 'highlight.js/lib/languages/plaintext';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Marked, type Tokens } from 'marked';
import { loadConfig } from '../src/config.ts';
import { enabledTools } from '../src/tools/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');
const REPO = 'https://github.com/tanishmeh/stealth-web-search';
const SITE = 'https://tanishmeh.github.io/stealth-web-search/';
const NAME = 'Stealth Web Search';
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.esm.min.mjs';
const LM_STUDIO_INSTALL =
  'https://lmstudio.ai/install-mcp?name=stealth-web-search&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg5MzEvbWNwIiwidGltZW91dCI6MTgwMDAwfQ%3D%3D';

for (const [name, lang] of Object.entries({ bash, dockerfile, ini, javascript, json, plaintext, typescript, xml, yaml })) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'console', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['ts'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'mjs'], { languageName: 'javascript' });
hljs.registerAliases(['jsonc'], { languageName: 'json' });
hljs.registerAliases(['toml', 'env', 'dotenv'], { languageName: 'ini' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });

interface Page {
  src: string;
  slug: string;
  nav: string;
}
const GROUPS: Array<{ title: string; pages: Page[] }> = [
  {
    title: 'Start here',
    pages: [
      { src: 'docs/GETTING_STARTED.md', slug: 'getting-started', nav: 'Getting started' },
      { src: 'docs/CLIENTS.md', slug: 'clients', nav: 'Connect MCP clients' },
      { src: 'docs/LM_STUDIO.md', slug: 'lm-studio', nav: 'LM Studio' },
    ],
  },
  {
    title: 'Configure',
    pages: [
      { src: 'docs/CONFIGURATION.md', slug: 'configuration', nav: 'Configuration' },
      { src: 'docs/MODELS.md', slug: 'models', nav: 'Model config (models.json)' },
    ],
  },
  {
    title: 'Use',
    pages: [
      { src: 'docs/AGENTS.md', slug: 'agents', nav: 'Sub-agents and scripts' },
      { src: 'docs/SNAPSHOTS.md', slug: 'snapshots', nav: 'Snapshots (saved sign-ins)' },
      { src: 'docs/TOOLS.md', slug: 'tools', nav: 'Tool reference' },
    ],
  },
  {
    title: 'Operate',
    pages: [
      { src: 'docs/LOGGING.md', slug: 'logging', nav: 'Logging' },
      { src: 'docs/TROUBLESHOOTING.md', slug: 'troubleshooting', nav: 'Troubleshooting' },
      { src: 'docs/ARCHITECTURE.md', slug: 'architecture', nav: 'Architecture' },
    ],
  },
  {
    title: 'Project',
    pages: [
      { src: 'CONTRIBUTING.md', slug: 'contributing', nav: 'Contributing' },
      { src: 'SECURITY.md', slug: 'security', nav: 'Security policy' },
      { src: 'CHANGELOG.md', slug: 'changelog', nav: 'Changelog' },
    ],
  },
];
const PAGES = GROUPS.flatMap((g) => g.pages);
const PAGE_BY_SRC = new Map(PAGES.map((p) => [p.src, p]));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** GitHub's heading anchors, so links like CONFIGURATION.md#sub-agents keep working. */
function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

interface Rendered {
  title: string;
  description: string;
  html: string;
  toc: Array<{ level: number; id: string; text: string }>;
  mermaid: boolean;
}

const brokenSources: string[] = [];

/** Where a link in `fromSrc` (a repo-relative Markdown path) should point on the site. */
function rewriteHref(href: string, fromSrc: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href; // absolute URL
  if (href.startsWith('#')) return href;
  const [p, hash = ''] = href.split(/(?=#)/);
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromSrc), decodeURI(p!)));
  const page = PAGE_BY_SRC.get(target);
  if (page) return `${page.slug}.html${hash}`;
  if (target.startsWith('docs/images/')) return `images/${target.slice('docs/images/'.length)}${hash}`;
  const abs = path.join(ROOT, target);
  if (!existsSync(abs) || target.startsWith('..')) {
    brokenSources.push(`${fromSrc}: link to ${href} (${target} does not exist)`);
    return href;
  }
  return `${REPO}/${statSync(abs).isDirectory() ? 'tree' : 'blob'}/main/${target}${hash}`;
}

function render(src: string): Rendered {
  const md = readFileSync(path.join(ROOT, src), 'utf8');
  const slug = slugger();
  const toc: Rendered['toc'] = [];
  let title = '';
  let mermaid = false;
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const text = stripTags(inner);
        const id = slug(text);
        if (depth === 1 && !title) {
          title = text;
          return `<h1 id="${id}">${inner}</h1>\n`;
        }
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, text });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section"></a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const language = (lang ?? '').trim().split(/\s+/)[0]!.toLowerCase();
        if (language === 'mermaid') {
          mermaid = true;
          return `<div class="diagram"><pre class="mermaid">${esc(text)}</pre></div>\n`;
        }
        const known = language && hljs.getLanguage(language);
        const body = known ? hljs.highlight(text, { language, ignoreIllegals: true }).value : esc(text);
        const label = language && language !== 'text' && language !== 'plaintext' ? esc(language) : '';
        return `<div class="code"><div class="code-head"><span class="code-lang">${label}</span><button class="copy" type="button" aria-label="Copy code">Copy</button></div><pre><code class="hljs${known ? ` language-${language}` : ''}">${body}</code></pre></div>\n`;
      },
      link({ href, title: t, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const target = rewriteHref(href, src);
        const external = /^https?:/.test(target) && !target.startsWith(SITE);
        return `<a href="${esc(target)}"${t ? ` title="${esc(t)}"` : ''}${external ? ' rel="noopener"' : ''}>${inner}</a>`;
      },
      image({ href, title: t, text }: Tokens.Image) {
        const target = rewriteHref(href, src);
        return `<img src="${esc(target)}" alt="${esc(text)}"${t ? ` title="${esc(t)}"` : ''} loading="lazy" decoding="async">`;
      },
      // raw HTML in a doc would become live markup on the site (a stray <select> swallows the page): show it as text
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return text.trimStart().startsWith('<!--') ? text : esc(text);
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: 'th' | 'td') =>
          `<${tag}${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c) => cell(c, 'th')).join('')}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`).join('\n');
        return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  const html = marked.parse(md, { async: false }) as string;
  const firstPara = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
  const description = stripTags(firstPara).replace(/\s+/g, ' ').trim().slice(0, 200);
  return { title: title || src, description, html, toc, mermaid };
}

// ------------------------------------------------------------------ templates

const ICONS = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="i-github" viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M12 2.2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2.2z"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></symbol>
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></symbol>
</svg>`;

function head(opts: { title: string; description: string; canonical: string; base: string; extra?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}</title>
  <meta name="description" content="${esc(opts.description)}">
  <link rel="canonical" href="${opts.canonical}">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#0b0e15" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#f6f7fb" media="(prefers-color-scheme: light)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${NAME}">
  <meta property="og:title" content="${esc(opts.title)}">
  <meta property="og:description" content="${esc(opts.description)}">
  <meta property="og:url" content="${opts.canonical}">
  <meta property="og:image" content="${SITE}assets/social-preview.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="${opts.base}assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${opts.base}assets/site.css">
  <script>try{var t=localStorage.getItem('sws-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
  <script src="${opts.base}assets/site.js" defer></script>${opts.extra ?? ''}
</head>`;
}

function header(base: string, current: 'home' | 'docs'): string {
  return `<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="${base}index.html" aria-label="${NAME} home"><img src="${base}assets/logo.svg" alt="" width="28" height="28"><span>${NAME}</span></a>
    <nav class="topnav" aria-label="Main">
      <a href="${base}index.html#features"${current === 'home' ? '' : ''}>Features</a>
      <a href="${base}index.html#agents">Sub-agents</a>
      <a href="${base}index.html#integrations">Integrations</a>
      <a href="${base}docs/getting-started.html"${current === 'docs' ? ' aria-current="page"' : ''}>Docs</a>
    </nav>
    <div class="topbar-actions">
      <button class="icon-btn theme-toggle" type="button" aria-label="Switch between dark and light theme"><svg class="i i-moon"><use href="#i-moon"/></svg><svg class="i i-sun"><use href="#i-sun"/></svg></button>
      <a class="icon-btn" href="${REPO}" aria-label="${NAME} on GitHub" rel="noopener"><svg class="i"><use href="#i-github"/></svg></a>
    </div>
  </div>
</header>`;
}

function footer(base: string): string {
  return `<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand"><img src="${base}assets/logo.svg" alt="" width="22" height="22"><span>${NAME}</span></div>
    <nav class="footer-links" aria-label="Footer">
      <a href="${base}docs/getting-started.html">Getting started</a>
      <a href="${base}docs/lm-studio.html">LM Studio</a>
      <a href="${base}docs/models.html">models.json</a>
      <a href="${base}docs/tools.html">Tools</a>
      <a href="${REPO}" rel="noopener">GitHub</a>
      <a href="${REPO}/issues" rel="noopener">Issues</a>
    </nav>
    <p class="footer-note">Apache License 2.0. The browser engine is <a href="https://github.com/h4ckf0r0day/obscura" rel="noopener">Obscura</a> (Apache-2.0). See <a href="${REPO}/blob/main/NOTICE" rel="noopener">NOTICE</a>.</p>
  </div>
</footer>`;
}

function docPage(page: Page, r: Rendered, index: number): string {
  const base = '../';
  const prev = PAGES[index - 1];
  const next = PAGES[index + 1];
  const nav = GROUPS.map(
    (g) =>
      `<div class="side-group"><p class="side-title">${esc(g.title)}</p><ul>${g.pages
        .map((p) => `<li><a href="${p.slug}.html"${p === page ? ' aria-current="page"' : ''}>${esc(p.nav)}</a></li>`)
        .join('')}</ul></div>`,
  ).join('');
  const toc = r.toc.length
    ? `<nav class="toc" aria-label="On this page"><p class="side-title">On this page</p><ul>${r.toc
        .map((t) => `<li class="toc-${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`)
        .join('')}</ul></nav>`
    : '';
  // diagrams keep their natural size (the box scrolls) and are drawn again when the theme changes
  const extra = r.mermaid
    ? `\n  <script type="module">
    import mermaid from '${MERMAID}';
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
  </script>`
    : '';
  return `${head({ title: `${r.title} · ${NAME}`, description: r.description || `${r.title}: ${NAME} documentation.`, canonical: `${SITE}docs/${page.slug}.html`, base, extra })}
<body class="docs">
${ICONS}
${header(base, 'docs')}
<div class="docs-layout">
  <aside class="sidebar" id="sidebar" aria-label="Documentation">
    <button class="side-toggle" type="button" aria-expanded="false" aria-controls="side-nav"><svg class="i"><use href="#i-menu"/></svg><span>Documentation</span></button>
    <nav class="side-nav" id="side-nav">${nav}</nav>
  </aside>
  <main id="main" class="doc">
    <article class="prose">
${r.html}
    </article>
    <div class="doc-meta"><a href="${REPO}/edit/main/${page.src}" rel="noopener"><svg class="i"><use href="#i-edit"/></svg>Edit this page on GitHub</a></div>
    <nav class="pager" aria-label="Previous and next">
      ${prev ? `<a class="pager-prev" href="${prev.slug}.html"><span>Previous</span>${esc(prev.nav)}</a>` : '<span></span>'}
      ${next ? `<a class="pager-next" href="${next.slug}.html"><span>Next</span>${esc(next.nav)}</a>` : '<span></span>'}
    </nav>
  </main>
  ${toc}
</div>
${footer(base)}
</body>
</html>
`;
}

// ------------------------------------------------------------------ build

function toolCounts() {
  const all = enabledTools(loadConfig({ AGENT_LLM_URL: 'http://127.0.0.1:1/v1', TOOLSETS: 'all' }));
  const count = (pred: (group: string) => boolean) => all.filter((t) => pred(t.group)).length;
  return {
    all: all.length,
    browser: all.filter((t) => t.name.startsWith('browser_')).length,
    agents: count((g) => g === 'agents'),
    scripts: count((g) => g === 'scripts'),
  };
}

function build(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(path.join(OUT, 'docs'), { recursive: true });
  cpSync(path.join(ROOT, 'site', 'assets'), path.join(OUT, 'assets'), { recursive: true });
  cpSync(path.join(ROOT, 'docs', 'images'), path.join(OUT, 'docs', 'images'), { recursive: true });
  // the landing page shows the screenshots too
  cpSync(path.join(ROOT, 'docs', 'images'), path.join(OUT, 'assets', 'img'), { recursive: true });
  writeFileSync(path.join(OUT, '.nojekyll'), '');

  const missing = PAGES.filter((p) => !existsSync(path.join(ROOT, p.src)));
  if (missing.length) throw new Error(`missing documents: ${missing.map((p) => p.src).join(', ')}`);
  PAGES.forEach((page, i) => writeFileSync(path.join(OUT, 'docs', `${page.slug}.html`), docPage(page, render(page.src), i)));
  // /docs/ itself leads to the first guide (kept out of the sitemap)
  writeFileSync(
    path.join(OUT, 'docs', 'index.html'),
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Documentation · ${NAME}</title><link rel="canonical" href="${SITE}docs/getting-started.html"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=getting-started.html"></head><body><p><a href="getting-started.html">Go to the ${NAME} documentation</a></p></body></html>\n`,
  );

  const counts = toolCounts();
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const vars: Record<string, string> = {
    VERSION: pkg.version,
    TOOLS_ALL: String(counts.all),
    TOOLS_BROWSER: String(counts.browser),
    TOOLS_AGENTS: String(counts.agents),
    TOOLS_SCRIPTS: String(counts.scripts),
    REPO,
    SITE,
    LM_STUDIO_INSTALL: esc(LM_STUDIO_INSTALL),
    MODELS_EXAMPLE: esc(readFileSync(path.join(ROOT, 'config', 'models.example.json'), 'utf8').trimEnd()),
  };
  let landing = readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
  landing = landing
    .replace('<!-- @head -->', head({ title: `${NAME}: a stealth browser and research agents for your AI, over MCP`, description: `${NAME} gives AI agents a real, JavaScript-rendering, stealthy web browser over MCP, plus sub-agents that browse, automate and cross-check the web on their own. One Docker container, full logs, a live view, and LM Studio integration.`, canonical: SITE, base: '' }))
    .replace('<!-- @icons -->', ICONS)
    .replace('<!-- @header -->', header('', 'home'))
    .replace('<!-- @footer -->', footer(''))
    .replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => {
      if (!(key in vars)) throw new Error(`site/index.html: unknown placeholder ${m}`);
      return vars[key]!;
    });
  // code samples on the landing page are highlighted at build time, like the docs
  landing = landing.replace(/<code data-hl="([a-z]+)">([\s\S]*?)<\/code>/g, (_, language: string, body: string) => {
    const text = body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return `<code class="hljs language-${language}">${hljs.highlight(text, { language, ignoreIllegals: true }).value}</code>`;
  });
  writeFileSync(path.join(OUT, 'index.html'), landing);
  writeFileSync(
    path.join(OUT, '404.html'),
    `${head({ title: `Page not found · ${NAME}`, description: 'Page not found.', canonical: `${SITE}404.html`, base: '/stealth-web-search/' })}
<body>
${ICONS}
${header('/stealth-web-search/', 'home')}
<main id="main" class="notfound"><h1>Page not found</h1><p>This page does not exist. Try the <a href="/stealth-web-search/docs/getting-started.html">documentation</a> or the <a href="/stealth-web-search/">home page</a>.</p></main>
${footer('/stealth-web-search/')}
</body>
</html>
`,
  );
  const urls = ['', ...PAGES.map((p) => `docs/${p.slug}.html`)];
  writeFileSync(
    path.join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join('\n')}\n</urlset>\n`,
  );
  writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);

  const problems = [...brokenSources, ...checkLinks()];
  if (problems.length) throw new Error(`broken links:\n  ${problems.join('\n  ')}`);
  console.log(`site built: ${PAGES.length + 1} pages in ${path.relative(ROOT, OUT)}/`);
}

/** Every relative href/src in the built HTML must resolve to a file, and #anchors to an id on that page. */
function checkLinks(): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) files.push(p);
    }
  };
  walk(OUT);
  const ids = new Map<string, Set<string>>();
  const idsOf = (file: string) => {
    let set = ids.get(file);
    if (!set) {
      set = new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
      ids.set(file, set);
    }
    return set;
  };
  const problems: string[] = [];
  for (const file of files) {
    if (file.endsWith('404.html')) continue; // absolute links for any depth
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const raw = m[1]!.replace(/&amp;/g, '&');
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
      const [p, hash] = raw.split('#') as [string, string | undefined];
      const target = p ? path.resolve(path.dirname(file), decodeURI(p)) : file;
      const rel = path.relative(OUT, file);
      if (!existsSync(target)) {
        problems.push(`${rel}: ${raw} (no such file)`);
        continue;
      }
      if (hash && target.endsWith('.html') && !idsOf(target).has(decodeURIComponent(hash))) problems.push(`${rel}: ${raw} (no #${hash} on that page)`);
    }
  }
  return problems;
}

function serve(port: number): void {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };
  http
    .createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      let p = path.join(OUT, decodeURIComponent(url.pathname.replace(/^\/stealth-web-search/, '')));
      if (!p.startsWith(OUT)) return void res.writeHead(403).end();
      if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, 'index.html');
      if (!existsSync(p)) {
        res.writeHead(404, { 'content-type': types['.html']! }).end(readFileSync(path.join(OUT, '404.html')));
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
    })
    .listen(port, '127.0.0.1', () => console.log(`serving _site/ on http://127.0.0.1:${port}/`));
}

build();
if (process.argv.includes('--serve')) serve(Number(process.env.PORT ?? 4173));
