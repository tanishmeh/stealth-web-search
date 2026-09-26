import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted OpenAI-compatible chat completions server for agent tests. The test supplies a
 * policy that looks at the request (messages, tools) and returns the next assistant turn; the
 * server answers like vLLM does: streamed SSE with `reasoning` deltas and tool calls whose
 * arguments arrive in pieces, or a plain JSON completion when stream is false.
 */

export interface FakeTurn {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> | string }>;
  /** Delay before answering (ms). */
  delayMs?: number;
  /** Answer with an HTTP error instead. */
  status?: number;
  error?: string;
  finishReason?: string;
}

export interface FakeRequest {
  body: any;
  headers: http.IncomingHttpHeaders;
  /** Assistant turns already in the conversation + 1. */
  step: number;
  messages: any[];
  toolNames: string[];
  /** Content of the last tool message (the result of the previous call). */
  lastToolResult: string | null;
}

export type Policy = (req: FakeRequest) => FakeTurn | Promise<FakeTurn>;

export interface FakeLlm {
  url: string;
  requests: FakeRequest[];
  setPolicy: (policy: Policy) => void;
  close: () => Promise<void>;
}

export async function startFakeLlm(policy: Policy, opts: { model?: string } = {}): Promise<FakeLlm> {
  let current = policy;
  const model = opts.model ?? 'fake-model';
  const requests: FakeRequest[] = [];
  let counter = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'test' }] }));
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400);
        return res.end('bad json');
      }
      const messages: any[] = body.messages ?? [];
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
      const request: FakeRequest = {
        body,
        headers: req.headers,
        step: messages.filter((m) => m.role === 'assistant').length + 1,
        messages,
        toolNames: (body.tools ?? []).map((t: any) => t.function?.name),
        lastToolResult: lastTool?.content ?? null,
      };
      requests.push(request);
      let turn: FakeTurn;
      try {
        turn = await current(request);
      } catch (err) {
        // a failed assertion in a policy: answer with a non-retryable error so the run fails fast
        turn = { status: 400, error: (err as Error).message };
      }
      if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
      if (res.destroyed) return;
      if (turn.status && turn.status >= 400) {
        res.writeHead(turn.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: turn.error ?? 'error' } }));
      }
      const id = `chatcmpl-${++counter}`;
      const calls = (turn.toolCalls ?? []).map((c, i) => ({
        id: `call-${counter}-${i}`,
        name: c.name,
        args: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments),
      }));
      const finish = turn.finishReason ?? (calls.length ? 'tool_calls' : 'stop');
      const usage = { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 3.5), completion_tokens: 42, total_tokens: 0, completion_tokens_details: { reasoning_tokens: 10 } };

      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: turn.content ?? null,
                  reasoning: turn.reasoning ?? null,
                  tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
                },
                finish_reason: finish,
              },
            ],
            usage,
          }),
        );
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
      send({ role: 'assistant', content: '' });
      for (const piece of split(turn.reasoning ?? '', 7)) send({ reasoning: piece });
      for (const piece of split(turn.content ?? '', 9)) send({ content: piece });
      calls.forEach((c, index) => {
        send({ tool_calls: [{ id: c.id, type: 'function', index, function: { name: c.name } }] });
        for (const piece of split(c.args, 11)) send({ tool_calls: [{ index, function: { arguments: piece } }] });
      });
      send({}, finish);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setPolicy: (p) => {
      current = p;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function split(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
