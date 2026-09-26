import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { checkSyntax, runInSandbox, type SandboxHost } from '../../src/scripts/sandbox.ts';
import { ScriptStore, exampleParams, normalizeParams, resolveParams, slugify, stripFences, validateName } from '../../src/scripts/store.ts';

const MB = 1024 * 1024;

function host(impl: Record<string, (...args: any[]) => unknown> = {}): SandboxHost & { lines: string[]; calls: string[] } {
  const lines: string[] = [];
  const calls: string[] = [];
  return {
    lines,
    calls,
    async call(method, args) {
      calls.push(method);
      const fn = impl[method];
      if (!fn) throw new Error(`browser.${method} is not available in this test`);
      return fn(...args);
    },
    log: (line) => lines.push(line),
  };
}

const run = (code: string, h: SandboxHost, params: Record<string, unknown> = {}, extra: Partial<Parameters<typeof runInSandbox>[3]> = {}) =>
  runInSandbox(code, params, h, { timeoutMs: 5_000, memoryBytes: 32 * MB, methods: ['goto', 'extract', 'evaluate', 'fail', 'slow'], ...extra });

describe('script sandbox', () => {
  test('runs run(params) with async browser calls and returns its JSON value', async () => {
    const h = host({
      goto: (url: string) => ({ url, title: 'T', status: 200 }),
      extract: () => ({ 'names': ['a', 'b'] }),
      evaluate: (code: string) => code,
    });
    const res = await run(
      `async function run(params) {
        const page = await browser.goto('https://x.test/?q=' + params.q);
        const [a, b] = await Promise.all([browser.extract({}), browser.extract({})]);
        const src = await browser.evaluate((x, y) => x + y, 1, 2);
        log('page', page.title, { n: a.names.length });
        console.log('also logged');
        return { page, n: a.names.length + b.names.length, src, params };
      }`,
      h,
      { q: 'rust' },
    );
    assert.equal(res.ok, true, (res as any).error);
    assert.deepEqual((res as any).value, {
      page: { url: 'https://x.test/?q=rust', title: 'T', status: 200 },
      n: 4,
      src: '((x, y) => x + y)(1, 2)',
      params: { q: 'rust' },
    });
    assert.deepEqual(h.lines, ['page T {"n":2}', 'also logged']);
    assert.equal(res.calls, 4);
  });

  test('browser errors can be caught; uncaught ones fail the run with the message and line', async () => {
    const h = host({ fail: () => Promise.reject(new Error('browser.fail: no such element')) });
    const caught = await run(`async function run() { try { await browser.fail(); } catch (e) { return 'caught: ' + e.message; } }`, h);
    assert.deepEqual(caught, { ok: true, value: 'caught: browser.fail: no such element', calls: 1 });
    const thrown = await run(`async function run() {\n  await browser.fail();\n}`, h);
    assert.equal(thrown.ok, false);
    assert.match((thrown as any).error, /^browser\.fail: no such element/);
    const custom = await run(`async function run() { throw new TypeError('bad input'); }`, h);
    assert.match((custom as any).error, /^TypeError: bad input \(.*script\.js/);
  });

  test('scripts have no access to Node.js, the network or timers', async () => {
    const res = await run(
      `async function run() {
        let viaFunction;
        try { viaFunction = typeof Function('return process')(); } catch (e) { viaFunction = 'blocked'; }
        return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof XMLHttpRequest, typeof WebSocket, typeof globalThis.__host === 'function', viaFunction];
      }`,
      host(),
    );
    assert.equal(res.ok, true);
    const [proc, req, f, st, xhr, ws, , viaFunction] = (res as any).value;
    assert.deepEqual([proc, req, f, st, xhr, ws], ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    assert.ok(['undefined', 'blocked'].includes(viaFunction));
  });

  test('an endless loop is interrupted and a stuck browser call times out', async () => {
    const t0 = Date.now();
    const loop = await run(`async function run() { while (true) {} }`, host(), {}, { timeoutMs: 300 });
    assert.equal(loop.ok, false);
    assert.match((loop as any).error, /endless loop|did not finish/);
    assert.ok(Date.now() - t0 < 3_000);

    const h = host({ slow: () => new Promise((r) => setTimeout(() => r(1), 1_500)) });
    const stuck = await run(`async function run() { await browser.slow(); return 'late'; }`, h, {}, { timeoutMs: 300 });
    assert.equal(stuck.ok, false);
    assert.match((stuck as any).error, /did not finish within/);
  });

  test('memory, call count and cancellation limits', async () => {
    const mem = await run(`async function run() { const a = []; for (let i = 0; ; i++) a.push('x'.repeat(2e6) + i); }`, host(), {}, { memoryBytes: 8 * MB });
    assert.equal(mem.ok, false);
    assert.match((mem as any).error, /memory/i);

    const many = await run(`async function run() { for (let i = 0; i < 100; i++) await browser.goto('x'); }`, host({ goto: () => null }), {}, { maxCalls: 10 });
    assert.equal(many.ok, false);
    assert.match((many as any).error, /too many browser calls/);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const cancelled = await run(`async function run() { await browser.slow(); }`, host({ slow: () => new Promise((r) => setTimeout(r, 1_000)) }), {}, { signal: ac.signal });
    assert.deepEqual(cancelled.ok, false);
    assert.match((cancelled as any).error, /cancelled/);
  });

  test('scripts must define run(); values must be JSON; syntax errors are reported', async () => {
    const none = await run(`const x = 1;`, host());
    assert.match((none as any).error, /must define: async function run\(params\)/);
    const fn = await run(`async function run() { return undefined; }`, host());
    assert.deepEqual(fn, { ok: true, value: null, calls: 0 });
    const cyclic = await run(`async function run() { const a = {}; a.a = a; return a; }`, host());
    assert.equal(cyclic.ok, false);
    const bad = await run(`async function run( {`, host());
    assert.match((bad as any).error, /SyntaxError/);
    assert.equal(await checkSyntax('async function run(params) { return 1; }'), null);
    assert.match((await checkSyntax('async function run( {'))!, /SyntaxError/);
    assert.match((await checkSyntax('function other() {}'))!, /must define/);
  });
});

describe('script store', () => {
  test('names, fences and slugs', () => {
    assert.equal(slugify('Catalog Search! (v2)'), 'catalog-search-v2');
    assert.equal(slugify('   '), 'script');
    assert.equal(slugify('Ünïcödé Résumé'), 'unicode-resume');
    assert.equal(validateName('ok-name_1'), 'ok-name_1');
    assert.throws(() => validateName('../etc/passwd'), /Invalid script name/);
    assert.throws(() => validateName('Upper'), /Invalid script name/);
    assert.equal(stripFences('```js\nasync function run() {}\n```'), 'async function run() {}');
    assert.equal(stripFences('async function run() {}'), 'async function run() {}');
  });

  test('parameters are declared, coerced, defaulted and checked', () => {
    const params = normalizeParams([
      { name: 'query', type: 'string', description: 'text', example: 'rust' },
      { name: 'limit', type: 'integer', description: 'max', default: '10' },
      { name: 'exact', type: 'boolean', description: 'exact', required: false },
      { name: 'tags', type: 'array', description: 'tags', required: false },
    ]);
    assert.deepEqual(params[0], { name: 'query', type: 'string', description: 'text', required: true, example: 'rust' });
    assert.deepEqual(params[1], { name: 'limit', type: 'integer', description: 'max', required: false, default: 10 });
    assert.deepEqual(resolveParams(params, { query: 'go', limit: '5', exact: 'true', tags: '["a"]' }), { query: 'go', limit: 5, exact: true, tags: ['a'] });
    assert.deepEqual(resolveParams(params, { query: 'go' }), { query: 'go', limit: 10 });
    assert.throws(() => resolveParams(params, {}), /Missing required parameter\(s\): query/);
    assert.throws(() => resolveParams(params, { query: 'x', other: 1 }), /Unknown parameter\(s\): other/);
    assert.throws(() => resolveParams(params, { query: 'x', limit: 1.5 }), /parameter limit must be a integer/);
    assert.deepEqual(exampleParams(params), { query: 'rust', limit: 10 });
    assert.equal(exampleParams(normalizeParams([{ name: 'q', type: 'string', description: '' }])), null);
    assert.throws(() => normalizeParams([{ name: 'bad name', type: 'string' }]), /JavaScript identifier/);
    assert.throws(() => normalizeParams([{ name: 'a', type: 'date' }]), /type must be one of/);
    assert.throws(() => normalizeParams([{ name: 'a' }, { name: 'a' }]), /duplicate parameter/);
  });

  test('save, version, verify, record runs, list, free names and delete', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbm-store-'));
    const store = new ScriptStore(dir);
    const input = { name: 'demo', description: 'd', params: [], output: { description: 'o' }, code: 'async function run() { return 1; }' };
    const v1 = await store.save(input);
    assert.equal(v1.version, 1);
    assert.equal(v1.verification.status, 'not_run');
    await store.setVerification('demo', { status: 'passed', version: 1, params: {} });
    const v2 = await store.save({ ...input, code: 'async function run() { return 2; }' });
    assert.equal(v2.version, 2);
    assert.equal(v2.verification.status, 'not_run', 'a new version must be verified again');
    await store.setVerification('demo', { status: 'passed', version: 1 });
    assert.equal((await store.get('demo')).verification.status, 'not_run', 'a stale verification is ignored');
    await store.setVerification('demo', { status: 'failed', version: 2, error: 'x' });
    await Promise.all([store.recordRun('demo', 'ok'), store.recordRun('demo', 'error'), store.recordRun('demo', 'ok')]);
    const got = await store.get('demo');
    assert.equal(got.runs, 3, 'concurrent updates are serialized');
    assert.equal(got.verification.status, 'failed');
    assert.equal(got.code, 'async function run() { return 2; }');
    assert.equal(readFileSync(path.join(dir, 'demo.js'), 'utf8'), 'async function run() { return 2; }\n');
    assert.equal(await store.freeName('demo'), 'demo-2');
    assert.equal(await store.freeName('Other Thing'), 'other-thing');
    assert.deepEqual((await store.list()).map((s) => s.name), ['demo']);
    await store.delete('demo');
    await assert.rejects(store.get('demo'), /No script named "demo"/);
    await assert.rejects(store.get('../x'), /Invalid script name/);

    // a script whose metadata is broken is not listed, cannot be overwritten by a create-only save, and can be deleted
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dir, 'broken.json'), '{"name": "broken"}');
    writeFileSync(path.join(dir, 'broken.js'), 'async function run() { return "keep me"; }');
    assert.deepEqual((await store.list()).map((s) => s.name), []);
    assert.deepEqual(await store.invalidNames(), ['broken']);
    await assert.rejects(store.get('broken'), /metadata of script "broken"/);
    await assert.rejects(store.save({ ...input, name: 'broken' }, { createOnly: true }), /already exists/);
    assert.equal(readFileSync(path.join(dir, 'broken.js'), 'utf8'), 'async function run() { return "keep me"; }');
    await store.delete('broken');
    assert.deepEqual(await store.invalidNames(), []);
    // an unknown parameter type makes the metadata invalid
    writeFileSync(path.join(dir, 'weird.json'), JSON.stringify({ name: 'weird', version: 1, description: '', params: [{ name: 'd', type: 'date', required: true }], output: { description: '' }, verification: { status: 'not_run', version: 1 }, runs: 0, createdAt: '', updatedAt: '' }));
    writeFileSync(path.join(dir, 'weird.js'), 'async function run() {}');
    assert.ok((await store.invalidNames()).includes('weird'));
    await store.delete('weird');
    // a copied metadata file that names another script is refused
    await store.save({ ...input, name: 'orig' });
    writeFileSync(path.join(dir, 'copy.json'), readFileSync(path.join(dir, 'orig.json')));
    writeFileSync(path.join(dir, 'copy.js'), 'async function run() {}');
    await assert.rejects(store.get('copy'), /says the script is named "orig"/);
  });
});
