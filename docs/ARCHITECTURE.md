# Architecture

Stealth Web Search is one Docker container with three processes (two with `OBSCURA_SEPARATE_ENGINE=false`):

- **Node.js MCP server** (this repository): speaks the Model Context Protocol to AI clients, serves the live dashboard, and writes the logs.
- **Obscura** ([h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)), twice: a headless browser written in Rust that runs page JavaScript in V8 and renders pages. It runs in stealth mode and is controlled over the Chrome DevTools Protocol (CDP). One engine holds the shared browser that MCP clients drive. The other, the isolated engine, holds the private browsers of sub-agents and script runs, so a page that crashes it cannot reset the shared browser; it never persists cookies.

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

1. Gets its **own `Browser`**: an independent CDP connection of its own. Obscura isolates pages, cookies and storage per connection, so the run cannot see or disturb the host's shared browser or other runs. Sub-agent and script browsers connect to a second, managed Obscura process (`OBSCURA_SEPARATE_ENGINE`, on by default): an engine crash caused by a page they visit does not reset the host's browser, and that engine never persists cookies, so `OBSCURA_STORAGE_DIR` logins stay with the host. It has its own tool queue and live view. The `BrowserRegistry` lists it for the dashboard, and events it publishes (frames, console, network, tabs, pointer markers) carry its `browserId`, so a viewer only receives events of the browser it watches.
2. Runs the agent loop (`src/agents/run.ts`): ask the model (`src/agents/llm.ts`, OpenAI chat completions with function tools, streamed) for the next step, execute its tool calls through the same `runTool()` as MCP clients (logging, activity feed, redaction, timeouts, URL guards), feed the results back, repeat. The loop keeps the transcript within `AGENT_CONTEXT_TOKENS` (`src/agents/conversation.ts`), nudges a model that answers without calling a tool, and forces a final `finish` when steps or time run out.
3. Uses the tools and prompt of its kind (`src/agents/kinds.ts`): the agentic kind has browser tools plus `web_search`/`note`/`finish`; the automation kind has `script_save`/`script_test`; the finder kind has `web_search` (`src/agents/search.ts`) and `cite_source`, which checks that a cited page was opened and that the quote is on it.
4. Ends by closing its browser, writing a transcript to `logs/agent-runs/`, and returning a text plus `structuredContent` result (`src/agents/format.ts`).

Agent and script tools are marked `concurrent`: they never wait in the host browser's queue, so the host keeps browsing while sub-agents work.

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
```

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
| `src/tools/*.ts` | The `browser_*`, `agent_*` and `script_*` tools |
| `src/browser/registry.ts` | All browsers (main, sub-agents, script runs) for the dashboard |
| `src/agents/` | Sub-agents: model client, agent loop, context compaction, the three kinds, web search, result formatting |
| `src/scripts/` | Automation scripts: file store, QuickJS sandbox, the scripts' `browser` API, running them |
| `src/dashboard/` | Event hub, API routes, static UI |
| `src/stdio-bridge.ts` | stdio ↔ HTTP bridge for stdio-only MCP clients |
