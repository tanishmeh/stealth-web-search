# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-26

First public release.

### Added

- **MCP server for the Obscura browser.** Streamable HTTP at `http://127.0.0.1:8931/mcp` for both the 2025 and 2026 protocol revisions, and a stdio bridge (`dist/stdio-bridge.js`) for stdio-only clients. The Docker image bundles the Obscura v0.2.2 stealth release, checksum-verified at build time.
- **41 `browser_*` tools** in seven groups (`core`, `content`, `forms`, `tabs`, `state`, `debug`, `capture`): navigation, page reading (text, Markdown, links, structured extraction), clicking, typing, forms, keyboard, scrolling, waits, tabs, cookies and session state, JavaScript evaluation, console and network inspection, screenshots and PDFs. `TOOLSETS` limits the tools a client sees. See [the tool reference](docs/TOOLS.md).
- **Sub-agents** that run inside the container against any OpenAI-compatible chat completions endpoint (vLLM, LM Studio, Ollama, OpenAI and others): `agent_run` returns the OUTPUT of a TASK, `agent_automate` does the task and then writes, verifies and stores a reusable script, and `agent_find` answers a question with cited sources from several websites (two by default). `agent_wait`, `agent_status` and `agent_cancel` manage runs. Each run gets its own isolated browser, and sub-agent and script browsers run on a second Obscura process (`OBSCURA_SEPARATE_ENGINE`, on by default). See [Sub-agents](docs/AGENTS.md).
- **Automation scripts.** `script_list`, `script_get`, `script_run` and `script_delete` manage the scripts `agent_automate` stores. `script_run` replays a job without a model, in a QuickJS WebAssembly sandbox with no Node.js APIs and with memory, time and call limits.
- **Model configuration file.** `config/models.json` (copy [`config/models.example.json`](config/models.example.json)) configures the sub-agents' model in the provider-list format that editors use for custom endpoints. Comments and trailing commas are accepted, duplicate keys are reported, `${VAR}` works in `apiKey` and `url`, `AGENT_LLM_MODEL` picks a model, and environment variables that are set override the file field by field. The model's `contextWindow` and `maxOutputTokens` cap the agent's budget. `AGENT_MODELS_FILE` points at another file. `compose.yaml` mounts `./config` read-only at `/app/config`. See [Model configuration](docs/MODELS.md).
- **`npm run config:check`** validates the environment variables and the models file and prints the settings the server will use. `--ping` checks that the model endpoint answers, and `--env-file` loads a `.env` file first.
- **Live dashboard** at `http://127.0.0.1:8931/`: a live view of the agent's tab with click, typing and scroll markers, an Activity timeline of every tool call, and Console, Network, Logs, Sessions and Agents tabs. A browser picker switches the live view to any sub-agent's private browser.
- **Structured logging.** Every MCP message, tool call, CDP command and event, page console message and network request is written as JSON lines to rotating files in `./logs/` (level `debug`), and entries at `info` and above also go to stdout. Every sub-agent run leaves a JSON transcript in `./logs/agent-runs/` (`AGENT_TRANSCRIPTS`, on by default). Passwords, cookie values and credential headers are redacted by default (`LOG_REDACT_SECRETS`). See [Logging](docs/LOGGING.md).
- **LM Studio integration.** `npm run lmstudio:setup` adds the server to LM Studio's `mcp.json`, `npm run lmstudio:agent` drives a local model through the browser from the command line, and `npm run lmstudio:e2e` runs end-to-end scenarios with a real model. See [LM Studio](docs/LM_STUDIO.md).
- **Client examples** for LM Studio, Claude Code, Claude Desktop, Cursor, VS Code, OpenAI Codex CLI, Gemini CLI, Continue and Cline in [`examples/`](examples). Each one is explained in [Connecting MCP clients](docs/CLIENTS.md).
- **Hardened container.** The port is published on `127.0.0.1` only, with optional bearer-token authentication (`AUTH_TOKEN`) and DNS-rebinding protection. The browser cannot open `file:` or `javascript:` URLs or, by default, private networks (`ALLOW_PRIVATE_NETWORK`). The container runs as a non-root user on a read-only filesystem, with all capabilities dropped, `no-new-privileges` and a health check at `/healthz`.
- **Tests and CI.** Unit tests, an integration suite that runs against the real Obscura engine (locally or in the container), sub-agent tests with a scripted model, and live checks with a real model (`npm run agents:e2e`, `npm run lmstudio:e2e`). GitHub Actions runs the typecheck, the unit and integration tests, the build and the Docker suite.
- **Documentation** for getting started, MCP clients, LM Studio, configuration, the models file, sub-agents, tools, logging, troubleshooting and architecture in [`docs/`](docs), also published as a website.

[Unreleased]: https://github.com/tanishmeh/stealth-web-search/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tanishmeh/stealth-web-search/releases/tag/v0.1.0
