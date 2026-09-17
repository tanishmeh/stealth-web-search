# Troubleshooting

Start with these three commands. They answer most questions:

```bash
curl -s http://127.0.0.1:8931/healthz | jq     # is the server up, is Obscura running, how many tabs/sessions
docker compose logs --tail 100                  # what the server printed recently
jq -c 'select(.level>=40)' logs/current.log     # every warning and error, with full context
```

## The container

**`docker compose up` fails while downloading Obscura (`curl: (22)` or `sha256sum: WARNING: 1 computed checksum did NOT match`)**
The build downloads the Obscura release from GitHub. Check your network or proxy. If you changed `OBSCURA_VERSION`, also update `OBSCURA_SHA256_ARM64` / `OBSCURA_SHA256_AMD64` in the `Dockerfile`, or pass them as build args. The digests are shown on the release page.

**The container is `unhealthy` or keeps restarting**
Run `docker compose logs`. `Obscura failed to start` with an `exec format error` means the image was built for the wrong CPU architecture. Rebuild on the target machine, or use `docker buildx build --platform linux/amd64,linux/arm64`. Obscura ships only Linux amd64 and arm64 builds.

**`EACCES: permission denied` for `/app/logs` (Linux hosts)**
The server runs as uid 1000 inside the container, and the `./logs` bind mount must be writable by it: `mkdir -p logs && sudo chown 1000:1000 logs`. Alternatively, replace the bind mount with a named volume in `compose.yaml`.

**Port 8931 is already in use**
Set `HOST_PORT=8932` in `.env`, run `docker compose up -d`, and use `http://127.0.0.1:8932/mcp` in your clients.

## Connecting clients

**Client says `connection refused` or cannot connect**
- Use `http://127.0.0.1:8931/mcp`, not `localhost`. On macOS `localhost` resolves to IPv6 `::1` first, and some clients do not fall back.
- The port is published on host loopback only. Clients on another machine cannot reach it by design (see *Security* in the README).
- The endpoint path is `/mcp`. The dashboard is at `/`.

**`403 Invalid Host`**
The request's `Host` header is not in the allow-list (DNS-rebinding protection). This happens when you reach the server through a hostname such as a reverse proxy or a Compose service name. Add it to `ALLOWED_HOSTS`.

**`401 Unauthorized`**
`AUTH_TOKEN` is set. Send `Authorization: Bearer <token>` from the client (LM Studio: `"headers"` in `mcp.json`), and open the dashboard once with `http://127.0.0.1:8931/?token=<token>`.

**`404 Session not found`**
The MCP session expired (`SESSION_IDLE_TIMEOUT_MS`, 30 minutes by default) or the server restarted. Most clients reconnect automatically. Otherwise, reload the MCP server in the client.

**A stdio-only client**
Use the bridge: `docker exec -i stealth-browser-mcp node dist/stdio-bridge.js`, or `npx mcp-remote http://127.0.0.1:8931/mcp`. See [`examples/`](../examples).

## Browsing

**`Navigation … failed: private/internal addresses are blocked`**
By default the browser may not open `localhost`, `192.168.x.x`, `10.x.x.x` or `host.docker.internal` (SSRF protection). Set `ALLOW_PRIVATE_NETWORK=true`. Inside the container, reach services on your computer at `http://host.docker.internal:<port>`, not `127.0.0.1`.

**A page looks empty, or content is missing**
- The content may load after the `load` event. Navigate with `waitUntil: "networkidle0"`, or call `browser_wait_for` / `browser_wait_for_text`.
- Obscura is its own engine, not Chromium. Some complex sites and Web APIs do not work yet. Check `browser_console_messages` and the dashboard's Console tab for script errors.
- Heavy single-page apps can exceed the script budget. Raise `OBSCURA_JS_WATCHDOG_MS` or pass `OBSCURA_EXTRA_ARGS` / Obscura env vars (see Obscura's docs).

**`Element ref 'e12' is no longer valid`**
The page changed or navigated since the snapshot. Call `browser_snapshot` again. Refs stay stable only for the same document.

**Typed text does not appear in the screenshot or live view**
This is a rendering limitation of Obscura v0.2.2: input values and checkbox states are not painted. The value is set, as `browser_snapshot` and form submissions show. The dashboard's activity feed shows what was typed.

**CJK, Thai or Devanagari text renders as boxes in screenshots**
Obscura v0.2.2 ignores system fonts. Text extraction is unaffected.

**Clicking a `#`-fragment link does nothing (hash-based SPA route or in-page anchor)**
Obscura v0.2.2 ignores URL-fragment navigation: clicking an `<a href="#…">` link or setting `location.hash` does not fire `hashchange` and does not change a hash-based SPA route. Use the app's real navigation control instead, or drive the route change yourself with `browser_evaluate`:

```js
history.pushState({}, '', '#/section');
window.dispatchEvent(new HashChangeEvent('hashchange'));
// or: window.dispatchEvent(new PopStateEvent('popstate'))
```

**A click did nothing**
- The tool result says whether it used real mouse events or a DOM click fallback (hidden or covered element). Try the element that is actually visible, such as the label or a parent button.
- Hover menus do not open. Obscura does not dispatch hover events.
- An inline element (a link or span) placed right after a block-level sibling can be measured as a 0×0 box in Obscura v0.2.2, so the visibility check may treat it as hidden even though you can see it. Click a parent or a nearby block-level element, or reach it with `browser_evaluate`. The same 0×0 boxes mean such elements can be missing from screenshots; `browser_snapshot` and text extraction still find them.

**A tool times out**
Each browser command has a timeout (`CDP_COMMAND_TIMEOUT_MS`), and so does each tool call (`TOOL_TIMEOUT_MS`). Page scripts stuck in a loop are stopped after `OBSCURA_JS_WATCHDOG_MS`. Tool calls are queued. If an agent issues many long waits, later calls wait their turn; the log shows `queued` for each call.

**`The browser connection was lost … all previously open tabs … were reset`**
Obscura crashed and was restarted automatically. The logs show `Obscura exited unexpectedly` with the exit code and signal, plus the last lines Obscura printed (`component: obscura-engine`). Please report reproducible crashes to Obscura.

## Dashboard

**The live view stays on "Waiting for the agent…"**
No tab has been opened yet. The first browser tool call opens one.

**The live view is frozen**
Check that it is not paused and that the connection indicator is green. The server only streams while a tab is open and a dashboard is connected. Frames arrive when the page changes, so a static page shows no new frames.

## Logs

**Logs are too large**
Lower `LOG_FILE_LEVEL` to `info` (tool calls, sessions and HTTP requests only), set `LOG_CDP_EVENTS=false`, or reduce `LOG_FILE_MAX_FILES`.

**I need the raw payloads**
Raise `LOG_MAX_STRING_LENGTH`. Images are always replaced by size and hash. To see passwords, cookie values and credential headers in the logs, set `LOG_REDACT_SECRETS=false`. Don't share such logs.
