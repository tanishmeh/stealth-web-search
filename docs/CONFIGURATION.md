# Configuration

All settings are environment variables. With Docker Compose, put them in a `.env` file next to `compose.yaml` (start from [`.env.example`](../.env.example)) and run `docker compose up -d` again. Invalid values stop the server at startup with a message naming the variable. The sub-agents' model can also come from a JSON file, `config/models.json`: see [MODELS.md](MODELS.md).

To check the configuration without starting the server, run it in Docker, where it sees `.env` and `config/models.json` exactly as the server does:

```bash
docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping
```

`--ping` also checks that the sub-agents' model endpoint answers. Without Docker, run `npm run config:check -- --ping`; it reads the variables of your shell, and `--env-file .env` loads a `.env` file first.

Booleans accept `true/false`, `1/0`, `yes/no` and `on/off`. Durations (`*_MS`) are in milliseconds, at most 2147483647 (about 24.8 days).

## HTTP server

| Variable | Default | Description |
|---|---|---|
| `HOST_PORT` | `8931` | (Compose only) Host port for the MCP endpoint and dashboard. Always published on `127.0.0.1` |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address inside the container or process |
| `PORT` | `8931` | Listen port |
| `PUBLIC_URL` | `http://127.0.0.1:<port>` | Base URL shown in logs and on the dashboard |
| `AUTH_TOKEN` | — | If set, `/mcp` requires `Authorization: Bearer <token>` and the dashboard requires `?token=<token>` once (it then sets a cookie). `/healthz` stays open |
| `ALLOWED_HOSTS` | — | Extra accepted `Host` header names (DNS-rebinding protection). `localhost`, `127.0.0.1`, `[::1]` and `host.docker.internal` are always accepted |
| `DASHBOARD_ENABLED` | `true` | Serve the live dashboard at `/` |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Close MCP sessions idle for this long (`0` disables). Clients reconnect automatically |
| `MAX_SESSIONS` | `100` | Maximum concurrent MCP sessions; further `initialize` requests get HTTP 503 |
| `TOOLSETS` | `all` | Tool groups to expose: `core`, `content`, `forms`, `tabs`, `state`, `debug`, `capture`, `agents`, `scripts`, `snapshots`. Individual tool names are also accepted. See [TOOLS.md](TOOLS.md) |

> **Under Docker Compose, `HOST` and `PORT` are fixed by `compose.yaml`.** The server inside the container must bind `0.0.0.0:8931` (the port the image publishes and health-checks), so `compose.yaml` sets `HOST` and `PORT` explicitly and they override anything you put in `.env`. To change the port you reach the server on, set `HOST_PORT` (published on `127.0.0.1` only), not `PORT`. To change the base URL shown in logs and on the dashboard, set `PUBLIC_URL` in `.env` — Compose respects it and falls back to `http://127.0.0.1:${HOST_PORT}` when it is unset. Running the server directly (`npm run dev`), `HOST` and `PORT` work as documented above.

## Obscura browser

| Variable | Default | Description |
|---|---|---|
| `OBSCURA_STEALTH` | `true` | Anti-detection: realistic fingerprint (Chrome on Windows), TLS fingerprint impersonation, `navigator.webdriver` reported as `false`, tracker blocking |
| `OBSCURA_PROXY` | — | `http://…` or `socks5://user:pass@host:port` for all browser traffic |
| `OBSCURA_USER_AGENT` | — | Custom User-Agent |
| `ALLOW_PRIVATE_NETWORK` | `false` | Allow browsing `localhost`, RFC 1918 addresses and `host.docker.internal`. Blocked by default as SSRF protection |
| `OBSCURA_STORAGE_DIR` | — | Persist cookies of the main browser in this directory. Mount a volume there, for example `./data:/data/cookies` with `OBSCURA_STORAGE_DIR=/data/cookies` (on Linux the folder must be writable by uid 1000: `mkdir -p data && sudo chown -R 1000:1000 data`). Sub-agent and script browsers run on the second engine, which has no storage, so they never see these cookies. To give a sub-agent a sign-in, pass it a [snapshot](SNAPSHOTS.md) |
| `OBSCURA_NAV_TIMEOUT_MS` | `30000` | Maximum time for one navigation, including redirects and JS-triggered navigations |
| `OBSCURA_JS_WATCHDOG_MS` | `30000` | Stops page JavaScript that runs synchronously for longer than this (`0` = off) |
| `OBSCURA_RESTART_ON_CRASH` | `true` | Restart Obscura with backoff if it exits unexpectedly |
| `OBSCURA_SEPARATE_ENGINE` | `true` | Run sub-agent and script browsers on a second Obscura process, so a page that crashes the engine there never resets the main browser. Always on with `OBSCURA_STORAGE_DIR` (that engine never persists cookies). Not available with `OBSCURA_CDP_URL` |
| `OBSCURA_LOG_FILTER` | `warn,obscura=info,obscura_cdp=info,obscura_browser=warn` | Obscura's `RUST_LOG` filter. Its output appears in our logs as `component: obscura-engine` |
| `OBSCURA_EXTRA_ARGS` | — | Extra arguments for `obscura serve` (quotes supported) |
| `OBSCURA_CDP_PORT` | random | Internal CDP port (container loopback only). Left unset, the managed engine picks a random free port each start; set it to pin a fixed port |
| `OBSCURA_CDP_URL` | — | Use an Obscura instance you run yourself, for example `ws://127.0.0.1:9222/devtools/browser`. No process is spawned |
| `OBSCURA_BIN` | `/opt/obscura/obscura` in Docker; `.obscura/obscura` or `obscura` on your `PATH` locally | Path to the Obscura binary |

> **Cookies and CSRF.** Obscura v0.2.2 does not enforce cross-site request protections the way Chromium does: it attaches `SameSite=Strict`/`Lax` cookies to cross-site requests and treats `application/json` POSTs as "simple" requests (no CORS preflight). So any page the agent visits can make cross-site requests that carry cookies you have given the browser — cookies set with `browser_set_cookie`, restored with `browser_set_storage_state`, loaded from a [snapshot](SNAPSHOTS.md) (`snapshot_load`, or `agent_run` with `snapshot`), or persisted across restarts with `OBSCURA_STORAGE_DIR`. Treat every visited page as untrusted, do not persist sensitive logins with `OBSCURA_STORAGE_DIR`, and clear cookies (`browser_clear_cookies`) before sending the agent to untrusted sites.

### Build arguments (Docker)

| Argument | Default | Description |
|---|---|---|
| `OBSCURA_VERSION` | `v0.2.2` | Obscura release to bundle. Can also be set in `.env` for Compose |
| `OBSCURA_VARIANT` | `stealth` | `stealth` or `default` (render-only) release archive |
| `OBSCURA_SHA256_ARM64`, `OBSCURA_SHA256_AMD64` | sha256 of the v0.2.2 stealth archives | Update these when changing version or variant (the digest is on the GitHub release page). An empty value skips verification |

## Browser behaviour

| Variable | Default | Description |
|---|---|---|
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` | `1280` / `720` | Viewport of new tabs |
| `ALLOWED_URL_SCHEMES` | `http,https,about,data` | Schemes the agent may open. `file` and `javascript` can never be enabled |
| `TOOL_TIMEOUT_MS` | `120000` | Upper bound for a single tool call |
| `CDP_COMMAND_TIMEOUT_MS` | `45000` | Upper bound for a single browser command |

## Live view

| Variable | Default | Description |
|---|---|---|
| `LIVE_VIEW_ENABLED` | `true` | Stream the agent's tab to the dashboard while someone is watching |
| `LIVE_VIEW_QUALITY` | `60` | JPEG quality of streamed frames |
| `LIVE_VIEW_MAX_WIDTH` / `LIVE_VIEW_MAX_HEIGHT` | `1280` / `720` | Maximum frame size |

## Sub-agents

See [AGENTS.md](AGENTS.md). A models file (`config/models.json`, see [MODELS.md](MODELS.md)) or `AGENT_LLM_URL` enables the `agent_run`, `agent_automate` and `agent_find` tools. The models file is the recommended way to describe the model. With a models file, the `AGENT_LLM_*` variables you set override the matching fields of the file ([which ones](MODELS.md#environment-overrides)).

| Variable | Default | Description |
|---|---|---|
| `AGENT_MODELS_FILE` | `config/models.json` if it exists (`/app/config/models.json` in Docker) | The models file for the sub-agents. `none` ignores the file. A path that does not exist stops the server. See [MODELS.md](MODELS.md#where-the-file-is-read-from) |
| `AGENT_LLM_URL` | — | OpenAI-compatible chat completions endpoint: a base URL (`http://host:8000/v1`) or the full `…/v1/chat/completions` URL. Reached from inside the container: use `http://host.docker.internal:<port>/v1` for a model server on your machine |
| `AGENT_LLM_API_KEY` | — | Sent as `Authorization: Bearer <key>` |
| `AGENT_LLM_MODEL` | first listed | Model id; default: the first model `GET /v1/models` lists. With a models file, it selects a model in the file by id, `<provider name>/<id>` or display name (default: the first model with tool calling) |
| `AGENT_LLM_TEMPERATURE` / `AGENT_LLM_TOP_P` | `0.4` / `0.95` | Sampling; `none` leaves the field out (OpenAI reasoning models only accept their defaults) |
| `AGENT_LLM_MAX_TOKENS_FIELD` | `max_tokens` | Name of the output-token limit field: `max_tokens` (vLLM, LM Studio, Ollama, llama.cpp) or `max_completion_tokens` (OpenAI reasoning models) |
| `AGENT_LLM_REASONING_EFFORT` | `medium` | Sent as `reasoning_effort` (`low`, `medium`, `high`, `xhigh`, …); `none` leaves it out |
| `AGENT_LLM_THINKING` | — | `true`/`false` sends `chat_template_kwargs.enable_thinking` (Qwen-style templates); empty leaves the model default |
| `AGENT_LLM_STREAMING` | `true` | Stream responses (reasoning appears live on the dashboard; only silence counts towards the timeout) |
| `AGENT_LLM_EXTRA_BODY` | — | JSON object merged into every request, e.g. `{"top_k": 20}` |
| `AGENT_LLM_TIMEOUT_MS` | `300000` | Longest silence from the endpoint before a request fails (retried up to 3 times on network errors, 408, 429 and 5xx) |
| `AGENT_CONTEXT_TOKENS` | `65536` | Context budget of one run; the transcript is compacted to fit. Capped by the model's `contextWindow` in the models file |
| `AGENT_MAX_OUTPUT_TOKENS` | `8192` | Output-token limit per model turn (reasoning included), sent in the `AGENT_LLM_MAX_TOKENS_FIELD` field; must be under half of the context budget. Capped by the model's `maxOutputTokens` in the models file |
| `AGENT_MAX_STEPS` | `40` | Default step budget per run (automation runs get at least 50); the host can pass `max_steps` (up to 200) |
| `AGENT_MAX_RUNTIME_MS` | `900000` | Wall-clock limit of one run. Time a run spends waiting for the host's answer to a question does not count |
| `AGENT_MAX_CONCURRENT` | `2` | Runs that work at the same time, each with its own browser; more wait in a queue (up to 20). A run waiting for the host's answer gives up its slot |
| `AGENT_WAIT_SECONDS` | `170` | How long `agent_*` tools wait before answering "still running" (the host passes `wait_seconds` to change it per call). They return at once when the run asks a question |
| `AGENT_MAX_RESULT_CHARS` | `12000` | Tool results longer than this are shortened before they reach the model |
| `AGENT_SEARCH_ENGINE` | `duckduckgo` | `web_search` engine: `duckduckgo` (Bing as fallback) or `bing` |
| `AGENT_TRANSCRIPTS` | `true` | Write a JSON transcript of every run to `LOG_DIR/agent-runs/` (the newest 300 are kept) |
| `AGENT_MAX_QUESTIONS` | `5` | Questions one run may ask the host with `ask_host` (0 to 50). `0` means sub-agents never ask and decide on their own; they still never place an order or pay unless `agent_run` gets `confirm_purchases: false`. See [Questions from sub-agents](AGENTS.md#questions-from-sub-agents) |
| `AGENT_REPLY_TIMEOUT_MS` | `1800000` | How long a run paused on a question waits for `agent_reply` before it continues without an answer (at least `10000`) |
| `AGENT_SNAPSHOT_SAVE` | `true` | Offer `agent_run` agents the `save_sign_in` tool, which saves a sign-in they made as a [snapshot](SNAPSHOTS.md#save_sign_in-a-sub-agent-saves-its-sign-in). Only when `TOOLSETS` includes `snapshots` (the default `all` does) |

## Automation scripts

| Variable | Default | Description |
|---|---|---|
| `SCRIPTS_DIR` | `/data/scripts` in Docker (the `scripts` volume), `./data/scripts` locally | Where `agent_automate` stores scripts (`<name>.js` + `<name>.json`) |
| `SCRIPT_TIMEOUT_MS` | `300000` | Time limit of one script run (also stops endless loops) |
| `SCRIPT_MEMORY_MB` | `64` | Memory limit of the script sandbox |

## Snapshots (saved sign-ins)

See [SNAPSHOTS.md](SNAPSHOTS.md). A snapshot holds live session cookies, so its folder is kept private.

| Variable | Default | Description |
|---|---|---|
| `SNAPSHOTS_DIR` | `/data/snapshots` in Docker (the `snapshots` volume), `./data/snapshots` locally | Where snapshots are stored (`<name>.json` metadata and `<name>.state` cookies and storage). Created with mode 0700, files 0600. Must not be inside `LOG_DIR` or be `SCRIPTS_DIR` (the server refuses to start). If it is not writable, the server logs an error at startup and only the snapshot tools fail |
| `SNAPSHOTS_KEY` | — | Encrypt the saved cookies and storage at rest with this secret (any string; AES-256-GCM, key derived with scrypt). Snapshots saved without a key are encrypted at the next start. A changed or missing key makes older snapshots unreadable. Never logged |

`compose.yaml` mounts the named volume `snapshots` at `/data/snapshots`, so snapshots survive rebuilds and restarts, stay private to the container and out of `./logs`. `docker compose down -v` deletes the volume, and with it every snapshot.

## Logging

See [LOGGING.md](LOGGING.md) for what is logged.

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | stdout level: `trace`, `debug`, `info`, `warn`, `error`, `silent` |
| `LOG_FILE_LEVEL` | `debug` | Log file level |
| `LOG_FORMAT` | `json` in Docker, `pretty` in a terminal | stdout format |
| `LOG_DIR` | `/app/logs` in Docker, `./logs` locally | Log directory |
| `LOG_FILE_MAX_SIZE` | `20m` | Rotate when a file reaches this size |
| `LOG_FILE_MAX_FILES` | `14` | Rotated files to keep |
| `LOG_MAX_STRING_LENGTH` | `2000` | Truncate long strings in logged payloads (images are replaced by size and hash) |
| `LOG_REDACT_SECRETS` | `true` | Keep secrets out of logs and the dashboard: values typed into password- or OTP-like fields, cookie values, session state, and `Cookie`/`Set-Cookie`/`Authorization` headers. The agent still receives everything. Some values are masked whatever this says: the `answer` argument of `agent_reply` (answers that are not secret still appear in the run's questions and result), secret answers wherever a sub-agent repeats them, and the cookies and storage of snapshots |
| `LOG_CDP_EVENTS` | `true` | Log every CDP event (network, lifecycle, console) |
