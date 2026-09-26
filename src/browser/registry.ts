import { MAIN_BROWSER, type Hub } from '../dashboard/hub.ts';
import type { Browser } from './browser.ts';

export type BrowserKind = 'main' | 'agent' | 'script';

export interface BrowserInfo {
  id: string;
  label: string;
  kind: BrowserKind;
  /** Agent run or script run that owns the browser. */
  runId?: string;
  status: 'open' | 'closed';
  createdAt: string;
  closedAt?: string;
}

interface Entry extends BrowserInfo {
  browser: Browser | null;
}

const KEEP_CLOSED = 30;

/**
 * Every browser the server runs: the main one and the isolated ones of sub-agents and script
 * runs. The dashboard lists them so a viewer can watch any of them live; closed ones stay
 * listed for a while so their last frame and logs can still be looked at.
 */
export class BrowserRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly hub: Hub;

  constructor(main: Browser, hub: Hub) {
    this.hub = hub;
    this.entries.set(MAIN_BROWSER, {
      id: MAIN_BROWSER,
      label: 'Main browser',
      kind: 'main',
      status: 'open',
      createdAt: new Date().toISOString(),
      browser: main,
    });
  }

  add(browser: Browser, info: { label: string; kind: BrowserKind; runId?: string }): void {
    this.entries.set(browser.id, { id: browser.id, ...info, status: 'open', createdAt: new Date().toISOString(), browser });
    this.hub.publish('browsers', this.list()); // viewers can watch it right away
  }

  close(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || id === MAIN_BROWSER) return;
    entry.status = 'closed';
    entry.closedAt = new Date().toISOString();
    entry.browser = null;
    const closed = [...this.entries.values()].filter((e) => e.status === 'closed');
    for (const old of closed.slice(0, Math.max(0, closed.length - KEEP_CLOSED))) {
      this.entries.delete(old.id);
      this.hub.forgetBrowser(old.id);
    }
    this.hub.publish('browsers', this.list());
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** The live Browser, or null when it was closed. */
  browser(id: string): Browser | null {
    return this.entries.get(id)?.browser ?? null;
  }

  info(id: string): BrowserInfo | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const { browser: _browser, ...info } = entry;
    return info;
  }

  /** Main browser first, then open ones (newest first), then closed ones (newest first). */
  list(): BrowserInfo[] {
    const all = [...this.entries.values()].map(({ browser: _browser, ...info }) => info);
    const rank = (b: BrowserInfo) => (b.kind === 'main' ? 0 : b.status === 'open' ? 1 : 2);
    return all.sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
  }
}
