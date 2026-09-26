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
Run `docker compose logs`. `Invalid configuration:` names the variable that is wrong, or `AGENT_MODELS_FILE:` for a problem in `config/models.json` (see [Models file](#models-file-configmodelsjson)). `Obscura failed to start` with an `exec format error` means the image was built for the wrong CPU architecture. Rebuild on the target machine, or use `docker buildx build --platform linux/amd64,linux/arm64`. Obscura ships only Linux amd64 and arm64 builds.

**`EACCES: permission denied` for `/app/logs` (Linux hosts)**
The server runs as uid 1000 inside the container, and the `./logs` bind mount must be writable by it: `mkdir -p logs && sudo chown -R 1000:1000 logs`. Without it the server still runs, logs to stdout only and says so at startup. Alternatively, replace the bind mount with a named volume in `compose.yaml`. The same applies to `./data` when you persist cookies with `OBSCURA_STORAGE_DIR`: the server logs an error at startup if it cannot write there.

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
Use the bridge: `docker exec -i stealth-web-search node dist/stdio-bridge.js`, or `npx mcp-remote http://127.0.0.1:8931/mcp`. See [`examples/`](../examples).

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

## Sub-agents

**The `agent_*` tools are missing.** They are only offered when a model is configured, in `config/models.json` ([MODELS.md](MODELS.md)) or with `AGENT_LLM_URL`, and only if `TOOLSETS` includes them (the default `all` does; otherwise add `agents,scripts`, e.g. `TOOLSETS=core,content,forms,agents,scripts`). Check the startup line: `docker compose logs | grep '"agents"'`. After changing `.env`, run `docker compose up -d` again; after changing `config/models.json`, run `docker compose restart`. The MCP client may need to reconnect to see the new tools.

**`agent model endpoint not reachable`** at startup, or runs fail with `cannot reach the model endpoint`. The endpoint is called **from inside the container**. Use the LAN IP of the model server, or `http://host.docker.internal:<port>/v1` for a server on your own machine. Docker Desktop (macOS, Windows) reaches a server that listens on 127.0.0.1 through `host.docker.internal`; on Linux the model server must listen on a non-loopback address (LM Studio: **Serve on Local Network**; Ollama: `OLLAMA_HOST=0.0.0.0`; vLLM: `--host 0.0.0.0`). Test it from the container, with the same settings as the server (`config/models.json` or the `AGENT_LLM_*` variables):

```bash
docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping
```

It prints the endpoint and model the server uses, then either the models the endpoint lists or `The endpoint did not answer:` with the reason.

On macOS, programs on the host itself may be blocked from LAN addresses by the Local Network privacy setting (`No route to host`) even though Docker containers can reach them. That affects tools you run on the Mac, not the sub-agents in the container.

**`the model endpoint rejected the API key (HTTP 401)`** means the key is wrong: `AGENT_LLM_API_KEY`, or the provider's `apiKey` in `config/models.json`. **`HTTP 404 … Check AGENT_LLM_URL and AGENT_LLM_MODEL`** means the path or model id is wrong (with a models file: the model's `url` and `id`): `GET /v1/models` lists the ids. **`agent model "…" is not listed by the endpoint`** at startup means the model id (`AGENT_LLM_MODEL`, or `id` in the file) does not match any listed model. `--ping` reports the same, with the ids the endpoint lists.

**The model answers in text instead of calling tools.** The endpoint must support OpenAI tool calling: for vLLM, start it with `--enable-auto-tool-choice --tool-call-parser <parser for your model>`. The agent reminds the model twice, then makes it finish.

**Results say `No final result: the model did not call finish within the budget`** (or `… within the time budget`), or `the agent ran out of steps or time and reported what it had`. Raise `max_steps` in the call (or `AGENT_MAX_STEPS`) and `AGENT_MAX_RUNTIME_MS`, or split the job. Read the run's transcript in `logs/agent-runs/` or its **Details** on the dashboard to see where it got stuck.

**`still running` results.** Normal for long jobs: call `agent_wait` with the `run_id`. Raise `AGENT_WAIT_SECONDS` if your MCP client allows long tool calls (LM Studio's timeout is set to 180 s by `npm run lmstudio:setup`).

**Context errors from the endpoint** (`maximum context length`). The server compacts the transcript and retries. If it keeps happening, `AGENT_CONTEXT_TOKENS` is larger than the model's real context (vLLM `--max-model-len`): lower it, set the model's `contextWindow` in `config/models.json` (it caps the budget), or lower `AGENT_MAX_RESULT_CHARS`.

**A script fails that passed before.** Sites change. `script_get` shows the code; run `agent_automate` again with `script_name` and `overwrite: true` to re-record it. Script errors name the failing `browser.*` call and the line.

## Models file (`config/models.json`)

See [MODELS.md](MODELS.md) for the format and [every error message](MODELS.md#error-messages). To check the file without starting the server:

```bash
docker compose run --rm --no-deps stealth-web-search node dist/check-config.js
```

**The container keeps restarting and the logs show `Invalid configuration:` with `AGENT_MODELS_FILE: … is not valid JSON`**
The file has a syntax error, and the message gives the line and column. Comments and trailing commas are allowed. Look for a missing comma between fields, a missing quote, or a key without quotes. Other messages under `AGENT_MODELS_FILE:` name the field that is wrong, for example `[0].models[0].id` (the first model of the first provider).

**`cannot read /app/config/models.json: EACCES: permission denied`** (Linux)
The server runs as uid 1000 in the container and cannot read the file. Give it to that user (`sudo chown 1000 config/models.json`), or make it readable (`chmod 644 config/models.json`) and keep the key in `.env` with `${NAME}`. See [Docker and Linux notes](MODELS.md#docker-and-linux-notes).

**`AGENT_LLM_MODEL "…" is not in /app/config/models.json`**
`AGENT_LLM_MODEL` is set, often left in `.env` from a setup without the file, and names no model in the file. It must be a model's `id`, `<provider name>/<id>` or display `name`; the message lists the models in the file. Remove the variable to use the first model with tool calling, or set `AGENT_MODELS_FILE=none` to ignore the file and use only the `AGENT_LLM_*` variables.

**`model "…" has "toolCalling": false` or `no model supports tool calling`**
Sub-agents need a model that can call tools. Choose another model with `AGENT_LLM_MODEL`. If the model does support tool calling, set `"toolCalling": true` or remove the field.

**`--ping` fails on the host for a `host.docker.internal` URL**
`host.docker.internal` only resolves inside Docker, so `npm run config:check -- --ping` on the host cannot reach it (the check says so). Run the check in the container: `docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping`.

**Changes to `config/models.json` have no effect**
- The file is read once, at startup. Run `docker compose restart`: `docker compose up -d` alone does not restart the container when only the file changed.
- A variable set in `.env` wins over the matching field: `AGENT_LLM_URL`, `AGENT_LLM_API_KEY`, `AGENT_LLM_TEMPERATURE`, `AGENT_LLM_TOP_P`, `AGENT_LLM_REASONING_EFFORT` and `AGENT_LLM_STREAMING`. The startup log then says `… from the environment take precedence`, and `config:check` shows an `overridden by` line. Remove the variable from `.env`.
- `AGENT_MODELS_FILE` in `.env` points at another file.

**Sub-agents are off although `config/models.json` exists**
The startup line says `disabled (no /app/config/models.json and AGENT_LLM_URL is not set)` (or `disabled (AGENT_MODELS_FILE=none …)` when `.env` turns the file off). The file must be in the `config` folder next to `compose.yaml`, which is mounted at `/app/config`. Check what the container sees with `docker compose exec stealth-web-search ls -l /app/config`. On Linux, the folder must be readable by uid 1000 (`chmod 755 config`). `AGENT_MODELS_FILE=none` in `.env` also turns the file off.

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
