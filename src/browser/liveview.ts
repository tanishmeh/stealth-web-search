import type { Config } from '../config.ts';
import type { BrowserChannel } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import type { Browser } from './browser.ts';
import type { Tab } from './tab.ts';

/**
 * Streams what the agent's active tab looks like to dashboard viewers.
 *
 * Obscura isolates browser state per CDP connection, so a separate viewer
 * connection cannot see the agent's pages. Instead we run
 * `Page.startScreencast` on the agent's own tab session while at least one
 * viewer is watching, acknowledge each frame immediately (Obscura stops
 * after 2 unacknowledged frames), and fall back to a one-off
 * `Page.captureScreenshot` after tool calls if no frame arrived.
 */
export class LiveView {
  private streamingTab: Tab | null = null;
  private starting: Promise<void> | null = null;
  private readonly browser: Browser;
  private readonly hub: BrowserChannel;
  private readonly config: Config;
  private readonly log: Logger;
  private frames = 0;
  private readonly unsubscribe: () => void;

  constructor(browser: Browser, hub: BrowserChannel, config: Config, log: Logger) {
    this.browser = browser;
    this.hub = hub;
    this.config = config;
    this.log = log.child({ component: 'live-view', ...(hub.browserId === 'main' ? {} : { browserId: hub.browserId }) });
    this.unsubscribe = hub.onViewers((count: number) => {
      this.log.info({ viewers: count }, count > 0 ? 'live view viewer connected' : 'no live view viewers');
      void this.sync();
    });
  }

  get enabled(): boolean {
    return this.config.liveView.enabled && this.config.dashboardEnabled;
  }

  get frameCount(): number {
    return this.frames;
  }

  onTabsChanged(): void {
    void this.sync();
  }

  /** Make the screencast follow the active tab while someone watches. */
  async sync(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    const want = this.enabled && this.hub.viewerCount > 0 ? this.browser.activeTab : null;
    if (want === this.streamingTab && (want === null || !want.closed)) return;
    this.starting = this.switchTo(want);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async switchTo(tab: Tab | null): Promise<void> {
    const previous = this.streamingTab;
    this.streamingTab = null;
    if (previous && !previous.closed) {
      await previous.send('Page.stopScreencast', {}, 5_000).catch(() => undefined);
      this.log.debug({ tabId: previous.id }, 'stopped screencast');
    }
    if (!tab || tab.closed) return;
    // Obscura emits the initial frame before it answers Page.startScreencast: accept this tab's
    // frames already, or that frame is dropped and viewers keep seeing the previous tab.
    this.streamingTab = tab;
    try {
      await tab.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: this.config.liveView.quality,
          maxWidth: this.config.liveView.maxWidth,
          maxHeight: this.config.liveView.maxHeight,
          everyNthFrame: 1,
        },
        15_000,
      );
      this.log.info({ tabId: tab.id }, 'started screencast');
    } catch (err) {
      if (this.streamingTab === tab) this.streamingTab = null;
      this.log.warn({ tabId: tab.id, err: (err as Error).message }, 'could not start screencast; falling back to screenshots');
      await this.captureStill(tab);
    }
  }

  onFrame(tab: Tab, params: Record<string, any>): void {
    // Acknowledge first: Obscura stops streaming after two unacknowledged frames.
    if (typeof params.sessionId === 'number') {
      tab.send('Page.screencastFrameAck', { sessionId: params.sessionId }, 10_000, true).catch(() => undefined);
    }
    if (tab !== this.streamingTab || typeof params.data !== 'string') return;
    this.frames++;
    const md = params.metadata ?? {};
    this.hub.publishFrame({
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      at: new Date().toISOString(),
      width: Math.round(md.deviceWidth ?? this.config.browser.viewport.width),
      height: Math.round(md.deviceHeight ?? this.config.browser.viewport.height),
      scrollX: Math.round(md.scrollOffsetX ?? 0),
      scrollY: Math.round(md.scrollOffsetY ?? 0),
      mimeType: 'image/jpeg',
      data: params.data,
    });
  }

  /**
   * Called after every tool call. If the screencast did not deliver a frame for
   * this action (e.g. the page did not repaint), push a still so viewers never
   * see a stale page.
   */
  async afterAction(startedAt: number): Promise<void> {
    if (!this.enabled || this.hub.viewerCount === 0) return;
    await this.sync();
    const tab = this.browser.activeTab;
    if (!tab || tab.closed) return;
    if (tab.lastFrameAt >= startedAt) return;
    await new Promise((r) => setTimeout(r, 150));
    if (tab.lastFrameAt >= startedAt || tab.closed) return;
    await this.captureStill(tab);
  }

  async captureStill(tab: Tab): Promise<void> {
    try {
      const shot = await tab.send<{ data: string }>(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: this.config.liveView.quality },
        15_000,
      );
      tab.lastFrameAt = Date.now();
      this.frames++;
      this.hub.publishFrame({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        at: new Date().toISOString(),
        width: this.config.browser.viewport.width,
        height: this.config.browser.viewport.height,
        scrollX: 0,
        scrollY: 0,
        mimeType: 'image/jpeg',
        data: shot.data,
      });
    } catch (err) {
      this.log.debug({ tabId: tab.id, err: (err as Error).message }, 'still capture failed');
    }
  }

  stop(): void {
    this.unsubscribe();
    const tab = this.streamingTab;
    this.streamingTab = null;
    if (tab && !tab.closed) void tab.send('Page.stopScreencast', {}, 2_000).catch(() => undefined);
  }
}
