import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sanitizeOutgoingFrame } from '../../src/cdp/client.ts';
import { ConfigError, loadConfig, splitArgs } from '../../src/config.ts';
import { truncate } from '../../src/tools/format.ts';
import { normalizeUrl } from '../../src/tools/navigation.ts';
import { fingerprint, previewToolResult, summarize, truncateString } from '../../src/util/summarize.ts';

describe('sanitizeOutgoingFrame', () => {
  test('neutralises substrings that Obscura matches on raw frames, without changing the decoded value', () => {
    const msg = { id: 7, method: 'Input.insertText', params: { text: 'say "Browser.close" and Fetch.continueRequest / Fetch.failRequest' } };
    const frame = sanitizeOutgoingFrame(JSON.stringify(msg));
    assert.equal(frame.includes('Browser.close'), false);
    assert.equal(frame.includes('"Browser.close"'), false);
    assert.equal(frame.includes('Fetch.continueRequest'), false);
    assert.equal(frame.includes('Fetch.failRequest'), false);
    assert.deepEqual(JSON.parse(frame), msg);
  });

  test('leaves ordinary frames untouched', () => {
    const json = JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'https://example.com/Browser/close' } });
    assert.equal(sanitizeOutgoingFrame(json), json);
  });
});

describe('normalizeUrl', () => {
  const config = loadConfig({});

  test('adds https:// to bare hosts and http:// to local hosts', () => {
    assert.equal(normalizeUrl('example.com', config), 'https://example.com/');
    assert.equal(normalizeUrl('example.com/a?b=1', config), 'https://example.com/a?b=1');
    assert.equal(normalizeUrl('localhost:3000', config), 'http://localhost:3000/');
    assert.equal(normalizeUrl('  https://example.com  ', config), 'https://example.com/');
    assert.equal(normalizeUrl('about:blank', config), 'about:blank');
  });

  test('rejects dangerous or disallowed schemes', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'view-source:https://example.com', 'ftp://example.com']) {
      assert.throws(() => normalizeUrl(url, config), /not allowed|Invalid URL/, url);
    }
    assert.throws(() => normalizeUrl('', config), /must not be empty/);
  });

  test('respects ALLOWED_URL_SCHEMES', () => {
    const strict = loadConfig({ ALLOWED_URL_SCHEMES: 'https' });
    assert.throws(() => normalizeUrl('http://example.com', strict), /not allowed/);
    assert.equal(normalizeUrl('https://example.com', strict), 'https://example.com/');
  });
});

describe('config', () => {
  test('defaults', () => {
    const c = loadConfig({});
    assert.equal(c.port, 8931);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.obscura.stealth, true);
    assert.equal(c.obscura.allowPrivateNetwork, false);
    assert.deepEqual(c.browser.toolsets, ['all']);
    assert.ok(c.allowedHosts.includes('localhost'));
    assert.equal(c.log.redactSecrets, true);
  });

  test('parses booleans, integers and lists', () => {
    const c = loadConfig({ PORT: '9000', OBSCURA_STEALTH: 'off', ALLOW_PRIVATE_NETWORK: 'YES', TOOLSETS: 'core, Content', ALLOWED_HOSTS: 'mcp.internal' });
    assert.equal(c.port, 9000);
    assert.equal(c.obscura.stealth, false);
    assert.equal(c.obscura.allowPrivateNetwork, true);
    assert.deepEqual(c.browser.toolsets, ['core', 'content']);
    assert.ok(c.allowedHosts.includes('mcp.internal'));
  });

  test('reports invalid values clearly', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), (e: Error) => e instanceof ConfigError && /PORT/.test(e.message));
    assert.throws(() => loadConfig({ OBSCURA_STEALTH: 'maybe' }), /OBSCURA_STEALTH/);
    assert.throws(() => loadConfig({ LOG_LEVEL: 'loud' }), /LOG_LEVEL/);
    assert.throws(() => loadConfig({ ALLOWED_URL_SCHEMES: 'http,file' }), /can never be allowed/);
    assert.throws(() => loadConfig({ LOG_FORMAT: 'xml' }), /LOG_FORMAT/);
  });

  test('splitArgs honours quotes', () => {
    assert.deepEqual(splitArgs(`--v8-flags "--max-old-space-size=4096 --expose-gc" --quiet 'a b'`), [
      '--v8-flags',
      '--max-old-space-size=4096 --expose-gc',
      '--quiet',
      'a b',
    ]);
  });
});

describe('summarize and truncation', () => {
  test('truncate counts code points and reports the remainder', () => {
    assert.equal(truncate('héllo', 10), 'héllo');
    assert.equal(truncate('😀😀😀😀', 2), '😀😀\n...(truncated, 2 more chars)');
  });

  test('replaces base64 blobs with a fingerprint and truncates long strings', () => {
    const blob = Buffer.alloc(4096, 7).toString('base64');
    const out = summarize({ content: [{ type: 'image', data: blob, mimeType: 'image/png' }], note: 'x'.repeat(50) }, { maxString: 10 }) as any;
    assert.match(out.content[0].data, /^<binary \d+ bytes sha256:[0-9a-f]{12}>$/);
    assert.equal(out.note, `${'x'.repeat(10)}…(+40 chars)`);
    assert.equal(fingerprint(blob), out.content[0].data);
    assert.equal(truncateString('abc', 5), 'abc');
  });

  test('bounds depth, arrays and cycles', () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    const out = summarize({ cyclic, list: Array.from({ length: 60 }, (_, i) => i) }, { maxString: 100, maxArrayItems: 5 }) as any;
    assert.equal(out.cyclic.self, '<circular>');
    assert.equal(out.list.length, 6);
    assert.equal(out.list[5], '…(+55 items)');
  });

  test('previewToolResult describes text, images and resources', () => {
    const preview = previewToolResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: Buffer.alloc(2048).toString('base64'), mimeType: 'image/png' },
        { type: 'resource', resource: { mimeType: 'application/pdf', blob: Buffer.alloc(1024).toString('base64') } },
      ],
    });
    assert.match(preview, /hello\n\[image image\/png 2 KB\]\n\[resource application\/pdf 1 KB\]/);
  });
});

describe('cleanNavigationError', async () => {
  const { cleanNavigationError } = await import('../../src/browser/tab.ts');
  test('maps verbose engine errors to a readable reason', () => {
    const dns =
      'Network error: Network error: http://nonexistent.invalid/: error sending request for uri (http://nonexistent.invalid/): client error (Connect) (source: Some(Error { kind: Connect, source: Some(ConnectError("dns error", Custom { kind: Uncategorized, error: "failed to lookup address information: Name or service not known" })), connect_info: None }))';
    const out = cleanNavigationError(dns);
    assert.match(out, /^the host name could not be resolved/);
    assert.doesNotMatch(out, /source: Some/);
    assert.match(cleanNavigationError('Network error: Access to private/internal IP address 127.0.0.1 is not allowed'), /ALLOW_PRIVATE_NETWORK/);
    assert.match(cleanNavigationError('Network error: connection refused'), /refused/);
    assert.equal(cleanNavigationError('Invalid URL: relative URL without a base'), 'Invalid URL: relative URL without a base');
  });
});

describe('secret redaction', async () => {
  const { redactArgs } = await import('../../src/mcp/server.ts');
  const { cleanJsError } = await import('../../src/browser/tab.ts');
  const refs: Record<string, { type: string; label: string }> = {
    e1: { type: 'password', label: '' },
    e2: { type: 'email', label: 'Email address' },
    e3: { type: 'text', label: 'One-time code' },
  };
  const browser = { activeTab: { refInfo: (r: string) => refs[r] } } as any;

  test('password refs and sensitive selectors are redacted definitively', () => {
    assert.deepEqual(redactArgs('browser_fill', { ref: 'e1', value: 'pw' }, browser, true), { args: { ref: 'e1', value: '[REDACTED]' }, provisional: false });
    assert.deepEqual(redactArgs('browser_type', { ref: 'e3', text: '123456' }, browser, true), { args: { ref: 'e3', text: '[REDACTED]' }, provisional: false });
    assert.deepEqual(redactArgs('browser_fill', { selector: '#password', value: 'pw' }, browser, true).provisional, false);
  });

  test('known safe refs are not redacted; unclassifiable selectors are redacted provisionally', () => {
    assert.deepEqual(redactArgs('browser_fill', { ref: 'e2', value: 'a@b.co' }, browser, true), { args: { ref: 'e2', value: 'a@b.co' }, provisional: false });
    assert.deepEqual(redactArgs('browser_fill', { selector: '#f2', value: 'x' }, browser, true), { args: { selector: '#f2', value: '[REDACTED]' }, provisional: true });
    assert.equal(redactArgs('browser_press_key', { key: 'Enter' }, browser, true).provisional, false);
    assert.equal(redactArgs('browser_press_key', { key: 'a' }, browser, true).provisional, true);
  });

  test('declared sensitive arguments and fill_form fields', () => {
    assert.deepEqual(redactArgs('browser_set_cookie', { name: 'sid', value: 's3cret', url: 'https://x' }, browser, true).args, {
      name: 'sid',
      value: '[REDACTED]',
      url: 'https://x',
    });
    const form = redactArgs('browser_fill_form', { fields: [{ ref: 'e1', value: 'pw' }, { ref: 'e2', value: 'a@b.co' }] }, browser, true);
    assert.deepEqual(form.args, { fields: [{ ref: 'e1', value: '[REDACTED]' }, { ref: 'e2', value: 'a@b.co' }] });
  });

  test('LOG_REDACT_SECRETS=false logs everything', () => {
    assert.deepEqual(redactArgs('browser_fill', { ref: 'e1', value: 'pw' }, browser, false), { args: { ref: 'e1', value: 'pw' }, provisional: false });
  });

  test('cleanJsError strips engine frames', () => {
    assert.equal(cleanJsError('JS error: TypeError: boom here\n    at __fn (<callFnByValue>:3:31)\n    at <callFnByValue>:5:13'), 'TypeError: boom here');
    assert.match(cleanJsError('JS error: Uncaught Error: execution terminated'), /watchdog/);
  });
});

describe('maskCredentials', async () => {
  const { maskCredentials } = await import('../../src/obscura/process.ts');
  test('hides passwords in proxy URLs', () => {
    assert.equal(maskCredentials('http://alice:s3cret@proxy.example:8080'), 'http://alice:***@proxy.example:8080');
    assert.equal(maskCredentials('socks5://u:p%40ss@10.0.0.1:1080'), 'socks5://u:***@10.0.0.1:1080');
    assert.equal(maskCredentials('--stealth'), '--stealth');
    assert.equal(maskCredentials('http://proxy.example:8080'), 'http://proxy.example:8080');
  });
});
