# Configuration

All settings are environment variables. With Docker Compose, put them in a `.env` file next to `compose.yaml` (start from [`.env.example`](../.env.example)) and run `docker compose up -d` again. Invalid values stop the server at startup with a message naming the variable.

Booleans accept `true/false`, `1/0`, `yes/no` and `on/off`.

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
| `TOOLSETS` | `all` | Tool groups to expose: `core`, `content`, `forms`, `tabs`, `state`, `debug`, `capture`. Individual tool names are also accepted. See [TOOLS.md](TOOLS.md) |

> **Under Docker Compose, `HOST` and `PORT` are fixed by `compose.yaml`.** The server inside the container must bind `0.0.0.0:8931` (the port the image publishes and health-checks), so `compose.yaml` sets `HOST` and `PORT` explicitly and they override anything you put in `.env`. To change the port you reach the server on, set `HOST_PORT` (published on `127.0.0.1` only), not `PORT`. To change the base URL shown in logs and on the dashboard, set `PUBLIC_URL` in `.env` — Compose respects it and falls back to `http://127.0.0.1:${HOST_PORT}` when it is unset. Running the server directly (`npm run dev`), `HOST` and `PORT` work as documented above.

## Obscura browser

| Variable | Default | Description |
|---|---|---|
| `OBSCURA_STEALTH` | `true` | Anti-detection: realistic fingerprint (Chrome on Windows), TLS fingerprint impersonation, `navigator.webdriver` reported as `false`, tracker blocking |
| `OBSCURA_PROXY` | — | `http://…` or `socks5://user:pass@host:port` for all browser traffic |
| `OBSCURA_USER_AGENT` | — | Custom User-Agent |
| `ALLOW_PRIVATE_NETWORK` | `false` | Allow browsing `localhost`, RFC 1918 addresses and `host.docker.internal`. Blocked by default as SSRF protection |
| `OBSCURA_STORAGE_DIR` | — | Persist cookies in this directory. Mount a volume there, for example `./data:/data` with `OBSCURA_STORAGE_DIR=/data` |
| `OBSCURA_NAV_TIMEOUT_MS` | `30000` | Maximum time for one navigation, including redirects and JS-triggered navigations |
| `OBSCURA_JS_WATCHDOG_MS` | `30000` | Stops page JavaScript that runs synchronously for longer than this (`0` = off) |
| `OBSCURA_RESTART_ON_CRASH` | `true` | Restart Obscura with backoff if it exits unexpectedly |
| `OBSCURA_LOG_FILTER` | `warn,obscura=info,obscura_cdp=info,obscura_browser=warn` | Obscura's `RUST_LOG` filter. Its output appears in our logs as `component: obscura-engine` |
| `OBSCURA_EXTRA_ARGS` | — | Extra arguments for `obscura serve` (quotes supported) |
| `OBSCURA_CDP_PORT` | random | Internal CDP port (container loopback only). Left unset, the managed engine picks a random free port each start; set it to pin a fixed port |
| `OBSCURA_CDP_URL` | — | Use an Obscura instance you run yourself, for example `ws://127.0.0.1:9222/devtools/browser`. No process is spawned |
| `OBSCURA_BIN` | `/opt/obscura/obscura` in Docker; `.obscura/obscura` or `obscura` on your `PATH` locally | Path to the Obscura binary |

> **Cookies and CSRF.** Obscura v0.2.2 does not enforce cross-site request protections the way Chromium does: it attaches `SameSite=Strict`/`Lax` cookies to cross-site requests and treats `application/json` POSTs as "simple" requests (no CORS preflight). So any page the agent visits can make cross-site requests that carry cookies you have given the browser — cookies set with `browser_set_cookie`, restored with `browser_set_storage_state`, or persisted across restarts with `OBSCURA_STORAGE_DIR`. Treat every visited page as untrusted, do not persist sensitive logins with `OBSCURA_STORAGE_DIR`, and clear cookies (`browser_clear_cookies`) before sending the agent to untrusted sites.

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
| `LOG_REDACT_SECRETS` | `true` | Keep secrets out of logs and the dashboard: values typed into password- or OTP-like fields, cookie values, session state, and `Cookie`/`Set-Cookie`/`Authorization` headers. The agent still receives everything |
| `LOG_CDP_EVENTS` | `true` | Log every CDP event (network, lifecycle, console) |
