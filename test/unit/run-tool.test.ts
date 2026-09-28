import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import pino from 'pino';
import * as z from 'zod';
import { Mutex } from '../../src/browser/browser.ts';
import { loadConfig } from '../../src/config.ts';
import { Hub } from '../../src/dashboard/hub.ts';
import { LogTap } from '../../src/logger.ts';
import { runTool, type McpDeps } from '../../src/mcp/server.ts';
import { SessionRegistry } from '../../src/mcp/sessions.ts';
import { defineTool, textResult } from '../../src/tools/types.ts';

/** runTool with a real mutex, hub and session registry, and a browser that has no tab. */
function deps(env: Record<string, string> = {}): McpDeps {
  const log = pino({ level: 'silent' });
  const hub = new Hub(new LogTap());
  const browser = {
    id: 'main',
    mutex: new Mutex(),
    activeTab: null,
    consumeResetNotice: () => null,
    liveView: { afterAction: async () => undefined },
    channel: { publishPointer: () => undefined },
    ensureActiveTab: async () => {
      throw new Error('no tab');
    },
  };
  return { config: loadConfig(env), log, hub, browser: browser as any, sessions: new SessionRegistry(log, hub) };
}

const tool = (handler: () => Promise<ReturnType<typeof textResult>>) =>
  defineTool({
    name: 'test_tool',
    title: 'Test tool',
    group: 'core' as any,
    description: 'test',
    inputSchema: z.object({}),
    annotations: {},
    handler,
  });

const pendingTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

describe('runTool timers', () => {
  test('a finished call leaves no TOOL_TIMEOUT_MS timer behind (it would keep the call in memory)', async () => {
    const d = deps();
    const quick = tool(async () => textResult('done'));
    const before = pendingTimers();
    for (let i = 0; i < 25; i++) {
      const result = await runTool(quick, {}, null, d);
      assert.equal(result.isError, undefined);
    }
    assert.ok(pendingTimers() - before < 5, `pending timers grew by ${pendingTimers() - before} over 25 calls`);
  });

  test('a call that does not finish in TOOL_TIMEOUT_MS still gets the timeout answer', async () => {
    const d = deps({ TOOL_TIMEOUT_MS: '1000' });
    const slow = tool(() => new Promise((resolve) => setTimeout(() => resolve(textResult('late')), 1_300)));
    const started = Date.now();
    const result = await runTool(slow, {}, null, d);
    assert.equal(result.isError, true);
    assert.match(String((result.content[0] as { text: string }).text), /did not finish within 1 s/);
    assert.ok(Date.now() - started < 1_250, 'answered at the timeout, not when the handler finished');
  });
});
