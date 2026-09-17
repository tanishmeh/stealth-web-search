# Client configuration examples

All examples assume the server runs with the default settings: `docker compose up -d`, which serves the MCP endpoint at `http://127.0.0.1:8931/mcp`. Use `127.0.0.1`, not `localhost`: on macOS `localhost` resolves to IPv6 first, and some clients do not fall back.

Every client shares the same browser, tabs and cookies. All tool calls appear in the logs and on the live dashboard at `http://127.0.0.1:8931/`.

| File | Client | Where it goes |
|---|---|---|
| [`lmstudio-mcp.json`](lmstudio-mcp.json) | LM Studio 0.3.17+ | `~/.lmstudio/mcp.json`. Run `npm run lmstudio:setup` instead of copying it by hand. See [docs/LM_STUDIO.md](../docs/LM_STUDIO.md) |
| [`claude-desktop-config.json`](claude-desktop-config.json) | Claude Desktop (stdio only) | `claude_desktop_config.json` (Settings > Developer > Edit Config) |
| [`cursor-mcp.json`](cursor-mcp.json) | Cursor | `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) |
| [`vscode-mcp.json`](vscode-mcp.json) | VS Code (GitHub Copilot agent mode) | `.vscode/mcp.json` in your workspace |

Merge the `mcpServers` / `servers` entry into your existing file. Do not replace the whole file.

## Claude Desktop: pick one entry

Claude Desktop starts MCP servers as local processes that speak stdio. The example has two equivalent entries. Keep only one, or the tools show up twice.

- **`stealth-browser`** runs the bridge that ships in the image: `docker exec -i stealth-browser-mcp node dist/stdio-bridge.js`. It needs no extra software. It inherits the container's `AUTH_TOKEN`, so no token configuration is needed. The container must be running before Claude Desktop starts. The bridge waits up to 15 s for the server.
- **`stealth-browser-via-mcp-remote`** uses [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) from npm, and needs Node.js on the host. It also works when the server runs somewhere other than a local container.

Without Docker, for example with a local `npm run build`, point Claude Desktop at the built bridge:

```json
{
  "mcpServers": {
    "stealth-browser": {
      "command": "node",
      "args": ["/absolute/path/to/Stealth_Browser_MCP/dist/stdio-bridge.js", "http://127.0.0.1:8931/mcp"]
    }
  }
}
```

The bridge logs to stderr only. Claude Desktop shows those logs in its MCP log files. Set `"env": {"BRIDGE_LOG_LEVEL": "debug"}` to log every forwarded message.

If the server restarts or crashes during a tool call, the bridge answers that call with an error instead of leaving the client waiting, and starts a new session on the next request. When stdin ends, the bridge still answers the requests it already sent (for up to `BRIDGE_DRAIN_TIMEOUT_MS`, default 130 s), so a one-shot pipe works as a smoke test:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | docker exec -i stealth-browser-mcp node dist/stdio-bridge.js
```

## When the server requires a token (`AUTH_TOKEN`)

- **LM Studio:** `npm run lmstudio:setup -- --token <token>`, or add `"headers": {"Authorization": "Bearer <token>"}` to the entry.
- **Claude Desktop, docker exec bridge:** nothing to do. With a bridge outside the container, add `"env": {"AUTH_TOKEN": "<token>"}`.
- **Claude Desktop, mcp-remote:** add `"--header", "Authorization:${AUTH_HEADER}"` to `args` and `"env": {"AUTH_HEADER": "Bearer <token>"}`. Write it without spaces around the colon.
- **Cursor:** add `"headers": {"Authorization": "Bearer <token>"}` to the entry.
- **VS Code:** use an input, so the token is not stored in the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "stealth-browser-token", "description": "Stealth Browser MCP AUTH_TOKEN", "password": true }
  ],
  "servers": {
    "stealth-browser": {
      "type": "http",
      "url": "http://127.0.0.1:8931/mcp",
      "headers": { "Authorization": "Bearer ${input:stealth-browser-token}" }
    }
  }
}
```

## Small local models

A long tool list costs context and confuses small models. Start the server with a smaller tool set, for example `TOOLSETS=core` in `.env` (16 tools: navigate, snapshot, click, fill, type, keys, select, check, scroll, waits, screenshot). You can also turn off individual tools in the client, if it supports that.
