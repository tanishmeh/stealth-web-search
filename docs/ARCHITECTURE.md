# Architecture

Stealth Web Search is one Docker container with three processes (two with `OBSCURA_SEPARATE_ENGINE=false`):

- **Node.js MCP server** (this repository): speaks the Model Context Protocol to AI clients, serves the live dashboard, and writes the logs.
- **Obscura** ([h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)), twice: a headless browser written in Rust that runs page JavaScript in V8 and renders pages. It runs in stealth mode and is controlled over the Chrome DevTools Protocol (CDP). One engine holds the shared browser that MCP clients drive. The other, the isolated engine, holds the private browsers of sub-agents and script runs, so a page that crashes it cannot reset the shared browser; it never persists cookies. A sign-in reaches a sub-agent's browser only through a [snapshot](SNAPSHOTS.md) the host names for that run.

```mermaid
flowchart TB
    subgraph Clients
        LMS[LM Studio]
        CD[Claude Desktop / Cursor / VS Code]
        CLI[scripts/lmstudio-agent.ts]
    end
    Human[You, in a web browser]

    subgraph Container["Docker container (stealth-web-search)"]
        direction LR
        subgraph Node["Node.js MCP server :8931"]
            HTTP["/mcp — Streamable HTTP"]
            Tools["Tool layer (browser_*)"]
            Queue["FIFO tool queue"]
            Browser["Browser / Tab model"]
            Live["Live view (screencast)"]
            Hub["Event hub"]
            Dash["/ — dashboard + /api/events (SSE)"]
            Logs["pino logger"]
        end
        Obscura["obscura serve: shared browser (CDP on 127.0.0.1, random port; stealth)"]
        ObscuraIso["obscura serve: isolated engine for sub-agent and script browsers"]
    end
    Web[(Websites)]
    Files[(./logs on the host)]

    LMS & CD & CLI -->|MCP| HTTP --> Tools --> Queue --> Browser
    Browser <-->|CDP WebSocket| Obscura --> Web
    Browser <-->|"CDP (sub-agents, scripts)"| ObscuraIso --> Web
    Browser --> Live --> Hub
    Tools --> Hub
    Hub --> Dash --> Human
    Node --> Logs --> Files
```

## Request flow

1. A client connects to `POST /mcp`. Current clients (including LM Studio 0.4.x) use the 2025 Streamable HTTP protocol: the server creates an MCP session (`Mcp-Session-Id`), one `McpServer` instance per session. Clients that speak the 2026-07-28 revision are routed to a stateless handler with the same tools.
2. A `tools/call` reaches `runTool()` (`src/mcp/server.ts`). It logs the call, publishes a "running" entry to the dashboard, and waits for the **browser queue**. All clients share one browser, and tool calls run one at a time in arrival order, so an agent always sees the effects of its previous action.
3. The tool handler (`src/tools/*.ts`) uses the `Tab` API (`src/browser/tab.ts`), which sends CDP commands through `CdpConnection` (`src/cdp/client.ts`). Page logic runs as small functions via `Runtime.callFunctionOn`, with the agent's input passed as JSON arguments rather than pasted into code.
4. The result goes back to the client and is logged. The dashboard entry is updated, and if someone is watching, a fresh frame of the page is pushed.

## Sub-agents and isolated browsers

`agent_run`, `agent_automate` and `agent_find` start a run in `AgentManager` (`src/agents/manager.ts`) and wait for it (bounded, with MCP progress notifications). Each run:

1. Gets its **own `Browser`**: an independent CDP connection of its own. Obscura isolates pages, cookies and storage per connection, so the run cannot see or disturb the host's shared browser or other runs. Sub-agent and script browsers connect to a second, managed Obscura process (`OBSCURA_SEPARATE_ENGINE`, on by default): an engine crash caused by a page they visit does not reset the host's browser, and that engine never persists cookies, so `OBSCURA_STORAGE_DIR` logins stay with the host. It has its own tool queue and live view. The `BrowserRegistry` lists it for the dashboard, and events it publishes (frames, console, network, tabs, pointer markers) carry its `browserId`, so a viewer only receives events of the browser it watches. If the host passed `snapshot` to `agent_run`, the `SnapshotService` loads it into this browser before the loop starts, and installs a reconnect hook that loads it again if the engine restarts during the run.
2. Runs the agent loop (`src/agents/run.ts`): ask the model (`src/agents/llm.ts`, OpenAI chat completions with function tools, streamed) for the next step, execute its tool calls through the same `runTool()` as MCP clients (logging, activity feed, redaction, timeouts, URL guards), feed the results back, repeat. The loop keeps the transcript within `AGENT_CONTEXT_TOKENS` (`src/agents/conversation.ts`), nudges a model that answers without calling a tool, and forces a final `finish` when steps or time run out. Secret answers from the host are masked by value in everything the loop logs or records (`AgentRun.scrub`, `src/util/scrub.ts`).
3. Uses the tools and prompt of its kind (`src/agents/kinds.ts`): the agentic kind has browser tools plus `web_search`/`note`/`ask_host`/`save_sign_in`/`finish`; the automation kind has `ask_host` and `script_save`/`script_test`; the finder kind has `web_search` (`src/agents/search.ts`) and `cite_source`, which checks that a cited page was opened and that the quote is on it.
4. Can pause on a question. `ask_host` is a concurrent tool, so it never holds the browser queue: it records the question with the URL of the browser's active tab, sets the run to `waiting`, releases the run's slot and waits. `AgentManager.reply()` (the host's `agent_reply`), the `AGENT_REPLY_TIMEOUT_MS` timer or a cancel closes the question and sets the run back to `running` before the waiting call resumes, so a result read right after a reply never shows the old question. The run then takes a slot back ahead of queued runs, and `run.deadline`, the only deadline the loop reads, moves by the time it waited. `AgentManager.wait()` returns as soon as a run waits, which is how `agent_run`, `agent_wait` and `agent_reply` hand the question to the host at once.
5. Ends by saving its sign-in back into its snapshot (only after a successful run, and only if nobody saved a newer version meanwhile), closing its browser, writing a transcript to `logs/agent-runs/`, and returning a text plus `structuredContent` result (`src/agents/format.ts`).

Agent and script tools are marked `concurrent`: they never wait in the host browser's queue, so the host keeps browsing while sub-agents work.

Paused runs keep their browser open, so the `--max-connections` budget the server gives Obscura counts them: the main browser, two connections per concurrent run (its browser and a script test), up to 10 waiting runs (`MAX_WAITING`), 4 script runs and a few spare (`src/util/limits.ts`, `src/obscura/process.ts`).

**Automation scripts** (`src/scripts/`) are stored as `<name>.js` + `<name>.json` in `SCRIPTS_DIR`. `script_run` and the automation agent's tests run them in a fresh isolated browser, inside a QuickJS WebAssembly sandbox (`sandbox.ts`) with no Node.js APIs. The script's only outlet is the `browser` object (`api.ts`), whose methods call the regular browser tools.

```mermaid
flowchart LR
    Host["Host agent"] -->|agent_find| Mgr["AgentManager"]
    Mgr --> Loop["Agent loop"]
    Loop <-->|chat completions| LLM["Model endpoint"]
    Loop -->|runTool| B2["Browser agent-r1a2 (own CDP connection)"]
    Host -->|browser_*| B1["Browser main (shared)"]
    B1 <--> Obscura["obscura serve (shared)"]
    B2 <--> ObscuraIso["obscura serve (isolated engine)"]
    Host -->|script_run| Svc["ScriptService"] --> QJS["QuickJS sandbox"] -->|browser.* → runTool| B3["Browser script-… (own CDP connection)"] <--> ObscuraIso
    Loop -.->|"ask_host: question"| Host
    Host -.->|agent_reply| Mgr
    Host -->|"snapshot_save / snapshot_load"| Snap["SnapshotService"]
    Snap <--> Store[("SNAPSHOTS_DIR")]
    Snap -->|"agent_run snapshot"| B2
    Snap --> B1
```

## Snapshots

Snapshots ([SNAPSHOTS.md](SNAPSHOTS.md)) are saved sign-ins that move between browsers only when an agent asks.

- `SnapshotStore` (`src/snapshots/store.ts`) keeps `<name>.json` (metadata, no secrets) and `<name>.state` (cookies and site storage, AES-256-GCM with `SNAPSHOTS_KEY`) in `SNAPSHOTS_DIR`. It writes the state first, through temporary files that are renamed, and serializes writes per name. An update re-reads the metadata under that lock and never creates a snapshot, so a deleted one stays deleted.
- `SnapshotService` (`src/snapshots/service.ts`) captures a browser's cookies for a domain filter plus the open page's storage, and applies a snapshot to a browser. The cookie and storage helpers are shared with the `state` tools (`src/browser/storage-state.ts`); snapshot code always sends them quietly, so no value reaches the CDP log.
- Obscura v0.2.2 loses `localStorage` on every navigation, so a loaded snapshot's storage is written by one `Page.addScriptToEvaluateOnNewDocument` script per browser (the storage seed), which runs on every new document of the saved origins. Script identifiers restart on every CDP connection, so an old one is removed only on the connection that issued it.
- Each `Browser` records which snapshots it has loaded, at which version and on which connection. A lost connection clears them: the main browser's next tool result says the snapshot was lost, and a sub-agent's browser gets it back through its reconnect hook. A save that finds another version than the one this browser loaded is refused.
- Every change to the store or to a browser's loaded snapshots publishes a `snapshots` event on the hub, which the dashboard's Snapshots tab renders. `DELETE /api/snapshots/:name` is the dashboard's only mutating route. It sits behind the Host and `AUTH_TOKEN` checks, and requires an `X-SBM-Request: 1` header and the server's own `Origin` (the custom header forces a CORS preflight that the server never approves).

## Why the MCP server drives Obscura over CDP

Obscura ships its own `obscura mcp` command, but that runs the browser inside the MCP process, so nothing else can see the page. Obscura's CDP server is also **isolated per WebSocket connection**: a second connection cannot see or screenshot pages opened by the first. A separate "viewer" process therefore cannot watch the agent.

This project owns the CDP connections: one for the shared browser and one per sub-agent or script run. The live view is a `Page.startScreencast` on the watched browser's own active tab, which runs only while at least one dashboard viewer watches that browser. Every tool is implemented on top of that same connection. This also let us fix bugs in Obscura's MCP tools, such as storage restore and form-submit navigation.

## Element references

`browser_snapshot` lists interactive elements with refs such as `e7`. A ref maps to Obscura's internal node id, which is the same as the CDP `backendNodeId`, and is stored **on the server**. Nothing is written into the page (no marker attributes or globals), so anti-bot scripts cannot see it. A ref stays the same for the same element until the document navigates. If the element is removed, using its ref returns a clear "stale ref" error.

## Clicking and typing

- Clicks scroll the element into view, check that the element is actually at that point (not covered), and send real mouse events (`Input.dispatchMouseEvent`). If the element is hidden or covered, they fall back to a DOM `click()` and say so.
- Actions that can navigate (click, Enter, submit, evaluate) are wrapped in `trackNavigation()`, so the tool reports the new URL and title and resets refs.
- URLs are normalized and checked against `ALLOWED_URL_SCHEMES`. `file:` and `javascript:` can never be enabled.

## Obscura quirks the code works around

| Quirk (Obscura v0.2.2) | Handling |
|---|---|
| Any CDP frame containing `"Browser.close"` closes the connection; `Fetch.*` text is dropped during navigation | Outgoing frames escape those substrings (`sanitizeOutgoingFrame`) |
| Some commands never get a reply | Every CDP command has a timeout; every tool has an overall timeout |
| `Page.navigate` reports HTTP 404/500 as success | Status is read from `Network.responseReceived` and shown to the agent |
| Screencast stops after 2 unacknowledged frames | Frames are acknowledged immediately; a still screenshot is taken if no frame arrives after an action |
| Element wrappers are not identity-stable | Scripts compare nodes by internal id |
| Commands on one connection are strictly serialized | Waits poll with short evaluations instead of one long promise |
| Browser state lives in the connection | If Obscura restarts, the server reconnects, and the next tool result tells the agent tabs were reset |

## Process supervision

`src/obscura/process.ts` starts `obscura serve --host 127.0.0.1` (CDP is never reachable from outside the container) and parses its log lines into structured logs. The server runs two of them, the shared engine and the isolated engine (one with `OBSCURA_SEPARATE_ENGINE=false` and no `OBSCURA_STORAGE_DIR`), and restarts each with exponential backoff if it crashes. Inside the container, `tini` is PID 1, Node is the supervisor, and the Obscura engines are Node's children. `docker stop` shuts everything down cleanly within a second.

## Source map

| Path | Responsibility |
|---|---|
| `src/main.ts` | Startup, shutdown, wiring |
| `src/config.ts` | Environment variables → typed config |
| `src/models-config.ts` | `config/models.json`: parsing (comments, duplicate keys), validation, model choice |
| `src/check-config.ts` | `npm run config:check`: prints the settings the server will use, `--ping` checks the model endpoint |
| `src/logger.ts` | Logging to stdout, rotating file and dashboard tap |
| `src/obscura/process.ts` | Obscura lifecycle and its logs |
| `src/cdp/client.ts` | CDP WebSocket client |
| `src/browser/browser.ts` | A browser (the shared one or a sub-agent's): tabs, queue, reconnects |
| `src/browser/tab.ts` | One page: JS helpers, refs, navigation, console and network capture |
| `src/browser/scripts.ts` | Page-side JavaScript |
| `src/browser/liveview.ts` | Screencast to the dashboard |
| `src/mcp/http.ts` | Express app, MCP transports, auth, host checks |
| `src/mcp/server.ts` | Tool registration and the `runTool` wrapper |
| `src/mcp/sessions.ts` | MCP session registry and idle reaper |
| `src/tools/*.ts` | The `browser_*`, `agent_*`, `script_*` and `snapshot_*` tools |
| `src/browser/registry.ts` | All browsers (main, sub-agents, script runs) for the dashboard |
| `src/browser/storage-state.ts` | Reading and writing cookies and site storage, shared by the `state` tools and snapshots |
| `src/agents/` | Sub-agents: model client, agent loop (with questions to the host), context compaction, the three kinds, web search, result formatting |
| `src/scripts/` | Automation scripts: file store, QuickJS sandbox, the scripts' `browser` API, running them |
| `src/snapshots/` | Snapshots: the file store (with encryption) and the service that captures, applies and tracks them |
| `src/util/` | Shared helpers: log summaries, masking of secret answers, limits shared by the agent manager, script runs and the Obscura connection budget |
| `src/dashboard/` | Event hub, API routes, static UI |
| `src/stdio-bridge.ts` | stdio ↔ HTTP bridge for stdio-only MCP clients |
