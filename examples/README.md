# Client configuration examples

Ready-to-use MCP client entries for Stealth Web Search. The full instructions for each client, including tokens, timeouts, remote access and troubleshooting, are in [Connecting MCP clients](../docs/CLIENTS.md).

All examples assume the default settings: `docker compose up -d`, which serves the MCP endpoint at `http://127.0.0.1:8931/mcp`. Use `127.0.0.1`, not `localhost`: on macOS `localhost` resolves to IPv6 first, and some clients do not fall back. Every client shares the same browser, tabs and cookies, and every tool call appears in the logs and on the live dashboard at `http://127.0.0.1:8931/`.

| File | Client | Where it goes | Instructions |
|---|---|---|---|
| [`lmstudio-mcp.json`](lmstudio-mcp.json) | LM Studio 0.3.18+ | `~/.lmstudio/mcp.json`. Run `npm run lmstudio:setup` instead of copying it by hand | [LM Studio](../docs/LM_STUDIO.md) |
| [`claude-code-mcp.json`](claude-code-mcp.json) | Claude Code | `.mcp.json` in the project root, or run `claude mcp add --transport http stealth-web-search http://127.0.0.1:8931/mcp` | [Claude Code](../docs/CLIENTS.md#claude-code) |
| [`claude-desktop-config.json`](claude-desktop-config.json) | Claude Desktop (stdio only) | `claude_desktop_config.json` (Settings > Developer > Edit Config). Keep only one of its two entries | [Claude Desktop](../docs/CLIENTS.md#claude-desktop) |
| [`cursor-mcp.json`](cursor-mcp.json) | Cursor | `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) | [Cursor](../docs/CLIENTS.md#cursor) |
| [`vscode-mcp.json`](vscode-mcp.json) | VS Code (GitHub Copilot agent mode) | `.vscode/mcp.json` in your workspace | [VS Code](../docs/CLIENTS.md#vs-code) |
| [`codex-config.toml`](codex-config.toml) | OpenAI Codex CLI | `~/.codex/config.toml` | [OpenAI Codex CLI](../docs/CLIENTS.md#openai-codex-cli) |
| [`gemini-settings.json`](gemini-settings.json) | Gemini CLI | `~/.gemini/settings.json` (all projects) or `.gemini/settings.json` (one project) | [Gemini CLI](../docs/CLIENTS.md#gemini-cli) |
| [`continue-mcp.yaml`](continue-mcp.yaml) | Continue | `.continue/mcpServers/stealth-web-search.yaml` | [Continue](../docs/CLIENTS.md#continue) |
| [`cline-mcp-settings.json`](cline-mcp-settings.json) | Cline | Cline's MCP settings (MCP Servers > Configure > Configure MCP Servers), or `~/.cline/mcp.json` for the Cline CLI | [Cline](../docs/CLIENTS.md#cline) |

Merge the `mcpServers` / `servers` entry into your existing file. Do not replace the whole file.

When the server has `AUTH_TOKEN` set, each client needs the token as an `Authorization: Bearer <token>` header. How to add it to each client is in [Authentication with AUTH_TOKEN](../docs/CLIENTS.md#authentication-with-auth_token).

A client that can only start a local process (stdio) connects through the bridge that ships in the image: `docker exec -i stealth-web-search node dist/stdio-bridge.js`. See [The stdio bridge](../docs/CLIENTS.md#the-stdio-bridge).
