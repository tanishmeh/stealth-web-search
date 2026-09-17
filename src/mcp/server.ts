import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { Browser } from '../browser/browser.ts';
import { ToolError } from '../browser/errors.ts';
import { CdpDisconnectedError, CdpTimeoutError } from '../cdp/client.ts';
import type { Config } from '../config.ts';
import type { ActivityEntry, Hub } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import { SERVER_NAME, SERVER_VERSION } from '../version.ts';
import { previewToolResult, summarize } from '../util/summarize.ts';
import { ALL_TOOLS, enabledTools } from '../tools/index.ts';
import { errorResult, type ToolContext, type ToolDefinition } from '../tools/types.ts';
import type { SessionRegistry } from './sessions.ts';

export interface McpDeps {
  config: Config;
  log: Logger;
  hub: Hub;
  browser: Browser;
  sessions: SessionRegistry;
}

export const SERVER_INSTRUCTIONS = `This server controls a real (headless, stealthy) web browser that fully runs JavaScript.
Typical workflow:
1. browser_navigate to open a URL.
2. browser_snapshot to read the page text and get element refs such as "e3".
3. Interact with browser_click / browser_fill / browser_type / browser_select_option / browser_press_key using those refs.
4. After an action that changes the page, call browser_snapshot again (refs reset when the page navigates).
Prefer refs over CSS selectors. Use browser_markdown for long articles, browser_extract for structured data,
browser_wait_for / browser_wait_for_text when content loads asynchronously, and browser_screenshot to check visuals.
All tabs and cookies are shared by every client of this server; a human may be watching the browser live.`;

const SENSITIVE_TARGET = /pass(word)?|passwd|pwd|secret|token|otp|one-time|\bpin\b|cvv|cvc|csc|card-?number|cc-?(num|number)/i;
const TYPING_TOOLS = new Set(['browser_fill', 'browser_type', 'browser_press_key']);
const REDACTED = '[REDACTED]';

export interface RedactedArgs {
  args: unknown;
  /**
   * True when values were hidden only because the target field could not be classified before
   * the call ran (e.g. a CSS selector). runTool logs the real values afterwards unless the tool
   * reported that it handled a secret.
   */
  provisional: boolean;
}

type Classification = 'secret' | 'safe' | 'unknown';

function classifyTarget(target: Record<string, any>, browser: Browser): Classification {
  if (typeof target.selector === 'string' && SENSITIVE_TARGET.test(target.selector)) return 'secret';
  if (typeof target.ref === 'string') {
    const info = browser.activeTab?.refInfo(target.ref);
    if (info) return info.type === 'password' || SENSITIVE_TARGET.test(info.label) ? 'secret' : 'safe';
  }
  return 'unknown';
}

/**
 * Hide secrets from logs and the dashboard before a tool call runs (LOG_REDACT_SECRETS=true):
 * values typed into password-like fields and arguments a tool declares sensitive (cookie values,
 * storage state). The real arguments always reach the tool.
 */
export function redactArgs(toolName: string, args: Record<string, any>, browser: Browser, enabled: boolean): RedactedArgs {
  if (!enabled || !args || typeof args !== 'object') return { args, provisional: false };
  let provisional = false;
  let out: Record<string, any> = args;

  const declared = ALL_TOOLS.find((t) => t.name === toolName)?.sensitive?.args ?? [];
  if (declared.length) {
    out = { ...out };
    for (const key of declared) if (out[key] !== undefined) out[key] = REDACTED;
  }

  const scrubTyped = (a: Record<string, any>, keys: string[]): Record<string, any> => {
    const kind = classifyTarget(a, browser);
    if (kind === 'safe') return a;
    const hidden = keys.filter((k) => typeof a[k] === 'string' && a[k] !== '');
    if (!hidden.length) return a;
    if (kind === 'unknown') provisional = true;
    const copy = { ...a };
    for (const k of hidden) copy[k] = REDACTED;
    return copy;
  };

  if (toolName === 'browser_fill_form' && Array.isArray(out.fields)) {
    out = { ...out, fields: out.fields.map((f: unknown) => (f && typeof f === 'object' ? scrubTyped(f as Record<string, any>, ['value']) : f)) };
  } else if (TYPING_TOOLS.has(toolName)) {
    // a single character sent with press_key could be part of a password; named keys (Enter, Tab…) are not
    const keys = toolName === 'browser_press_key' ? (typeof out.key === 'string' && Array.from(out.key).length === 1 ? ['key'] : []) : ['value', 'text'];
    if (keys.length) out = scrubTyped(out, keys);
  }
  return { args: out, provisional };
}

/** Result shown in logs/dashboard for tools whose results contain secrets. */
export function hiddenResultNote(result: CallToolResult): string {
  const chars = (result.content ?? []).reduce((n, c: any) => n + (typeof c.text === 'string' ? c.text.length : 0), 0);
  return `[result hidden: contains cookie or session values (${chars} characters). Set LOG_REDACT_SECRETS=false to log it]`;
}

/**
 * JSON-RPC ids of tools/call requests that reached a tool handler, per session. Responses to
 * calls that are not in here were rejected by the SDK before running (invalid arguments,
 * unknown or disabled tool) and are recorded separately by the HTTP layer.
 */
const dispatchedCalls = new Set<string>();

export function consumeDispatchedCall(sessionId: string | undefined, rpcId: unknown): boolean {
  const key = `${sessionId}:${String(rpcId)}`;
  return dispatchedCalls.delete(key);
}

/**
 * Per-request context for stateless (2026-07-28 era) MCP calls, which have no session record. Carries
 * the client label so activity/logs are not "client:null", plus the ids the HTTP layer needs to tell a
 * dispatched call from one the SDK rejected before it ran.
 */
export interface ModernScope {
  client: string | null;
  dispatched: Set<string>;
  calls: Map<string, { name: string; args: unknown }>;
}
export const modernScope = new AsyncLocalStorage<ModernScope>();

/**
 * After a tool call times out, keep holding the browser mutex until the underlying handler actually
 * settles (capped) so the next queued call cannot overlap an action that is still driving the browser.
 */
const TIMEOUT_MUTEX_HOLD_MS = 30_000;

/** Run one tool call: queueing, logging, activity feed, error mapping, live-view refresh. */
export async function runTool(
  tool: ToolDefinition<any>,
  args: Record<string, unknown>,
  sessionId: string | null,
  deps: McpDeps,
): Promise<CallToolResult> {
  const { browser, hub, config, sessions } = deps;
  const callId = randomUUID().slice(0, 8);
  // A sessionful (2025-era) call gets its client from the session registry; a stateless (modern) call
  // gets it from the per-request scope, so its activity/logs are not "client:null".
  const client = sessionId ? sessions.clientLabel(sessionId) : (modernScope.getStore()?.client ?? null);
  const log = deps.log.child({ component: 'tool', tool: tool.name, callId, sessionId: sessionId ?? undefined });
  const redaction = redactArgs(tool.name, args, browser, config.log.redactSecrets);
  const safeArgs = summarize(redaction.args, { maxString: config.log.maxStringLength });
  let handledSecret = false;
  sessions.countToolCall(sessionId);
  sessions.beginCall(sessionId);

  const queuedAt = Date.now();
  const entry: ActivityEntry = {
    id: callId,
    tool: tool.name,
    status: browser.mutex.busy ? 'queued' : 'running',
    args: safeArgs,
    sessionId,
    client,
    tabId: browser.activeTab?.id ?? null,
    startedAt: new Date().toISOString(),
  };
  hub.publishActivity(entry);
  log.info({ args: safeArgs, client, queued: browser.mutex.queued }, `tool call ${tool.name}`);

  const ctx: ToolContext = {
    browser,
    config,
    hub,
    log,
    callId,
    session: { id: sessionId, client },
    tab: () => browser.ensureActiveTab(),
    pointer: (tab, x, y, kind, label) =>
      hub.publishPointer({ tabId: tab.id, x: Math.round(x), y: Math.round(y), kind, label, at: new Date().toISOString() }),
    markSensitive: () => {
      handledSecret = true;
    },
  };

  let startedAt = Date.now();
  let result: CallToolResult;
  try {
    result = await new Promise<CallToolResult>((resolve, reject) => {
      browser.mutex
        .run(async () => {
          startedAt = Date.now();
          if (entry.status === 'queued') {
            // earlier calls finished: show this one as running from now on
            entry.status = 'running';
            entry.startedAt = new Date(startedAt).toISOString();
            entry.queuedMs = startedAt - queuedAt;
            hub.publishActivity({ ...entry });
          }
          const handlerPromise = Promise.resolve().then(() => tool.handler(args, ctx));
          handlerPromise.catch(() => undefined); // a rejection after the timeout must not go unhandled
          const outcome = await Promise.race([
            handlerPromise.then((value) => ({ kind: 'ok' as const, value }), (error) => ({ kind: 'err' as const, error })),
            new Promise<{ kind: 'timeout' }>((r) => setTimeout(() => r({ kind: 'timeout' }), config.browser.toolTimeoutMs)),
          ]);
          if (outcome.kind === 'ok') return void resolve(outcome.value);
          if (outcome.kind === 'err') return void reject(outcome.error);
          // Timed out: return a clear error to the client now, but keep holding the mutex until the
          // handler actually settles (capped) so the next queued call cannot overlap an action that
          // is still driving the browser.
          resolve(
            errorResult(
              `${tool.name} did not finish within ${Math.round(config.browser.toolTimeoutMs / 1000)} s. ` +
                'The action may still be completing in the browser; check the page state (browser_snapshot) before retrying.',
            ),
          );
          await Promise.race([handlerPromise.then(() => undefined, () => undefined), new Promise((r) => setTimeout(r, TIMEOUT_MUTEX_HOLD_MS))]);
        })
        .catch(reject);
    });
    const notice = browser.consumeResetNotice(sessionId);
    if (notice) result = { ...result, content: [{ type: 'text', text: `Note: ${notice}` }, ...result.content] };
  } catch (err) {
    if (err instanceof ToolError) {
      result = errorResult(err.message);
      log.warn({ error: err.message }, `tool ${tool.name} failed`);
    } else if (err instanceof CdpDisconnectedError) {
      result = errorResult(`${err.message}. The browser is being restarted; retry the call (open tabs were lost).`);
      log.error({ error: err.message }, `tool ${tool.name} failed: browser disconnected`);
    } else if (err instanceof CdpTimeoutError) {
      result = errorResult(`The browser did not respond in time (${err.method}). The page may be busy running scripts; try again or navigate elsewhere.`);
      log.error({ error: err.message }, `tool ${tool.name} failed: CDP timeout`);
    } else {
      const e = err as Error;
      result = errorResult(e?.message ?? String(err));
      log.error({ err: e }, `tool ${tool.name} threw an unexpected error`);
    }
  } finally {
    sessions.endCall(sessionId);
  }

  const durationMs = Date.now() - startedAt;
  const redactOn = config.log.redactSecrets;
  // selector-based typing was hidden up front; show it now unless the tool hit a secret field
  const loggedArgs =
    redaction.provisional && !handledSecret ? summarize(args, { maxString: config.log.maxStringLength }) : safeArgs;
  const hideResult = redactOn && Boolean(tool.sensitive?.result) && !result.isError;
  const preview = hideResult ? hiddenResultNote(result) : previewToolResult(result as any);
  const done: ActivityEntry = {
    ...entry,
    args: loggedArgs,
    status: result.isError ? 'error' : 'ok',
    endedAt: new Date().toISOString(),
    durationMs,
    preview,
    error: result.isError ? preview : undefined,
    tabId: browser.activeTab?.id ?? entry.tabId,
    url: browser.activeTab?.url,
  };
  hub.publishActivity(done);
  log.info(
    {
      durationMs,
      isError: Boolean(result.isError),
      args: loggedArgs,
      result: hideResult ? preview : summarize(result, { maxString: config.log.maxStringLength }),
      url: done.url,
    },
    `tool result ${tool.name} (${durationMs} ms)${result.isError ? ' [error]' : ''}`,
  );
  void browser.liveView.afterAction(startedAt).catch(() => undefined);
  return result;
}

/** Build an McpServer with all enabled tools. One instance is created per MCP session / modern request. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Stealth Browser MCP' },
    { capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of enabledTools(deps.config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        _meta: { 'stealth-browser-mcp/group': tool.group },
      },
      async (args: Record<string, unknown>, ctx: { sessionId?: string; mcpReq?: { id?: string | number } }) => {
        if (ctx?.sessionId && ctx.mcpReq?.id !== undefined) {
          dispatchedCalls.add(`${ctx.sessionId}:${String(ctx.mcpReq.id)}`);
          if (dispatchedCalls.size > 10_000) dispatchedCalls.clear();
        } else if (ctx?.mcpReq?.id !== undefined) {
          // stateless (modern) call: record that it reached a handler so the HTTP layer can tell it
          // apart from a call the SDK rejected before it ran
          modernScope.getStore()?.dispatched.add(String(ctx.mcpReq.id));
        }
        return runTool(tool, args ?? {}, ctx?.sessionId ?? null, deps);
      },
    );
  }
  return server;
}
