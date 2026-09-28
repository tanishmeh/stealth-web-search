# Connecting MCP clients

Stealth Web Search is a standard [MCP](https://modelcontextprotocol.io) server. Any MCP client can use it: LM Studio, Claude Code, Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI, Continue, Cline and others. This page shows the exact configuration for each one, how to add a token, how to reach the server from another machine, and how to check the connection.

All clients share one browser, with the same tabs and cookies. Browser tool calls run one at a time, in the order they arrive. Sub-agents and scripts use their own browsers and run beside them. Every call from every client appears in the logs and on the live dashboard at `http://127.0.0.1:8931/`.

## Contents

- [Before you start](#before-you-start)
- [Endpoint and transports](#endpoint-and-transports)
- [Clients at a glance](#clients-at-a-glance)
- [LM Studio](#lm-studio)
- [Claude Code](#claude-code)
- [Claude Desktop](#claude-desktop)
- [Cursor](#cursor)
- [VS Code](#vs-code)
- [OpenAI Codex CLI](#openai-codex-cli)
- [Gemini CLI](#gemini-cli)
- [Continue](#continue)
- [Cline](#cline)
- [Other clients](#other-clients)
- [Authentication with AUTH_TOKEN](#authentication-with-auth_token)
- [Long tool calls and client timeouts](#long-tool-calls-and-client-timeouts)
- [Small local models](#small-local-models)
- [Remote and LAN access](#remote-and-lan-access)
- [Checking the connection](#checking-the-connection)
- [Common errors](#common-errors)

## Before you start

Start the server and check that it answers:

```bash
docker compose up -d
curl -s http://127.0.0.1:8931/healthz      # {"ok":true,...}
```

All examples on this page assume the default settings. If you changed `HOST_PORT` in `.env`, use that port instead of `8931` everywhere.

Use `127.0.0.1`, not `localhost`. On macOS `localhost` resolves to IPv6 `::1` first, and some clients do not fall back to IPv4.

Never put `host.docker.internal` in a client configuration. Your clients run on your machine, where that name does not resolve. It is only for programs inside containers.

## Endpoint and transports

| Transport | Address or command | Use it for |
|---|---|---|
| Streamable HTTP | `http://127.0.0.1:8931/mcp` | Every client that accepts a server URL |
| stdio, through the bridge | `docker exec -i stealth-web-search node dist/stdio-bridge.js` | Clients that can only start a local process (Claude Desktop, older plugins) |

### Streamable HTTP

The server speaks the Streamable HTTP transport at `/mcp`:

- Clients on the 2025 protocol revisions (up to `2025-11-25`) get a session. This covers current clients, including LM Studio 0.4.x. The server returns an `Mcp-Session-Id` header on `initialize`, the client sends it back with every request, and answers come as a Server-Sent Events stream.
- Clients that negotiate the `2026-07-28` revision are served by a stateless handler with the same tools. They have no session.
- `POST /mcp` needs a JSON body (`Content-Type: application/json`). `GET` and `DELETE` (close the session) are also accepted. Other methods get `405`.
- There is no endpoint for the older HTTP+SSE transport (a separate `/sse` URL). In your client, choose Streamable HTTP. Clients call it `http`, `streamable-http` or `streamableHttp`.
- Sessions idle for `SESSION_IDLE_TIMEOUT_MS` (30 minutes by default) are closed. The next request gets `404 Session not found`, and most clients then start a new session by themselves.
- At most `MAX_SESSIONS` (100 by default) sessions can be open at once. Further `initialize` requests get `503`.

### The stdio bridge

The bridge, `dist/stdio-bridge.js`, lets a client that only speaks stdio use the running server. It reads MCP messages on stdin, forwards them to `/mcp` and writes the answers to stdout. The client then shares the same browser, logs and dashboard as every other client.

There are three ways to run a bridge:

| Way | Command | Needs |
|---|---|---|
| The bridge inside the container (recommended) | `docker exec -i stealth-web-search node dist/stdio-bridge.js` | Docker only. The container must be running |
| The bridge from a local build | `node /absolute/path/to/stealth-web-search/dist/stdio-bridge.js http://127.0.0.1:8931/mcp` | Node.js 24+ and `npm ci && npm run build` in your checkout |
| [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), a third-party npm package | `npx -y mcp-remote@0.14.2 http://127.0.0.1:8931/mcp --transport http-only` | Node.js on the host |

The bridge inside the container needs no software on your machine besides Docker, and it inherits the container's `AUTH_TOKEN`. The other two also work when the server runs somewhere else.

Bridge settings:

| Setting | Default | Meaning |
|---|---|---|
| First argument, or `MCP_URL` | `http://127.0.0.1:8931/mcp` (the port comes from `PORT` when it is set) | Server endpoint. Must be `http` or `https`. The argument wins over `MCP_URL` |
| `AUTH_TOKEN` | — | Sent as `Authorization: Bearer <token>`. Inside the container it is already set to the server's token |
| `BRIDGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. `debug` also logs each message the client sends |
| `BRIDGE_CONNECT_TIMEOUT_MS` | `15000` | How long the bridge retries an unreachable server during the handshake |
| `BRIDGE_DRAIN_TIMEOUT_MS` | `330000` | After stdin ends, how long the bridge still waits for answers to requests it already sent |

`--help` prints the usage. An invalid URL stops the bridge with exit code `2`.

How the bridge behaves:

- It logs to stderr only, with the prefix `[stealth-web-search-bridge]`, because stdout is the MCP channel. Claude Desktop writes these lines to its MCP log files.
- If the server restarts or crashes during a tool call, the bridge answers that call with an error instead of leaving the client waiting.
- If the server no longer knows the session (idle timeout or restart), the bridge replays the client's handshake and starts a new session on the next request.
- When stdin ends, the bridge still answers the requests it already sent, for up to `BRIDGE_DRAIN_TIMEOUT_MS`, then exits. So a one-shot pipe works as a smoke test:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | docker exec -i stealth-web-search node dist/stdio-bridge.js
```

The output is two JSON lines: the `initialize` result, then the tool list.

## Clients at a glance

Each example file in [`examples/`](../examples) holds one entry. Merge it into your existing configuration. Do not replace the whole file, or you lose your other servers.

| Client | Transport | Where the configuration goes | Example file |
|---|---|---|---|
| [LM Studio](#lm-studio) 0.3.18+ | Streamable HTTP | `~/.lmstudio/mcp.json` (use `npm run lmstudio:setup` or the one-click link) | [`lmstudio-mcp.json`](../examples/lmstudio-mcp.json) |
| [Claude Code](#claude-code) | Streamable HTTP | `claude mcp add`, or `.mcp.json` in the project | [`claude-code-mcp.json`](../examples/claude-code-mcp.json) |
| [Claude Desktop](#claude-desktop) | stdio, through a bridge | `claude_desktop_config.json` | [`claude-desktop-config.json`](../examples/claude-desktop-config.json) |
| [Cursor](#cursor) | Streamable HTTP | `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) | [`cursor-mcp.json`](../examples/cursor-mcp.json) |
| [VS Code](#vs-code) (GitHub Copilot agent mode) | Streamable HTTP | `.vscode/mcp.json` in your workspace, or your user configuration | [`vscode-mcp.json`](../examples/vscode-mcp.json) |
| [OpenAI Codex CLI](#openai-codex-cli) | Streamable HTTP | `~/.codex/config.toml` | [`codex-config.toml`](../examples/codex-config.toml) |
| [Gemini CLI](#gemini-cli) | Streamable HTTP | `~/.gemini/settings.json` (all projects) or `.gemini/settings.json` (one project) | [`gemini-settings.json`](../examples/gemini-settings.json) |
| [Continue](#continue) | Streamable HTTP | `.continue/mcpServers/stealth-web-search.yaml` | [`continue-mcp.yaml`](../examples/continue-mcp.yaml) |
| [Cline](#cline) | Streamable HTTP | Cline's MCP settings (`~/.cline/mcp.json` for the Cline CLI) | [`cline-mcp-settings.json`](../examples/cline-mcp-settings.json) |

The formats were checked against each client's documentation in September 2026. Clients change their formats from time to time. If a client rejects an entry, compare it with that client's current MCP documentation.

## LM Studio

LM Studio has its own guide, [LM Studio](LM_STUDIO.md). It covers chat use, recommended model settings, the command-line agent and troubleshooting. The short version:

1. Add the server to LM Studio in one of three ways:
   - **One click.** With the server on the default address and no `AUTH_TOKEN`, open **[Add to LM Studio](https://lmstudio.ai/install-mcp?name=stealth-web-search&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg5MzEvbWNwIiwidGltZW91dCI6MTgwMDAwfQ%3D%3D)** and confirm the install dialog in LM Studio.
   - **Setup script.** Run `npm run lmstudio:setup` (needs Python 3.9 or newer). It adds or updates only its own entry in `~/.lmstudio/mcp.json` and writes a backup first. Add `-- --token <token>` for a server with `AUTH_TOKEN`, or `-- --url http://127.0.0.1:<port>/mcp` for another port.
   - **By hand.** In LM Studio, open the right sidebar's **Program** tab, choose **Install > Edit mcp.json**, and add the entry from [`examples/lmstudio-mcp.json`](../examples/lmstudio-mcp.json):

     ```json
     {
       "mcpServers": {
         "stealth-web-search": {
           "url": "http://127.0.0.1:8931/mcp",
           "timeout": 180000
         }
       }
     }
     ```

2. Load a model trained for tool use with a context length of 32768 or more.
3. In a new chat, open the **Integrations** panel and turn on **mcp/stealth-web-search**.

Keep `"timeout": 180000`. The unit is milliseconds, and LM Studio's default of 60 seconds is too short for slow pages and for the sub-agent tools.

Use a `url` entry, not a `command` entry. Stdio servers have been reported to hang in some LM Studio versions.

LM Studio can also be the model for the sub-agents. That is a separate setting on the server side: see [Model configuration](MODELS.md) and [LM Studio as the model for sub-agents](LM_STUDIO.md#9b-lm-studio-as-the-model-for-sub-agents).

## Claude Code

Add the server with one command:

```bash
claude mcp add --transport http stealth-web-search http://127.0.0.1:8931/mcp
```

This adds it for the current project, visible only to you. Other scopes:

| Scope | Command | Stored in |
|---|---|---|
| This project, only you (default) | `claude mcp add --transport http stealth-web-search http://127.0.0.1:8931/mcp` | `~/.claude.json`, under the project's path |
| All your projects | `claude mcp add --transport http stealth-web-search --scope user http://127.0.0.1:8931/mcp` | `~/.claude.json` |
| This project, shared with your team | `claude mcp add --transport http stealth-web-search --scope project http://127.0.0.1:8931/mcp` | `.mcp.json` in the project root |

A project-scoped `.mcp.json` looks like [`examples/claude-code-mcp.json`](../examples/claude-code-mcp.json):

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "type": "http",
      "url": "http://127.0.0.1:8931/mcp"
    }
  }
}
```

Claude Code asks for your approval before it uses servers from a project's `.mcp.json`.

With `AUTH_TOKEN` set on the server, pass the header when you add the server:

```bash
claude mcp add --transport http stealth-web-search http://127.0.0.1:8931/mcp \
  --header "Authorization: Bearer <token>"
```

In `.mcp.json`, which you may commit, reference an environment variable instead of writing the token. Claude Code expands `${VAR}`:

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "type": "http",
      "url": "http://127.0.0.1:8931/mcp",
      "headers": { "Authorization": "Bearer ${STEALTH_WEB_SEARCH_TOKEN}" }
    }
  }
}
```

Check the connection with `claude mcp list` in a terminal, or `/mcp` inside a Claude Code session.

## Claude Desktop

Claude Desktop starts local MCP servers as processes that speak stdio, so it connects through a bridge. The configuration file is:

| System | File |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Open it from Claude Desktop with **Settings > Developer > Edit Config**. After you save it, quit Claude Desktop completely and start it again.

[`examples/claude-desktop-config.json`](../examples/claude-desktop-config.json) has two equivalent entries. **Keep only one**, or every tool shows up twice.

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "command": "docker",
      "args": ["exec", "-i", "stealth-web-search", "node", "dist/stdio-bridge.js"]
    },
    "stealth-web-search-via-mcp-remote": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.2", "http://127.0.0.1:8931/mcp", "--transport", "http-only"]
    }
  }
}
```

- **`stealth-web-search`** runs the bridge that ships in the image. It needs no extra software. It inherits the container's `AUTH_TOKEN`, so no token configuration is needed. The container must be running before Claude Desktop starts. The bridge waits up to 15 s for the server inside it.
- **`stealth-web-search-via-mcp-remote`** uses [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) from npm and needs Node.js on the host. It also works when the server runs somewhere other than a local container.

Without Docker, for example with a local `npm run build`, point Claude Desktop at the built bridge:

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "command": "node",
      "args": ["/absolute/path/to/stealth-web-search/dist/stdio-bridge.js", "http://127.0.0.1:8931/mcp"]
    }
  }
}
```

With `AUTH_TOKEN` set on the server:

- **Bridge inside the container:** nothing to do.
- **Bridge from a local build:** add `"env": {"AUTH_TOKEN": "<token>"}` to the entry.
- **mcp-remote:** add a `--header` argument and put the token in `env`. Write the header without spaces around the colon: some clients do not escape spaces inside `args` when they start `npx`, which breaks the value.

  ```json
  {
    "mcpServers": {
      "stealth-web-search-via-mcp-remote": {
        "command": "npx",
        "args": ["-y", "mcp-remote@0.14.2", "http://127.0.0.1:8931/mcp", "--transport", "http-only", "--header", "Authorization:${AUTH_HEADER}"],
        "env": { "AUTH_HEADER": "Bearer <token>" }
      }
    }
  }
  ```

Logs: Claude Desktop writes MCP logs to `~/Library/Logs/Claude` (macOS) or `%APPDATA%\Claude\logs` (Windows). `mcp.log` shows connection problems, and `mcp-server-stealth-web-search.log` holds the bridge's stderr. To also log each message Claude Desktop sends, set `BRIDGE_LOG_LEVEL=debug`:

- **Bridge inside the container:** add `"-e", "BRIDGE_LOG_LEVEL=debug"` to `args`, right after `"-i"`. An `env` block does not reach a process started by `docker exec`.
- **Bridge from a local build:** add `"env": {"BRIDGE_LOG_LEVEL": "debug"}` to the entry.

If the log says that `docker`, `node` or `npx` cannot be found, Claude Desktop does not see the `PATH` of your shell. Put the full path in `command`. `which docker` shows it.

## Cursor

Add the entry to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project ([`examples/cursor-mcp.json`](../examples/cursor-mcp.json)):

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "url": "http://127.0.0.1:8931/mcp"
    }
  }
}
```

With `AUTH_TOKEN` set, add a header. Cursor expands `${env:NAME}`, so the token can stay out of the file:

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "url": "http://127.0.0.1:8931/mcp",
      "headers": { "Authorization": "Bearer ${env:STEALTH_WEB_SEARCH_TOKEN}" }
    }
  }
}
```

Cursor lists the server with its status on its **Customize** page, where you can turn it on or off. For connection errors, open the Output panel (`Cmd+Shift+U` on macOS) and select **MCP Logs**.

## VS Code

In VS Code the tools are used by GitHub Copilot in agent mode. Add the server to `.vscode/mcp.json` in your workspace ([`examples/vscode-mcp.json`](../examples/vscode-mcp.json)). For all workspaces, run **MCP: Open User Configuration** from the Command Palette and add it there. VS Code uses `servers`, not `mcpServers`:

```json
{
  "servers": {
    "stealth-web-search": {
      "type": "http",
      "url": "http://127.0.0.1:8931/mcp"
    }
  }
}
```

With `AUTH_TOKEN` set, use an input so the token is not stored in the file. VS Code asks for it once and masks what you type:

```json
{
  "inputs": [
    { "type": "promptString", "id": "stealth-web-search-token", "description": "Stealth Web Search AUTH_TOKEN", "password": true }
  ],
  "servers": {
    "stealth-web-search": {
      "type": "http",
      "url": "http://127.0.0.1:8931/mcp",
      "headers": { "Authorization": "Bearer ${input:stealth-web-search-token}" }
    }
  }
}
```

To check the connection, run **MCP: List Servers**, select `stealth-web-search` and choose **Show Output**.

## OpenAI Codex CLI

Codex reads MCP servers from `~/.codex/config.toml`, or from `.codex/config.toml` in a trusted project. Add this table ([`examples/codex-config.toml`](../examples/codex-config.toml)):

```toml
[mcp_servers.stealth_web_search]
url = "http://127.0.0.1:8931/mcp"
tool_timeout_sec = 180
```

Codex stops waiting for a tool after `tool_timeout_sec`, 60 seconds by default. The sub-agent tools wait up to 170 seconds before they answer, so raise it as shown.

With `AUTH_TOKEN` set, name an environment variable that holds the token. Codex sends it as `Authorization: Bearer <token>`:

```toml
[mcp_servers.stealth_web_search]
url = "http://127.0.0.1:8931/mcp"
bearer_token_env_var = "STEALTH_WEB_SEARCH_TOKEN"
tool_timeout_sec = 180
```

```bash
export STEALTH_WEB_SEARCH_TOKEN=<token>
codex
```

Check the connection with `codex mcp list`, or `/mcp` inside Codex.

## Gemini CLI

Add the server with one command:

```bash
gemini mcp add --transport http stealth-web-search http://127.0.0.1:8931/mcp
```

This writes to the project's `.gemini/settings.json`. Add `--scope user` before the name to write to `~/.gemini/settings.json` for all projects. By hand, add the entry to either file ([`examples/gemini-settings.json`](../examples/gemini-settings.json)):

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "httpUrl": "http://127.0.0.1:8931/mcp"
    }
  }
}
```

Use `httpUrl`. In Gemini CLI, `url` means the older SSE transport, which this server does not offer.

With `AUTH_TOKEN` set, add a header, either with `--header "Authorization: Bearer <token>"` on `gemini mcp add` or in the file. Gemini CLI replaces `$VAR` and `${VAR}` in the string values of `settings.json` with environment variables, so the token can stay out of the file:

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "httpUrl": "http://127.0.0.1:8931/mcp",
      "headers": { "Authorization": "Bearer ${STEALTH_WEB_SEARCH_TOKEN}" }
    }
  }
}
```

`--header` on `gemini mcp add` writes the value you pass into the file as it is. Do not commit a project `settings.json` that holds a token.

Check the connection with `gemini mcp list`, or `/mcp` inside Gemini CLI.

## Continue

Continue uses MCP tools in agent mode only. Save this file as `.continue/mcpServers/stealth-web-search.yaml` in your workspace ([`examples/continue-mcp.yaml`](../examples/continue-mcp.yaml)):

```yaml
name: Stealth Web Search
version: 0.0.1
schema: v1
mcpServers:
  - name: stealth-web-search
    type: streamable-http
    url: http://127.0.0.1:8931/mcp
```

With `AUTH_TOKEN` set, add the header under `requestOptions`:

```yaml
mcpServers:
  - name: stealth-web-search
    type: streamable-http
    url: http://127.0.0.1:8931/mcp
    requestOptions:
      headers:
        Authorization: Bearer <token>
```

## Cline

In the Cline panel, click the **MCP Servers** icon, open the **Configure** tab and click **Configure MCP Servers**. This opens Cline's MCP settings JSON. Add the entry under `mcpServers` ([`examples/cline-mcp-settings.json`](../examples/cline-mcp-settings.json)). The Cline CLI reads the same format from `~/.cline/mcp.json`.

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:8931/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

With `AUTH_TOKEN` set, add `"headers": { "Authorization": "Bearer <token>" }` to the entry.

`autoApprove` lists tools that run without asking you. Leave it empty unless you trust the model with those tools on any page.

## Other clients

Any other MCP client works the same way:

- If it accepts a server URL, give it `http://127.0.0.1:8931/mcp` and choose the Streamable HTTP transport. Add an `Authorization: Bearer <token>` header when the server has `AUTH_TOKEN` set.
- If it can only start a local process, use the [stdio bridge](#the-stdio-bridge): `docker exec -i stealth-web-search node dist/stdio-bridge.js`.

## Authentication with AUTH_TOKEN

Set `AUTH_TOKEN` in `.env` when anyone but you can reach the port, then run `docker compose up -d`. Any long random string works:

```bash
openssl rand -hex 32
```

What changes on the server:

- `/mcp` requires `Authorization: Bearer <token>`. It does not accept the dashboard's `?token=` link or cookie.
- A request without a valid token gets `401` with the JSON-RPC error `Unauthorized: missing or invalid bearer token` and a `WWW-Authenticate: Bearer` header.
- The dashboard asks for the token once: open `http://127.0.0.1:8931/?token=<token>`. It then sets a cookie.
- `/healthz` stays open, for Docker's health check.

The server does not support OAuth. If a client offers to sign in or authenticate, configure the bearer header instead.

| Client | How to send the token |
|---|---|
| LM Studio | `npm run lmstudio:setup -- --token <token>`, or `"headers": {"Authorization": "Bearer <token>"}` in the entry |
| Claude Code | `--header "Authorization: Bearer <token>"` on `claude mcp add`, or `"headers"` in `.mcp.json` with `${VAR}` |
| Claude Desktop, bridge inside the container | Nothing to do: the bridge inherits the container's `AUTH_TOKEN` |
| Claude Desktop, bridge from a local build | `"env": {"AUTH_TOKEN": "<token>"}` |
| Claude Desktop, mcp-remote | `"--header", "Authorization:${AUTH_HEADER}"` in `args` and `"env": {"AUTH_HEADER": "Bearer <token>"}` |
| Cursor | `"headers": {"Authorization": "Bearer ${env:STEALTH_WEB_SEARCH_TOKEN}"}` |
| VS Code | A `promptString` input with `"password": true`, used as `${input:...}` in `headers` |
| Codex CLI | `bearer_token_env_var = "STEALTH_WEB_SEARCH_TOKEN"` |
| Gemini CLI | `"headers": {"Authorization": "Bearer ${STEALTH_WEB_SEARCH_TOKEN}"}`, or `--header` on `gemini mcp add` |
| Continue | `requestOptions.headers.Authorization: Bearer <token>` |
| Cline | `"headers": {"Authorization": "Bearer <token>"}` |
| stdio bridge anywhere | The `AUTH_TOKEN` environment variable |

Keep tokens out of files you commit. Prefer the client's environment variable or input syntax where it has one.

## Long tool calls and client timeouts

Most tool calls finish in seconds. Some take longer:

| Tool | Longest wait | Setting |
|---|---|---|
| `browser_*` tools | 120 s, then the call returns an error | `TOOL_TIMEOUT_MS` |
| `agent_run`, `agent_automate`, `agent_find`, `agent_wait`, `agent_reply` | 170 s, then the tool answers "still running" and the model calls `agent_wait`. A run that asks a question returns it at once | `AGENT_WAIT_SECONDS`, or `wait_seconds` per call |
| `script_run` | The whole script run, up to 300 s | `SCRIPT_TIMEOUT_MS` |

While an agent tool waits, the server sends MCP progress notifications if the client asked for them.

Set the client's tool timeout to at least 180 seconds, or 330 seconds if you run long scripts (`SCRIPT_TIMEOUT_MS` is 5 minutes by default):

| Client | Tool timeout |
|---|---|
| LM Studio | `"timeout"` in milliseconds. The default is 60 s; `npm run lmstudio:setup` and the one-click link set 180000 |
| Codex CLI | `tool_timeout_sec`. The default is 60 s; set 180 or more |
| Gemini CLI | `"timeout"` in milliseconds. The default of 600000 (10 minutes) is enough |

If a client gives up earlier and has no setting for it, lower `AGENT_WAIT_SECONDS` in `.env` below the client's limit. Runs keep going on the server either way. `agent_wait` collects the result later.

A sub-agent run can also pause and wait for your agent's answer to a question ([Questions from sub-agents](AGENTS.md#questions-from-sub-agents)). The question comes back at once, and the run waits up to `AGENT_REPLY_TIMEOUT_MS` (30 minutes) for `agent_reply`, so no client timeout is involved. A client that ends its turn without answering leaves the run waiting until then.

## Small local models

A long tool list costs context and confuses small models. With sub-agents configured the server offers 57 tools, 50 without. Start the server with a smaller set, for example `TOOLSETS=core` in `.env`: 16 tools for navigation (navigate, back, forward, reload), snapshot, click, fill, type, keys, select, check, scroll, waits and screenshot. See [Tools](TOOLS.md) for the groups.

Some clients can also turn off individual tools, for example LM Studio in its Integrations panel.

Clients read the tool list when they connect. After you change `TOOLSETS`, run `docker compose up -d`, then reconnect the client or start a new chat.

## Remote and LAN access

The port is published on `127.0.0.1` only. That is deliberate: whoever reaches `/mcp` controls a browser on your machine. Pick one of these ways to use the server from another machine.

**SSH tunnel (simplest, no server changes).** On the client machine, forward a local port to the server machine, then use `http://127.0.0.1:8931/mcp` in the client as usual:

```bash
ssh -N -L 8931:127.0.0.1:8931 you@192.168.1.50
```

**A TLS reverse proxy.** Run a reverse proxy (nginx, Caddy, Traefik and others) on the server machine. It terminates TLS and forwards to `127.0.0.1:8931`. Then:

- Set `AUTH_TOKEN`.
- Add the proxy's host name to `ALLOWED_HOSTS` (comma-separated host names, without ports). The server checks the `Host` header of every request except `/healthz` against this list. On `/mcp` it also checks the `Origin` header when a client sends one. Unknown names get `403 Invalid Host` or `403 Invalid Origin`. `localhost`, `127.0.0.1`, `[::1]` and `host.docker.internal` are always accepted. The dashboard's snapshot **Delete** accepts a listed name on any port, so a proxy on a port such as 8443 works.
- Set `PUBLIC_URL` to the proxy's URL, so logs and the dashboard show the right address.
- Turn off response buffering. `/mcp` and the dashboard's `/api/events` stream Server-Sent Events.
- Allow long responses. A tool call can take several minutes (see [Long tool calls](#long-tool-calls-and-client-timeouts)).

For nginx, the `location` block inside your TLS `server` block could look like this:

```nginx
location / {
    proxy_pass http://127.0.0.1:8931;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 600s;
}
```

**Publishing the port on your network.** You can change the `ports` line in `compose.yaml` to publish on a LAN address, for example `"192.168.1.50:8931:8931"`. Only do this with `AUTH_TOKEN` set, and add that address to `ALLOWED_HOSTS`. Plain HTTP sends the token unencrypted, so use it only on a network you trust. Never publish on `0.0.0.0` without `AUTH_TOKEN`.

On the client side:

- The stdio bridge accepts any `http` or `https` URL: `node dist/stdio-bridge.js https://browser.example.com/mcp` with `AUTH_TOKEN` set.
- `mcp-remote` refuses plain `http` URLs for hosts other than `localhost` and `127.0.0.1`. Add `--allow-http` on a trusted network, or use `https`.

`ALLOW_PRIVATE_NETWORK` is unrelated. It controls which sites the browser may open, not who may connect to the server.

## Checking the connection

**Health check.** `/healthz` needs no token:

```bash
curl -s http://127.0.0.1:8931/healthz | jq '{ok, sessions}'
```

`ok` is `true` when the browser engines run. `sessions` counts the connected MCP sessions.

**Dashboard.** Open `http://127.0.0.1:8931/` and select the **Sessions** tab. It lists each connected client with its name (the `clientInfo` the client sends), session id, protocol version, when it connected, when it was last seen, its tool calls and its address. Clients on the `2026-07-28` revision have no session, so they are not listed there. Their calls appear in the **Activity** feed with the client name.

**Server log.** Each new session is logged:

```bash
docker compose logs | grep "MCP session started"
```

Client names you will see: `lmstudio-mcp-server-session` (LM Studio chats), `lmstudio-agent` (`npm run lmstudio:agent`) and `lmstudio-e2e` (`npm run lmstudio:e2e`). Through a stdio bridge, the name is the one the stdio client sends.

**stdio bridge.** Run the [smoke test](#the-stdio-bridge). It prints the `initialize` result and the tool list.

**In the client.** Ask for a small task, such as *"Open https://example.com and tell me the main heading."* The call appears in the dashboard's Activity feed.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused`, `fetch failed`, `ECONNREFUSED` | The server is not running, or the URL is wrong | `docker compose ps` should show `127.0.0.1:8931->8931`. Use `http://127.0.0.1:8931/mcp`, not `localhost`. If you changed `HOST_PORT`, use that port |
| `401 Unauthorized: missing or invalid bearer token` | The server has `AUTH_TOKEN` set | Send `Authorization: Bearer <token>`. See [Authentication](#authentication-with-auth_token) |
| `403 Invalid Host: <name>` or `403 Invalid Origin: <name>` | You reached the server through a host name that is not allowed (DNS-rebinding protection) | Use `127.0.0.1`, or add the name to `ALLOWED_HOSTS` |
| `404 Session not found. Re-initialize the MCP connection.` | The session expired (`SESSION_IDLE_TIMEOUT_MS`, 30 minutes) or the server restarted | Most clients reconnect by themselves. Otherwise reload the server in the client |
| `400 Bad Request: no valid session ID provided` | A request without a session, for example `/mcp` opened in a web browser | Nothing is wrong. The dashboard is at `/`; clients start with `initialize` |
| `405 Method not allowed` | The client used a method other than `GET`, `POST` or `DELETE` | Choose the Streamable HTTP transport in the client |
| `415 Unsupported Media Type` | A `POST` without a JSON body | Send `Content-Type: application/json` |
| `503 Server at capacity` | `MAX_SESSIONS` sessions are open | Close idle clients, or raise `MAX_SESSIONS` |
| The client connects but offers to sign in | The client reacts to the `401` with an OAuth flow | The server has no OAuth. Add the bearer header |
| Tools show up twice in Claude Desktop | Both example entries are in the file | Keep only one |
| `docker`, `node` or `npx` not found (Claude Desktop) | The app does not see your shell's `PATH` | Use the full path from `which docker` in `command` |
| Tool calls fail after 60 seconds | The client's tool timeout is too short | Raise it. See [Long tool calls](#long-tool-calls-and-client-timeouts) |
| The `agent_*` tools are missing | No model is configured for the sub-agents, or `TOOLSETS` leaves them out | Configure a model ([Model configuration](MODELS.md)) and check `TOOLSETS`. Reconnect the client afterwards |
| The model does not call tools, or calls them with wrong arguments | The tool list is too long for the model, or the context is too small | Use `TOOLSETS=core` and a larger context. See [Small local models](#small-local-models) |
| `Navigation … failed: private/internal addresses are blocked` | The browser may not open local addresses by default | Set `ALLOW_PRIVATE_NETWORK=true`. From inside the container, your machine is `http://host.docker.internal:<port>` |

More problems and fixes are in [Troubleshooting](TROUBLESHOOTING.md), and LM Studio-specific ones in [LM Studio](LM_STUDIO.md#10-troubleshooting).
