import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

/** browser_markdown, browser_links, browser_search, browser_extract, browser_count, browser_get_attribute, browser_get_text. */
describe('content tools', () => {
  let fx: FixtureServer;
  let srv: TestServer;
  let base: string;

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer();
    base = fx.baseUrl;
  });
  after(async () => {
    await srv?.stop();
    await fx?.close();
  });

  async function open(page: string): Promise<void> {
    const r = await srv.call('browser_navigate', { url: `${base}/${page}` });
    assert.equal(r.isError, false, r.text);
  }

  async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await srv.call(name, args);
    assert.equal(r.isError, false, `${name} ${JSON.stringify(args)} failed: ${r.text}`);
    return r.text;
  }

  async function fails(name: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> {
    const r = await srv.call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} should fail but returned: ${r.text}`);
    assert.match(r.text, pattern);
  }

  /** The page text exactly as browser_snapshot shows it (and browser_search searches it). */
  async function snapshotText(): Promise<string> {
    const text = await ok('browser_snapshot', { include_elements: false, max_chars: 200_000 });
    return text.slice(text.indexOf('\n\n') + 2);
  }

  function jsonLines(text: string): any[] {
    return text
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l));
  }

  test('content tools are listed as read-only with the expected required inputs', async () => {
    const { tools } = await srv.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const expected: Record<string, string[] | undefined> = {
      browser_markdown: undefined,
      browser_links: undefined,
      browser_search: ['query'],
      browser_extract: ['schema'],
      browser_count: ['selector'],
      browser_get_attribute: ['attribute'],
      browser_get_text: undefined,
    };
    for (const [name, required] of Object.entries(expected)) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is registered`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} is read-only`);
      const req = tool.inputSchema.required;
      assert.deepEqual(req && req.length ? req : undefined, required, `${name} required inputs`);
      assert.ok((tool.description ?? '').length > 40, `${name} has a description`);
    }
  });

  // ---------------------------------------------------------------- markdown

  test('markdown converts headings, inline formatting, lists, code, quotes, images, tables and links', async () => {
    await open('article.html');
    const md = await ok('browser_markdown', { max_chars: 100_000 });

    assert.ok(md.includes('# Understanding Café Culture\n\nA short guide to **coffee**, *tea* and `code` in Zürich — naïve résumé 日本語 テキスト 🚀 rocket.'), md);
    assert.ok(md.includes(`## Ordering\n\n- Say **hello** first\n- Pick a [menu item](${base}/menu)\n- Pay at the counter\n\n`), 'tight unordered list');
    assert.ok(md.includes('1. Grind beans\n2. Brew'), 'numbered ordered list');
    assert.ok(md.includes(`- Parent item\n  - Child A\n  - Child [B](${base}/article.html#child-b)\n- Sibling item`), 'nested list is indented');
    assert.ok(md.includes('### Example code\n\n```python\ndef brew(kind):\n    if kind == "espresso":\n        return 2\n    return 1\n```'), 'code keeps indentation and language');
    assert.ok(md.includes("```\nconst cup = brew('espresso');\nconsole.log(cup < 2);\n```"), 'entities decoded inside code');
    assert.ok(md.includes('> Good coffee takes time.\n> A patient barista'), 'blockquote with line break');
    assert.ok(md.includes(`![A steaming cup](${base}/images/hero.jpg)`), 'relative image made absolute');
    assert.ok(md.includes('## 2. Prices\n\n| Drink | Price |\n| --- | --- |\n| Espresso | €2.50 |\n| Flat white | €3.80 |\n| Matcha | €4.20 |'), 'numbered heading and markdown table');
    assert.ok(md.includes(`[Card title Card body](${base}/cards/1)`), 'block content inside a link is flattened');
    assert.ok(md.includes('\n---\n'), 'horizontal rule');
    assert.ok(md.includes('Lots of whitespace here'), 'source whitespace collapsed');

    assert.ok(md.includes(`[Relative Page Two](${base}/page2.html)`), 'relative link made absolute');
    assert.ok(md.includes('[Protocol Relative](http://cdn.example.net/lib)'), 'protocol-relative link resolved');
    assert.ok(md.includes('[Search *café*]('), 'inline markup inside link text');
    assert.ok(md.includes(`[Icon only link](${base}/icon-only)`), 'image-only link uses aria-label');
    assert.ok(md.includes('Script Link') && !md.includes('javascript:'), 'javascript: links are plain text');

    for (const hidden of ['Secret hidden-attribute text', 'Inline hidden text', 'script source must not appear', 'Noscript fallback text', 'visibility: hidden', 'articleLoaded']) {
      assert.ok(!md.includes(hidden), `markdown must not contain ${JSON.stringify(hidden)}`);
    }
    assert.doesNotMatch(md, /\n{3,}/, 'no runs of blank lines');
    assert.doesNotMatch(md, /[\uE000-\uE003]/, 'no internal placeholder characters leak');
  });

  test('markdown of one element, truncation and pages without content', async () => {
    await open('article.html');
    const section = await ok('browser_markdown', { selector: '#comments' });
    assert.ok(section.startsWith('## Comments\n\n'), section);
    assert.ok(section.includes('Grüße aus Zürich'));
    assert.ok(!section.includes('Understanding Café Culture'), 'only the selected element is converted');

    const short = await ok('browser_markdown', { max_chars: 30 });
    const [head, tail] = short.split('\n...(truncated, ');
    assert.equal(Array.from(head!).length, 30, 'truncated to max_chars code points');
    assert.match(tail ?? '', /^\d+ more chars\)$/);

    const empty = await ok('browser_markdown', { selector: '#empty-box' });
    assert.match(empty, /has no readable content/);

    await open('blank.html');
    assert.equal(await ok('browser_markdown'), '(page has no readable content)');
  });

  test('markdown rejects selectors that match nothing or cannot be parsed', async () => {
    await open('article.html');
    await fails('browser_markdown', { selector: '#does-not-exist' }, /Element not found: selector "#does-not-exist"/);
    await fails('browser_markdown', { selector: 'div[' }, /Invalid or unsupported CSS selector "div\["/);
    // small models often send optional strings as "": that means "no selector", not an error
    const page = await ok('browser_markdown', { max_chars: 100_000 });
    assert.equal(await ok('browser_markdown', { selector: '', max_chars: 100_000 }), page);
    assert.equal(await ok('browser_markdown', { selector: '  ', max_chars: 100_000 }), page);
  });

  test('markdown keeps code inside quotes and list items, renders layout tables as blocks and survives private-use characters', async () => {
    await open('content-edge.html');
    const md = await ok('browser_markdown', { max_chars: 100_000 });
    assert.ok(md.includes('> Quote intro\n>\n> ```\n> def f():\n>     return 1\n> ```'), `code in a blockquote keeps its indentation:\n${md}`);
    assert.ok(md.includes('- Install it:\n  ```\n  npm install\n    --save thing\n  ```\n- Done'), `code in a list item is indented as a whole:\n${md}`);
    assert.ok(
      md.includes(`| 1. | | [Title A](${base}/a) (a.com) |\n| --- | --- | --- |\n| | | 10 points by x |\n\nFooter para\n\n- one\n- two`),
      `a table that only lays out other tables becomes blocks; colspan keeps columns aligned; empty rows are dropped:\n${md}`,
    );
    assert.ok(!md.includes('\\|'), 'no escaped pipes from flattening a nested table');
    assert.ok(
      md.includes('| Espresso facts | |\n| --- | --- |\n| Origin | Italy |\n\n| Vitamin | Amount |\n| --- | --- |\n| B2 | 0.2 mg |\n\n| Caffeine | 212 mg |\n| --- | --- |\n| Full report | |'),
      `a data table with one nested table keeps its other rows as a table:\n${md}`,
    );
    assert.ok(md.includes('Alpha\nBeta para\n\nGamma para'), `single-column table keeps paragraphs:\n${md}`);
    assert.ok(md.includes('- Settings\n- Plain'), `a private-use glyph at the start of an item is not treated as indentation:\n${md}`);
    assert.ok(md.includes('icon here and 0 there'), `private-use characters in page text do not act as placeholders:\n${md}`);
    assert.ok(md.includes('foo **bar** *baz*'), 'runs of spaces between inline elements are collapsed');
    assert.doesNotMatch(md, /[\uE000-\uE003]/);
    assert.doesNotMatch(md, /\n{3,}/);

    assert.equal(await ok('browser_markdown', { selector: '#layout .story' }), `1. [Title A](${base}/a) (a.com)`, 'a selected table row keeps its cells apart');
  });

  // ---------------------------------------------------------------- links

  test('links are absolute, de-duplicated, one JSON object per line, without javascript: URLs', async () => {
    await open('article.html');
    const text = await ok('browser_links');
    const lines = text.split('\n');
    const links = lines.map((l) => JSON.parse(l));
    for (const link of links) assert.deepEqual(Object.keys(link), ['text', 'href']);
    assert.deepEqual(
      links.map((l) => l.href),
      [
        `${base}/index.html`,
        `${base}/page2.html`,
        'https://example.org/about?x=1',
        'http://cdn.example.net/lib',
        `${base}/article.html#comments`,
        'mailto:editor@example.com',
        `${base}/search?q=caf%C3%A9`,
        `${base}/icon-only`,
        `${base}/menu`,
        `${base}/article.html#child-b`,
        `${base}/cards/1`,
        `${base}/terms`,
        `${base}/privacy`,
      ],
    );
    assert.equal(links[0].text, 'Home');
    assert.equal(links[1].text, 'Relative Page Two | Duplicate Page Two', 'all distinct texts for a duplicate href are kept, joined with " | "');
    assert.equal(links.find((l) => l.href.includes('/search'))!.text, 'Search café', 'whitespace collapsed, unicode kept');
    assert.equal(links.find((l) => l.href.endsWith('/icon-only'))!.text, 'Icon only link', 'aria-label for image links');
  });

  test('links: internal_only, filter and limit', async () => {
    await open('article.html');
    const internal = jsonLines(await ok('browser_links', { internal_only: true }));
    assert.equal(internal.length, 10);
    for (const l of internal) assert.ok(l.href.startsWith(`${base}/`), l.href);

    const page = jsonLines(await ok('browser_links', { filter: 'PAGE TWO' }));
    assert.deepEqual(page, [{ text: 'Relative Page Two | Duplicate Page Two', href: `${base}/page2.html` }]);
    const byHref = jsonLines(await ok('browser_links', { filter: 'example.org' }));
    assert.deepEqual(byHref.map((l) => l.text), ['External About']);
    const unicode = jsonLines(await ok('browser_links', { filter: 'CAFÉ' }));
    assert.deepEqual(unicode.map((l) => l.href), [`${base}/search?q=caf%C3%A9`]);

    const none = await ok('browser_links', { filter: 'example', internal_only: true });
    assert.equal(none, 'No links found matching internal_only, filter "example" (the page has 13 links in total).');

    const limited = await ok('browser_links', { limit: 2 });
    const lines = limited.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(jsonLines(limited).length, 2);
    assert.equal(lines[2], '…11 more link(s) (raise limit to see them).');

    await open('blank.html');
    assert.equal(await ok('browser_links'), 'No links found.');
  });

  test('links: image-only links are named by their alt text and a duplicate href fills in missing text', async () => {
    await open('content-edge.html');
    const all = jsonLines(await ok('browser_links'));
    assert.deepEqual(all, [
      { text: 'Title A', href: `${base}/a` },
      { text: 'Red shoe | Red Shoe – $20', href: `${base}/p/1` },
      { text: 'Acme home', href: `${base}/logo` },
    ]);
    assert.deepEqual(jsonLines(await ok('browser_links', { filter: 'acme' })), [{ text: 'Acme home', href: `${base}/logo` }]);
  });

  test('links: internal_only never treats opaque origins (about:blank, mailto:, data:) as the same origin', async () => {
    await open('blank.html');
    const r = await srv.call('browser_navigate', { url: 'about:blank' });
    assert.equal(r.isError, false, r.text);
    await ok('browser_evaluate', {
      expression: `document.body.innerHTML = '<a href="mailto:a@example.com">mail</a><a href="data:text/plain,hi">data</a>'; location.origin`,
    });
    assert.equal(jsonLines(await ok('browser_links')).length, 2);
    assert.equal(await ok('browser_links', { internal_only: true }), 'No links found matching internal_only (the page has 2 links in total).');
  });

  test('links keep every distinct text for a repeated href so it stays findable by any of them', async () => {
    await open('links-dup.html');
    const all = jsonLines(await ok('browser_links'));
    const thread = all.find((l) => l.href.endsWith('/thread/1'));
    assert.ok(thread, JSON.stringify(all));
    assert.equal(thread.text, '2 hours ago | 15 comments');
    // the "N comments" link would be unfindable if de-dup kept only the first text
    assert.deepEqual(jsonLines(await ok('browser_links', { filter: 'comments' })).map((l) => l.href), [`${base}/thread/1`]);
    assert.deepEqual(jsonLines(await ok('browser_links', { filter: 'hours ago' })).map((l) => l.href), [`${base}/thread/1`]);
  });

  // ---------------------------------------------------------------- search

  test('search is case-insensitive by default and offsets are UTF-16 indices into the snapshot text', async () => {
    await open('article.html');
    const body = await snapshotText();

    const tea = await ok('browser_search', { query: 'tea' });
    assert.ok(tea.startsWith('5 match(es) for "tea" (showing 5):\n'), tea);
    const teaMatches = jsonLines(tea);
    assert.equal(teaMatches.length, 5);
    let previous = -1;
    for (const m of teaMatches) {
      assert.deepEqual(Object.keys(m), ['offset', 'snippet']);
      assert.equal(body.slice(m.offset, m.offset + 3).toLowerCase(), 'tea');
      assert.ok(m.offset > previous, 'offsets increase');
      previous = m.offset;
      assert.ok(!m.snippet.includes('\n'), 'snippets are single-line');
    }

    const exact = jsonLines(await ok('browser_search', { query: 'TEA', case_sensitive: true }));
    assert.deepEqual(exact.map((m) => m.offset), [body.indexOf('TEA')]);

    // matches after multi-byte and astral characters (日本語, 🚀) must still line up
    const zurich = jsonLines(await ok('browser_search', { query: 'ZÜRICH' }));
    assert.deepEqual(zurich.map((m) => m.offset), [body.indexOf('Zürich'), body.lastIndexOf('Zürich')]);
    assert.ok(body.indexOf('Zürich') !== body.lastIndexOf('Zürich'));

    const rocket = jsonLines(await ok('browser_search', { query: '🚀', context_chars: 1 }));
    assert.equal(rocket.length, 1);
    assert.equal(rocket[0].offset, body.indexOf('🚀'));
    assert.ok(rocket[0].snippet.includes('🚀'));
    assert.ok(rocket[0].snippet.isWellFormed(), 'snippet never splits a surrogate pair');

    const literal = jsonLines(await ok('browser_search', { query: 'cup < 2);' }));
    assert.deepEqual(literal.map((m) => m.offset), [body.indexOf('cup < 2);')]);
    assert.equal(await ok('browser_search', { query: '.*' }), 'No matches for ".*".', 'query is not a regular expression');
  });

  test('search snippets use context_chars, widen to whole words and respect limit', async () => {
    await open('index.html');
    const r = await ok('browser_search', { query: 'needle', context_chars: 5 });
    const matches = jsonLines(r);
    assert.ok(r.startsWith('2 match(es) for "needle" (showing 2):'), r);
    assert.deepEqual(
      matches.map((m) => m.snippet),
      ['…the needle word.…', '…Second Needle here.…'],
    );

    const limited = await ok('browser_search', { query: 'needle', limit: 1, context_chars: 0 });
    const lines = limited.split('\n');
    assert.equal(lines[0], '2 match(es) for "needle" (showing 1):');
    assert.equal(JSON.parse(lines[1]!).snippet, '…needle…');
    assert.equal(lines[2], '…1 more (raise limit to see them).');

    const wide = jsonLines(await ok('browser_search', { query: 'needle', limit: 1, context_chars: 2000 }));
    assert.ok(wide[0].snippet.startsWith('Page Two | External | Hash Hello Fixture Intro paragraph'), wide[0].snippet);

    // snippets collapse line breaks, so a phrase copied from a snippet must be findable again
    const body = await snapshotText();
    const at = body.search(/Hash\n+Hello Fixture/);
    assert.ok(at >= 0, body.slice(0, 200));
    const phrase = await ok('browser_search', { query: 'Hash Hello  fixture' });
    assert.ok(phrase.startsWith('1 match(es) for "Hash Hello  fixture" (showing 1):'), phrase);
    assert.deepEqual(jsonLines(phrase).map((m) => m.offset), [at]);
    assert.ok(jsonLines(phrase)[0].snippet.startsWith('Page Two | External | Hash Hello Fixture Intro paragraph'), 'the snippet collapses the line breaks');
  });

  test('search rejects empty queries, reports no matches and ignores hidden text', async () => {
    await open('article.html');
    await fails('browser_search', { query: '' }, /query/);
    await fails('browser_search', { query: '   ' }, /non-whitespace/);
    assert.equal(await ok('browser_search', { query: 'zzz-not-there' }), 'No matches for "zzz-not-there".');
    assert.equal(await ok('browser_search', { query: 'hidden-attribute' }), 'No matches for "hidden-attribute".');
    assert.equal(await ok('browser_search', { query: 'script source' }), 'No matches for "script source".');
  });

  // ---------------------------------------------------------------- extract

  test('extract returns text, arrays, attributes and absolute URLs in schema order', async () => {
    await open('article.html');
    const text = await ok('browser_extract', {
      schema: {
        title: 'h1',
        'tips[]': 'ul.tips > li',
        'rows[]': '#menu-table tbody tr',
        hero: '#hero@src',
        'footer_links[]': 'footer a@href',
        relative: 'a[href="page2.html"]@href',
        mail: 'a[href^="mailto:"]@href',
        mail_text: 'a[href="mailto:editor@example.com"]',
        'authors[]': '.comment@data-author',
        lead: '.lead',
        spaced: '#spaced',
        hidden: '#hidden-attr',
        missing: '#does-not-exist',
        'none[]': '.does-not-exist',
        no_attr: 'h1@data-nope',
        input_value: '#name-input@value',
        password: '#secret@value',
      },
    });
    assert.ok(!text.includes('Selector errors:'), text);
    const data = JSON.parse(text);
    assert.deepEqual(data, {
      title: 'Understanding Café Culture',
      tips: ['Say hello first', 'Pick a menu item', 'Pay at the counter'],
      rows: ['Espresso €2.50', 'Flat white €3.80', 'Matcha €4.20'],
      hero: `${base}/images/hero.jpg`,
      footer_links: [`${base}/terms`, `${base}/privacy`],
      relative: `${base}/page2.html`,
      mail: 'mailto:editor@example.com',
      mail_text: 'Mail the editor',
      authors: ['Ann', 'Bob', 'Zoë'],
      lead: 'A short guide to coffee, tea and code in Zürich — naïve résumé 日本語 テキスト 🚀 rocket.',
      spaced: 'Lots of whitespace here',
      hidden: 'Secret hidden-attribute text',
      missing: null,
      none: [],
      no_attr: null,
      input_value: 'prefilled',
      password: '••••',
    });
    assert.deepEqual(Object.keys(data), ['title', 'tips', 'rows', 'hero', 'footer_links', 'relative', 'mail', 'mail_text', 'authors', 'lead', 'spaced', 'hidden', 'missing', 'none', 'no_attr', 'input_value', 'password']);
    assert.match(text, /^\{\n {2}"title"/, 'pretty-printed JSON');
  });

  test('extract lists selector errors and validates the schema', async () => {
    await open('article.html');
    const text = await ok('browser_extract', {
      schema: { title: 'h1', 'bad[]': 'div[', broken: 'a:nope(1)', missing: '#nope' },
    });
    const [json, errors] = text.split('\nSelector errors:\n');
    assert.deepEqual(JSON.parse(json!), { title: 'Understanding Café Culture', bad: [], broken: null, missing: null });
    const errorLines = (errors ?? '').split('\n');
    assert.equal(errorLines.length, 2, text);
    assert.match(errorLines[0]!, /^- bad: invalid or unsupported CSS selector "div\["/);
    assert.match(errorLines[1]!, /^- broken: invalid or unsupported CSS selector "a:nope\(1\)"/);

    const capped = await ok('browser_extract', { schema: { 'all[]': 'p', 'bad[]': 'div[' }, max_chars: 20 });
    assert.match(capped, /^\{\n {2}"all": \[\n {4}"A[^\n]*\n\.\.\.\(truncated, \d+ more chars\)\nSelector errors:\n- bad: /, 'JSON is truncated, selector errors are kept');

    await fails('browser_extract', { schema: {} }, /at least one field/);
    await fails('browser_extract', { schema: { a: 1 } }, /field "a" must be a CSS selector string, got number/);
    await fails('browser_extract', { schema: { a: ['h1'] } }, /got an array/);
    await fails('browser_extract', { schema: { a: 'h1', 'a[]': 'h2' } }, /defines the field "a" twice/);
    await fails('browser_extract', { schema: { a: '   ' } }, /empty selector/);
    await fails('browser_extract', { schema: 'h1' }, /schema/);
  });

  test('extract tolerates "selector @ attr" spacing and a schema sent as a JSON string', async () => {
    await open('content-edge.html');
    const spaced = await ok('browser_extract', { schema: { id: 'h1 @ id', title: 'h1' } });
    assert.ok(!spaced.includes('Selector errors:'), spaced);
    assert.deepEqual(JSON.parse(spaced), { id: 'edge-title', title: 'Edge cases' });

    // some local models send nested objects as JSON text
    const fromString = await ok('browser_extract', { schema: '{"title": "h1", "ids[]": "input@id"}' });
    assert.deepEqual(JSON.parse(fromString), { title: 'Edge cases', ids: ['val', 'box', 'pw'] });
  });

  test('get_attribute and extract report live form state for value and checked, not the HTML defaults', async () => {
    await open('content-edge.html');
    /** Log lines written while `run` executes (content tool calls only; other tools have their own redaction). */
    const logsDuring = async (run: () => Promise<void>): Promise<string[]> => {
      const before = srv.logs().length;
      await run();
      await new Promise((r) => setTimeout(r, 300));
      return srv.logs().slice(before).map((l) => JSON.stringify(l));
    };

    const initial = await logsDuring(async () => {
      assert.equal(await ok('browser_get_attribute', { selector: '#pw', attribute: 'value' }), '••••');
      assert.deepEqual(JSON.parse(await ok('browser_extract', { schema: { p: '#pw@value', v: '#val@value', c: '#box@checked' } })), { p: '••••', v: 'initial', c: true });
    });

    await ok('browser_fill', { selector: '#val', value: 'typed by agent' });
    await ok('browser_check', { selector: '#box', checked: false });
    await ok('browser_fill', { selector: '#pw', value: 'hunter3-live' });

    const live = await logsDuring(async () => {
      assert.equal(await ok('browser_get_attribute', { selector: '#val', attribute: 'value' }), 'typed by agent');
      assert.equal(await ok('browser_get_attribute', { selector: '#box', attribute: 'checked' }), 'false');
      assert.equal(await ok('browser_get_attribute', { selector: '#pw', attribute: 'value' }), '••••');
      assert.equal(await ok('browser_get_text', { selector: '#val' }), 'typed by agent');
      assert.equal(await ok('browser_get_text', { selector: '#pw' }), '••••');
      const data = JSON.parse(await ok('browser_extract', { schema: { v: '#val@value', c: '#box@checked', p: '#pw@value', pt: '#pw' } }));
      assert.deepEqual(data, { v: 'typed by agent', c: false, p: '••••', pt: '••••' });
    });

    await ok('browser_fill', { selector: '#val', value: '' });
    assert.equal(await ok('browser_get_attribute', { selector: '#val', attribute: 'value' }), 'Element input#val has an empty value');
    if (srv.logDir) {
      assert.ok(initial.length > 0 && live.length > 0, 'debug logs are captured');
      assert.ok(!initial.some((l) => l.includes('s3cr3t-initial')), 'the password attribute never reaches the logs');
      assert.ok(!live.some((l) => l.includes('hunter3-live') || l.includes('s3cr3t-initial')), 'the live password never reaches the logs');
    }
  });

  // ---------------------------------------------------------------- count

  test('count reports matches, zero matches and invalid selectors', async () => {
    await open('index.html');
    assert.equal(await ok('browser_count', { selector: '.item' }), '2 element(s) match ".item"');
    assert.equal(await ok('browser_count', { selector: '#prices tbody tr' }), '2 element(s) match "#prices tbody tr"');
    assert.equal(await ok('browser_count', { selector: 'h1, h2' }), '2 element(s) match "h1, h2"');
    assert.equal(await ok('browser_count', { selector: '#hidden-btn' }), '1 element(s) match "#hidden-btn"', 'hidden elements count');
    assert.equal(await ok('browser_count', { selector: '.does-not-exist' }), '0 element(s) match ".does-not-exist"');
    await fails('browser_count', { selector: 'div[' }, /Invalid or unsupported CSS selector "div\["/);
    await fails('browser_count', { selector: 'a:nope(1)' }, /Invalid or unsupported CSS selector/);
    await fails('browser_count', { selector: '' }, /selector/);
  });

  // ---------------------------------------------------------------- get_attribute

  test('get_attribute reads raw values by selector or ref; a missing attribute is not an error', async () => {
    await open('index.html');
    assert.equal(await ok('browser_get_attribute', { selector: '#intro', attribute: 'data-x' }), '42');
    assert.match(await ok('browser_get_attribute', { selector: '#intro', attribute: 'title' }), /^Element p#intro "Intro paragraph.*" has no "title" attribute$/);

    const snap = await ok('browser_snapshot');
    const ref = /ref=(e\d+)\s+a\s+"Page Two"/.exec(snap)?.[1];
    assert.ok(ref, snap);
    assert.equal(await ok('browser_get_attribute', { ref, attribute: 'href' }), '/page2.html', 'raw (relative) href');
    assert.equal(await ok('browser_get_attribute', { ref, attribute: 'ID' }), 'link-page2', 'attribute names are case-insensitive');

    await fails('browser_get_attribute', { selector: '#nope', attribute: 'href' }, /Element not found: selector "#nope"/);
    await fails('browser_get_attribute', { selector: 'div[', attribute: 'href' }, /Invalid or unsupported CSS selector/);
    await fails('browser_get_attribute', { attribute: 'href' }, /Provide either 'ref'/);
    await fails('browser_get_attribute', { ref: 'e999', attribute: 'href' }, /Unknown element ref/);
    await fails('browser_get_attribute', { selector: '#intro', attribute: '' }, /attribute/);

    await open('article.html');
    await fails('browser_get_attribute', { ref, attribute: 'href' }, /Unknown element ref|no longer valid/);
    assert.match(await ok('browser_get_attribute', { selector: '#empty-attr', attribute: 'title' }), /has the "title" attribute with an empty value$/);
    assert.equal(await ok('browser_get_attribute', { selector: '#agree', attribute: 'checked' }), 'true', 'checked reports the live state');
    assert.equal(await ok('browser_get_attribute', { selector: '#name-input', attribute: 'value' }), 'prefilled');
    assert.equal(await ok('browser_get_attribute', { selector: '.comment:last-child', attribute: 'data-author' }), 'Zoë');
    assert.equal(await ok('browser_get_attribute', { selector: '#hidden-attr', attribute: 'id' }), 'hidden-attr', 'works on hidden elements');
    assert.equal(await ok('browser_get_attribute', { selector: '#secret', attribute: 'value' }), '••••', 'password values are masked');
    if (srv.logDir) {
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!srv.logs().some((l) => JSON.stringify(l).includes('hunter2')), 'the password value never reaches the logs');
    }
  });

  // ---------------------------------------------------------------- get_text

  test('get_text returns whitespace-normalized block text, form values and handles hidden or empty elements', async () => {
    await open('article.html');
    assert.equal(await ok('browser_get_text', { selector: '.lead' }), 'A short guide to coffee, tea and code in Zürich — naïve résumé 日本語 テキスト 🚀 rocket.');
    assert.equal(await ok('browser_get_text', { selector: '#menu-table' }), 'Drink Price\nEspresso €2.50\nFlat white €3.80\nMatcha €4.20');
    assert.equal(await ok('browser_get_text', { selector: '#spaced' }), 'Lots of whitespace here');
    assert.equal(await ok('browser_get_text', { selector: 'ul.nested' }), 'Parent item\nChild A\nChild B\nSibling item');
    assert.equal(await ok('browser_get_text', { selector: '#quote' }), 'Good coffee takes time.\nA patient barista');
    assert.equal(await ok('browser_get_text', { selector: '#py' }), 'def brew(kind):\n    if kind == "espresso":\n        return 2\n    return 1');
    assert.equal(await ok('browser_get_text', { selector: '#hidden-attr' }), 'Secret hidden-attribute text', 'a targeted hidden element is still readable');
    assert.equal(await ok('browser_get_text', { selector: '#name-input' }), 'prefilled');
    assert.equal(await ok('browser_get_text', { selector: '#secret' }), '••••');
    assert.equal(await ok('browser_get_text', { selector: '#empty-box' }), 'Element div#empty-box has no text.');

    const article = await ok('browser_get_text', { selector: 'main' });
    for (const hidden of ['Secret hidden-attribute text', 'Inline hidden text', 'script source must not appear']) {
      assert.ok(!article.includes(hidden), `descendant ${JSON.stringify(hidden)} is skipped`);
    }
    const truncated = await ok('browser_get_text', { selector: 'main', max_chars: 40 });
    assert.match(truncated, /^Understanding Café Culture\nA short guide\n\.\.\.\(truncated, \d+ more chars\)$/);

    await fails('browser_get_text', { selector: '#nope' }, /Element not found/);
    await fails('browser_get_text', { selector: 'div[' }, /Invalid or unsupported CSS selector/);
    await fails('browser_get_text', {}, /Provide either 'ref'/);

    await open('index.html');
    const snap = await ok('browser_snapshot');
    const ref = /ref=(e\d+)\s+button\s+"Click me"/.exec(snap)?.[1];
    assert.ok(ref, snap);
    assert.equal(await ok('browser_get_text', { ref }), 'Click me');
  });

  // ---------------------------------------------------------------- robustness

  test('large and deeply nested pages stay bounded', async () => {
    await open('large.html');
    assert.equal(await ok('browser_count', { selector: '.row' }), '2000 element(s) match ".row"');

    const started = Date.now();
    const md = await ok('browser_markdown', { max_chars: 2000 });
    assert.ok(md.startsWith('# Large page\n\nRow 0 has **bold** text and a [link 0]('), md.slice(0, 200));
    assert.match(md, /\n\.\.\.\(truncated, \d+ more chars\)$/);
    const full = await ok('browser_markdown', { max_chars: 500_000 });
    assert.ok(full.includes('| cell 499 | 998 |'), 'large table converted');
    assert.ok(full.includes('deepest text'), 'deeply nested text is kept');

    const links = await ok('browser_links', { limit: 1 });
    assert.match(links, /…1999 more link\(s\)/);

    const search = await ok('browser_search', { query: 'row', limit: 1, context_chars: 10 });
    assert.match(search, /^2000 match\(es\) for "row" \(showing 1\):/);

    const extracted = JSON.parse(await ok('browser_extract', { schema: { 'cells[]': '#big-table td', deep: '#deep' } }));
    assert.equal(extracted.cells.length, 1000);
    assert.equal(extracted.deep, 'deepest text');
    assert.equal(await ok('browser_get_text', { selector: '#deepest' }), 'deepest text');
    assert.ok(Date.now() - started < 60_000, 'content tools finish in reasonable time');
  });

  test('content tools do not modify the page', async () => {
    await open('article.html');
    const before = await ok('browser_markdown', { max_chars: 100_000 });
    const countBefore = await ok('browser_count', { selector: '*' });
    await ok('browser_links');
    await ok('browser_search', { query: 'tea' });
    await ok('browser_extract', { schema: { 'all[]': '*' } });
    await ok('browser_get_text', { selector: 'body' });
    await ok('browser_get_attribute', { selector: 'body', attribute: 'class' });
    assert.equal(await ok('browser_count', { selector: '*' }), countBefore);
    assert.equal(await ok('browser_markdown', { max_chars: 100_000 }), before);
  });
});
