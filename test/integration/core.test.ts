import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

/** The top-left pixel of a PNG. For row 0's first pixel every filter reduces to the raw stored value. */
function pngTopLeftPixel(png: Buffer): { width: number; height: number; r: number; g: number; b: number } {
  let off = 8; // skip the 8-byte PNG signature
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0 || bitDepth !== 8) throw new Error(`unsupported PNG colorType=${colorType} bitDepth=${bitDepth}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const r = raw[1]!;
  const g = channels >= 3 ? raw[2]! : r;
  const b = channels >= 3 ? raw[3]! : r;
  return { width, height, r, g, b };
}

describe('cleanNavigationError (pure)', async () => {
  const { cleanNavigationError } = await import('../../src/browser/tab.ts');
  test('a host resolving to a private IP is reported as an SSRF block, not a DNS failure', () => {
    const ssrf =
      'Network error: SSRF blocked: 127.0.0.1.nip.io resolves to forbidden address 127.0.0.1 ' +
      '(source: Some(Error { kind: Connect, source: Some(ConnectError("dns error", Custom { kind: Uncategorized, error: "failed to lookup address information" })) }))';
    const out = cleanNavigationError(ssrf);
    assert.match(out, /private\/internal addresses are blocked/);
    assert.match(out, /ALLOW_PRIVATE_NETWORK/);
    assert.doesNotMatch(out, /DNS lookup failed/, 'the SSRF case must win over the DNS pattern');
  });
});

/** Navigation, snapshot/refs, click and screenshot against the local fixture site. */
describe('core tools', () => {
  let fx: FixtureServer;
  let srv: TestServer;

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer();
  });
  after(async () => {
    await srv?.stop();
    await fx?.close();
  });

  test('lists tools with schemas and server instructions', async () => {
    const { tools } = await srv.client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_screenshot']) assert.ok(names.includes(name), name);
    const nav = tools.find((t) => t.name === 'browser_navigate')!;
    assert.deepEqual(nav.inputSchema.required, ['url']);
    assert.match(srv.client.getInstructions() ?? '', /browser_snapshot/);
  });

  test('navigate reports final URL, title and HTTP status', async () => {
    const r = await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Navigated to http:\/\/.+\/index\.html — "Fixture Home" \(HTTP 200\)/);

    const missing = await srv.call('browser_navigate', { url: `${fx.baseUrl}/status/404` });
    assert.equal(missing.isError, false);
    assert.match(missing.text, /\(HTTP 404\)/);
    assert.match(missing.text, /Warning/);
  });

  test('navigate rejects forbidden schemes and bad hosts', async () => {
    const file = await srv.call('browser_navigate', { url: 'file:///etc/passwd' });
    assert.equal(file.isError, true);
    assert.match(file.text, /not allowed/);
    const js = await srv.call('browser_navigate', { url: 'javascript:alert(1)' });
    assert.equal(js.isError, true);
    const bad = await srv.call('browser_navigate', { url: 'http://nonexistent.invalid/' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Navigation to .* failed/);
  });

  test('snapshot shows text and visible interactive elements with refs', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const r = await srv.call('browser_snapshot');
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^URL: .*index\.html/m);
    assert.match(r.text, /^Title: Fixture Home$/m);
    assert.match(r.text, /Intro paragraph with the needle word/);
    assert.match(r.text, /ref=e\d+\s+a\s+"Page Two" href="\/page2\.html"/);
    assert.match(r.text, /ref=e\d+\s+button\s+"Click me"/);
    assert.doesNotMatch(r.text, /"Hidden"/, 'display:none elements are not listed');
    assert.match(r.text, /"Far button".*offscreen/);
  });

  test('refs are stable across snapshots of the same document', async () => {
    const first = await srv.call('browser_snapshot');
    const second = await srv.call('browser_snapshot');
    const refOf = (text: string, label: string) => new RegExp(`ref=(e\\d+)\\s+\\S+\\s+"${label}"`).exec(text)?.[1];
    assert.ok(refOf(first.text, 'Click me'));
    assert.equal(refOf(first.text, 'Click me'), refOf(second.text, 'Click me'));
  });

  test('click by ref runs page handlers; offscreen elements are scrolled into view', async () => {
    const snap = await srv.call('browser_snapshot');
    const counter = /ref=(e\d+)\s+button\s+"Click me"/.exec(snap.text)![1];
    const r = await srv.call('browser_click', { ref: counter });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Clicked button "Click me"/);
    const far = /ref=(e\d+)\s+button\s+"Far button"/.exec(snap.text)![1];
    const r2 = await srv.call('browser_click', { ref: far });
    assert.equal(r2.isError, false, r2.text);
    const shot = await srv.call('browser_snapshot', { include_elements: false });
    assert.match(shot.text, /far clicked/);
  });

  test('click falls back to a DOM click for covered elements and rejects disabled ones', async () => {
    const covered = await srv.call('browser_click', { selector: '#covered' });
    assert.equal(covered.isError, false, covered.text);
    assert.match(covered.text, /programmatic/);
    const disabled = await srv.call('browser_click', { selector: '#disabled-btn' });
    assert.equal(disabled.isError, true);
    assert.match(disabled.text, /disabled/);
  });

  test('click that navigates reports the new page and invalidates refs', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const snap = await srv.call('browser_snapshot');
    const link = /ref=(e\d+)\s+a\s+"Page Two"/.exec(snap.text)![1];
    const r = await srv.call('browser_click', { ref: link });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /navigated to .*page2\.html — "Page Two"/);
    const stale = await srv.call('browser_click', { ref: 'e999' });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Unknown element ref/);
  });

  test('back, forward and reload', async () => {
    const back = await srv.call('browser_back');
    assert.match(back.text, /Back to .*index\.html — "Fixture Home"/);
    const fwd = await srv.call('browser_forward');
    assert.match(fwd.text, /Forward to .*page2\.html/);
    const reload = await srv.call('browser_reload');
    assert.match(reload.text, /Reloaded .*page2\.html — "Page Two" \(HTTP 200\)/);
  });

  test('screenshot returns an image for viewport, full page and element', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const vp = await srv.call('browser_screenshot');
    assert.equal(vp.isError, false, vp.text);
    assert.equal(vp.images.length, 1);
    assert.equal(vp.images[0]!.mimeType, 'image/png');
    assert.ok(Buffer.from(vp.images[0]!.data, 'base64').subarray(1, 4).toString() === 'PNG');
    const full = await srv.call('browser_screenshot', { full_page: true, format: 'jpeg' });
    assert.equal(full.images[0]!.mimeType, 'image/jpeg');
    const el = await srv.call('browser_screenshot', { selector: '#prices' });
    assert.equal(el.isError, false, el.text);
    assert.match(el.text, /element selector "#prices"/);
  });

  test('element screenshot captures a target far below the fold, not the top of the page', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/tall-page.html` });
    const shot = await srv.call('browser_screenshot', { selector: '#target' });
    assert.equal(shot.isError, false, shot.text);
    assert.equal(shot.images.length, 1);
    const png = Buffer.from(shot.images[0]!.data, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const pixel = pngTopLeftPixel(png);
    // the element is 240x160 CSS px at deviceScaleFactor 1
    assert.deepEqual([pixel.width, pixel.height], [240, 160], `unexpected element image size ${pixel.width}x${pixel.height}`);
    // the captured content is the red target far below the fold, not the white top of the page
    assert.ok(pixel.r > 200 && pixel.g < 80 && pixel.b < 80, `expected the red target, got rgb(${pixel.r},${pixel.g},${pixel.b})`);
  });

  test('full_page screenshot of a very tall page fails with a clean error, not an unexpected one', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/huge-page.html` });
    const r = await srv.call('browser_screenshot', { full_page: true });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /16 megapixels|too large/i);
    assert.equal(r.images.length, 0);
    // the viewport still captures fine after the rejection
    const vp = await srv.call('browser_screenshot');
    assert.equal(vp.isError, false, vp.text);
    assert.equal(vp.images.length, 1);
  });

  test('every tool call is logged with arguments, result and duration', async () => {
    if (!srv.logDir) return; // external server: logs live in the container
    await new Promise((r) => setTimeout(r, 300));
    const toolLogs = srv.logs().filter((l) => l.component === 'tool');
    assert.ok(toolLogs.some((l) => l.tool === 'browser_navigate' && l.args?.url), 'call log with args');
    assert.ok(toolLogs.some((l) => l.tool === 'browser_navigate' && typeof l.durationMs === 'number' && l.result), 'result log');
    assert.ok(srv.logs().some((l) => l.component === 'cdp' && l.method === 'Page.navigate'), 'CDP traffic logged');
    assert.ok(srv.logs().some((l) => l.component === 'mcp' && l.dir === 'in'), 'MCP JSON-RPC logged');
  });
});
