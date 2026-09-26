import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A headless Chrome driven over the DevTools protocol, for the dashboard UI tests (the dashboard
 * is an ordinary web page; Obscura is not involved). Finds Chrome through CHROME_PATH, the usual
 * install locations, or the PATH; `findChrome()` returns null when there is none, and the UI
 * tests are skipped.
 */

export function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

export interface Page {
  /** Evaluate an expression in the page (awaits promises) and return its JSON value. */
  eval<T = any>(expression: string): Promise<T>;
  /** Wait until the expression is truthy; throws with `what` after the timeout. */
  waitFor(what: string, expression: string, timeoutMs?: number): Promise<void>;
  navigate(url: string): Promise<void>;
  /** A real mouse click at the centre of the first element matching the selector. */
  click(selector: string): Promise<void>;
  /** A real mouse drag between two points, in CSS pixels. */
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
  /** A real key press (e.g. "p", "ArrowRight"). */
  press(key: string): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  setColorScheme(scheme: 'dark' | 'light'): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  screenshot(): Promise<Buffer>;
  /** Uncaught exceptions and console errors seen so far. */
  problems: string[];
  send(method: string, params?: Record<string, unknown>): Promise<any>;
}

export interface Chrome {
  newPage(width?: number, height?: number): Promise<Page>;
  close(): Promise<void>;
}

const KEYS: Record<string, { code: string; keyCode: number }> = {
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Enter: { code: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', keyCode: 27 },
};

export async function launchChrome(binary: string): Promise<Chrome> {
  const profile = mkdtempSync(path.join(tmpdir(), 'sws-ui-chrome-'));
  const child: ChildProcess = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ]);
  const wsUrl: string = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${buf}`)), 30_000);
    child.stderr!.on('data', (d) => {
      buf += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(msg: any) => void>();
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id)!;
      pending.delete(d.id);
      if (d.error) p.reject(new Error(`${d.error.message} (${d.error.code})`));
      else p.resolve(d.result);
    } else if (d.method) {
      for (const l of listeners) l(d);
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });

  const newPage = async (width = 1440, height = 900): Promise<Page> => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
    const problems: string[] = [];
    listeners.add((d) => {
      if (d.sessionId !== sessionId) return;
      if (d.method === 'Runtime.exceptionThrown') {
        const e = d.params.exceptionDetails;
        problems.push(`exception: ${e.exception?.description ?? e.text}`);
      } else if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'assert')) {
        problems.push(`console.${d.params.type}: ${d.params.args.map((a: any) => a.value ?? a.description).join(' ')}`);
      }
    });
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const evalIn = async <T>(expression: string): Promise<T> => {
      const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  in: ${expression.slice(0, 300)}`);
      return r.result?.value as T;
    };
    const center = async (selector: string) => {
      const box = await evalIn<{ x: number; y: number } | null>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
      );
      if (!box) throw new Error(`no visible element for ${selector}`);
      return box;
    };
    const waitFor = async (what: string, expression: string, timeoutMs = 15_000) => {
      const end = Date.now() + timeoutMs;
      let last: unknown;
      for (;;) {
        try {
          last = await evalIn(expression);
          if (last) return;
        } catch (err) {
          last = (err as Error).message;
        }
        if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last value: ${JSON.stringify(last)})`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const mouse = (type: string, x: number, y: number, clickCount = 1) =>
      s('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
    return {
      problems,
      send: s,
      eval: evalIn,
      waitFor,
      async navigate(url) {
        await s('Page.navigate', { url });
        await new Promise((r) => setTimeout(r, 300));
        await waitFor('the page to load', `document.readyState === 'complete'`);
      },
      async click(selector) {
        const { x, y } = await center(selector);
        await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await mouse('mousePressed', x, y);
        await mouse('mouseReleased', x, y);
      },
      async drag(from, to) {
        await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
        await mouse('mousePressed', from.x, from.y);
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: 'left', buttons: 1 });
        }
        await mouse('mouseReleased', to.x, to.y);
      },
      async press(key) {
        const special = KEYS[key];
        const text = special ? undefined : key;
        const code = special?.code ?? `Key${key.toUpperCase()}`;
        const keyCode = special?.keyCode ?? key.toUpperCase().charCodeAt(0);
        await s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text });
        await s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
      },
      async setViewport(w, h) {
        await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
      },
      async setColorScheme(scheme) {
        await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      },
      async setOffline(offline) {
        await s('Network.enable');
        await s('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      },
      async screenshot() {
        const { data } = await s('Page.captureScreenshot', { format: 'png' });
        return Buffer.from(data, 'base64');
      },
    };
  };

  return {
    newPage,
    async close() {
      try {
        ws.close();
      } catch {
        // already closed
      }
      child.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
