# Logging

The server logs everything that happens between the agent, the MCP server and the browser. Each entry is one JSON object per line (pino format), so you can read it with `jq` or send it to any log pipeline.

## Where logs go

| Destination | Default level | Setting |
|---|---|---|
| stdout (`docker compose logs -f`) | `info` | `LOG_LEVEL`, `LOG_FORMAT=json\|pretty` |
| Rotating file, `./logs/` on the host (`/app/logs` in the container) | `debug` | `LOG_FILE_LEVEL`, `LOG_FILE_MAX_SIZE`, `LOG_FILE_MAX_FILES` |
| Dashboard "Logs" panel (last 2,000 entries) | `debug` | — |

Files rotate daily and when they reach `LOG_FILE_MAX_SIZE` (default 20 MB). The newest `LOG_FILE_MAX_FILES` files are kept, and `logs/current.log` always points at the file being written.

## What is logged

Every entry has `time`, `level`/`levelName`, `component` and `msg`. Components:

| `component` | Level | What |
|---|---|---|
| `main` | info | Startup configuration summary (no secrets), ready URLs, shutdown |
| `http` | info/warn | Every HTTP request: method, path, status, duration, MCP session id, client address, user agent |
| `mcp-session` | info | MCP session start (client name/version, protocol version) and end (reason, number of tool calls, duration) |
| `mcp` | debug | Every JSON-RPC message in (`dir: "in"`) and out (`dir: "out"`) per session, with payloads summarized |
| `tool` | info/warn | Every tool call: arguments, calling client, queue depth. Then its result, duration and error flag. Same `callId` on both lines. Calls rejected before running (invalid arguments, unknown tool) are logged as warnings too |
| `browser` | info | Tabs opened, closed and switched, page navigations, connection loss and recovery |
| `cdp` | debug | Every CDP command sent (method, params), every response (duration, result or error) and every CDP event |
| `page-console` | debug/info/warn | Page `console.*` output and uncaught exceptions, with page URL |
| `page-network` | debug | Every finished request: method, URL, status, type, size, duration |
| `obscura` | info/warn/error | Obscura process lifecycle: version, arguments, readiness, crashes, restarts |
| `obscura-engine` | per line | Obscura's own log output, parsed into levels (`target` = Rust module) |
| `live-view` | info/debug | Viewers connecting and leaving, screencast start and stop |
| `dashboard` | debug | Dashboard event streams opened and closed |
| `agent` | info/warn | Sub-agent runs: created (input), started (browser), finished (status, steps, duration, token usage, compactions, outcome, sources, script tests) |
| `agent-llm` | debug/info | Every model request (messages, tools, prompt size) and response (duration, finish reason, token usage, tool calls, answer text), retries |
| `script` | info | Script runs (parameters, result, duration, browser calls) and each `log()` line of the script |

Everything a sub-agent or script does carries `agentRunId` (sub-agent run), `browserId` (its private browser, e.g. `agent-r1a2b3c4`) or `script`/`scriptRunId`. Tool calls made by sub-agents appear under `component: "tool"` like any other call, with the `client` label `agent:<kind> <run id>`.

### Sub-agent transcripts

With `AGENT_TRANSCRIPTS=true` (the default), every run also writes `logs/agent-runs/<time>_<kind>_<run id>.json`. It contains the input, the outcome, the saved notes, cited sources, visited pages, script tests, every step (model timing, token usage, full reasoning, tool calls and result previews) and the complete message transcript. The newest 300 transcripts are kept.

### Payload summarization

Logs stay readable and bounded without dropping information silently:

- Strings longer than `LOG_MAX_STRING_LENGTH` (2,000 characters) are cut, and the entry records how many characters were removed: `…(+1234 chars)`.
- Base64 images and PDFs are replaced by `<binary 51234 bytes sha256:…>`.
- `Authorization` and `Cookie` headers are always redacted.
- With `LOG_REDACT_SECRETS=true` (the default), secrets are masked in logs and on the dashboard. The agent still receives the real values; only logs are masked. Set it to `false` for full-fidelity debugging logs. Masked:
  - values typed into password- or OTP-like fields (`type=password`, or a name, label, autocomplete attribute or selector mentioning password, token, OTP, PIN, CVV or card number). A call that targets a field by an arbitrary CSS selector is logged with `[REDACTED]` first; the result line then shows the real value if the field was not sensitive.
  - cookie values in `browser_set_cookie` arguments, `browser_get_cookies` and `browser_storage_state` results, `browser_set_storage_state` input, and CDP cookie commands.
  - `Cookie`, `Set-Cookie`, `Authorization`, `Proxy-Authorization` and `X-API-Key` headers in CDP network events.
- `LOG_CDP_EVENTS=false` stops logging CDP events (network and lifecycle noise) and keeps commands and responses.

## Useful queries

```bash
# Follow tool calls live
tail -F logs/current.log | jq -c 'select(.component=="tool") | {time, msg, args, durationMs, isError}'

# Everything one MCP session did
jq -c 'select(.sessionId=="<session-id>")' logs/current.log

# Failed tool calls with their error text
jq -r 'select(.component=="tool" and .isError==true) | "\(.time) \(.tool): \(.result.content[0].text)"' logs/current.log

# The 10 slowest browser (CDP) commands
jq -s '[.[] | select(.component=="cdp" and .durationMs!=null) | {method, durationMs}] | sort_by(.durationMs) | reverse | .[:10]' logs/current.log

# Page JavaScript errors
jq -r 'select(.component=="page-console" and (.pageLevel=="error" or .pageLevel=="exception")) | "\(.pageUrl): \(.msg)"' logs/current.log

# One sub-agent run, start to finish (tool calls and model turns)
jq -c 'select(.agentRunId=="<run id>" or .runId=="<run id>") | {time, component, msg, tool, durationMs}' logs/current.log

# Model latency and token usage per sub-agent step
jq -c 'select(.component=="agent-llm" and .usage) | {runId, step, durationMs, usage, finishReason}' logs/current.log

# Pretty-print the live stream
tail -F logs/current.log | npx pino-pretty
```

## Example

A single `browser_navigate` call produces, in order:

```json
{"level":30,"component":"http","method":"POST","path":"/mcp","status":200,"durationMs":663,"sessionId":"65438e50-…","msg":"POST /mcp 200"}
{"level":20,"component":"mcp","dir":"in","method":"tools/call","message":{"params":{"name":"browser_navigate","arguments":{"url":"https://quotes.toscrape.com/js/"}}},"msg":"MCP ← tools/call"}
{"level":30,"component":"tool","tool":"browser_navigate","callId":"0b7718f0","args":{"url":"https://quotes.toscrape.com/js/"},"client":"lmstudio-mcp-server-session 1.0.0","queued":0,"msg":"tool call browser_navigate"}
{"level":20,"component":"cdp","dir":"out","method":"Page.navigate","params":{"url":"https://quotes.toscrape.com/js/","waitUntil":"load"},"msg":"CDP → Page.navigate"}
{"level":20,"component":"cdp","dir":"in","method":"Page.navigate","durationMs":612,"msg":"CDP ← Page.navigate (612 ms)"}
{"level":20,"component":"page-network","method":"GET","url":"https://quotes.toscrape.com/static/main.css","status":200,"type":"Stylesheet","size":1124,"durationMs":88,"msg":"GET https://quotes.toscrape.com/static/main.css → 200"}
{"level":30,"component":"browser","tabId":"tab-1","url":"https://quotes.toscrape.com/js/","msg":"page navigated"}
{"level":30,"component":"tool","tool":"browser_navigate","callId":"0b7718f0","durationMs":657,"isError":false,"result":{"content":[{"type":"text","text":"Navigated to https://quotes.toscrape.com/js/ — \"Quotes to Scrape\" (HTTP 200)"}]},"msg":"tool result browser_navigate (657 ms)"}
{"level":20,"component":"mcp","dir":"out","rpcId":3,"message":{"result":{"content":[…]}},"msg":"MCP → result"}
```
