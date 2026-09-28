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

**A run is `waiting`** (`Run r… is waiting for your answer`). The sub-agent asked the host a question, for example before placing an order. Answer it with `agent_reply` and the `run_id` and `question_id` from the result; `agent_status` without a `run_id` lists every waiting run with its question. Unanswered, the run continues without an answer after `AGENT_REPLY_TIMEOUT_MS` (30 minutes), and `agent_cancel` stops it. To ask your user less, pass on what they already approved: a purchase as `purchase_approval` (the agent still asks, and your agent approves a matching checkout itself), other steps in the TASK. `allow_questions: false` in the call, or `AGENT_MAX_QUESTIONS=0`, turns questions off, but the agent then never orders or pays. See [Questions from sub-agents](AGENTS.md#questions-from-sub-agents).

**A run ends with `success: false` at the checkout, or its steps show `Blocked: "Place your order" looks like the final step of an order or payment`.** The server refuses the final order or payment button of an `agent_run` or `agent_automate` job until the host has answered a `confirm` question the agent asked on that same page (an approval given on the cart page does not count). The agent should ask first, on the checkout page; with questions off it finishes and says the order is ready instead. A `purchase_approval` does not unblock the button either: it tells your agent what it may approve, and the agent still has to ask. Check that questions are on and that your agent answers the question. The log has a warning `blocked the final step of an order or payment` with the button's label. See [Orders and payments](AGENTS.md#orders-and-payments).

**`agent_reply` returns `Question q… is closed; run r… now asks q…`**, `… expired at … without an answer`, `… was already answered`, or `… is not waiting for an answer`. The answer was meant for a question that is no longer open, so it was not delivered. Answer the question the error names, with its id, or collect the result with `agent_wait`.

**The chat model ends its turn while a run waits** (common with small models in LM Studio, and expected when it asks you). The run keeps waiting until `AGENT_REPLY_TIMEOUT_MS`. Tell the model in the chat what to answer, for example *"Answer the waiting question: yes"*, and it calls `agent_reply`.

**`Also waiting for your answer` does not list a waiting run.** It lists only the runs your MCP session started (by client name and version for a client without a session), so not those of another client, of another session of the same client, or of a session you had before a reconnect. `agent_status` without a `run_id` lists every waiting run, and marks the ones someone else started `(started by …: theirs to answer)`. You can still answer a run by its `run_id`.

**The result says a site needs a sign-in.** Sub-agent browsers start signed out, and agents never type a password the TASK did not give them. Sign in once in your own browser, save it with `snapshot_save`, and pass `snapshot` to `agent_run`. See [Snapshots](SNAPSHOTS.md).

**Context errors from the endpoint** (`maximum context length`). The server compacts the transcript and retries. If it keeps happening, `AGENT_CONTEXT_TOKENS` is larger than the model's real context (vLLM `--max-model-len`): lower it, set the model's `contextWindow` in `config/models.json` (it caps the budget), or lower `AGENT_MAX_RESULT_CHARS`.

**A script fails that passed before.** Sites change. `script_get` shows the code; run `agent_automate` again with `script_name` and `overwrite: true` to re-record it. Script errors name the failing `browser.*` call and the line.

## Snapshots

**`SNAPSHOTS_DIR /data/snapshots is not writable`** at startup. The server keeps running, but the snapshot tools fail. The `snapshots` named volume from `compose.yaml` is writable by the server. If you mounted a host folder there instead, give it to uid 1000 and keep it private: `sudo chown -R 1000:1000 <folder> && sudo chmod 700 <folder>`. A folder that others can read is restricted to 0700 at startup, or the log warns when that is not possible.

**`Invalid configuration: SNAPSHOTS_DIR: must not be inside LOG_DIR`** (or `… the same folder as SCRIPTS_DIR`). Snapshots hold sign-in cookies and must not sit next to shareable logs or scripts. Choose another folder, or remove the variable to use the default.

**`cannot decrypt snapshot "…": SNAPSHOTS_KEY is missing or differs from the one used to save it`**. The snapshot was saved with another key, or `SNAPSHOTS_KEY` is no longer set. Put the old key back in `.env` and run `docker compose up -d`. If it is lost, sign in again and save with `snapshot_save {"name": "…", "replace": true}`, or delete the snapshot when your user agrees.

**`This browser has no sign-in cookies for …; snapshot not changed.`** The browser has no unexpired cookies for the snapshot's sites: sign in first. When creating, open a page of the site you signed in to, or pass `domains`.

**`Snapshot "…" is not loaded in this browser`** or **`… changed after this browser loaded it`**. A refresh saves only into the snapshot this browser loaded, at the version it loaded, so it never overwrites a sign-in another browser renewed. Loading or saving another snapshot for an overlapping site, and `browser_clear_cookies`, also unload it (their results say `Snapshot "…" is no longer loaded in this browser`). Load it with `snapshot_load` first, or, if you signed in again by hand to the same account, save with `replace: true`.

**`This browser lost N of the sign-in cookies saved in snapshot "…" (signed out?); snapshot not changed.`** (or, at the end of a sub-agent run, `was not refreshed: the agent's browser lost N saved sign-in cookie(s) (signed out?)`). The browser no longer has sign-in cookies the snapshot holds, usually because the site or a page signed it out, so the refresh would have replaced a working sign-in. If this browser is signed in to the snapshot's account, save with `replace: true`; otherwise load the snapshot again.

**`Snapshot "…" is loaded in this browser and writes its saved site storage into … on every page load`**. You signed in to another account while a snapshot of that site was loaded, so the page's storage still comes from the loaded snapshot. Call `browser_clear_cookies` (it also unloads the snapshots), sign in again, then save.

**A loaded snapshot does not sign the browser in.**
- The cookies expired: `snapshot_list` and the dashboard count expired cookies, and `snapshot_load` reports the ones it skipped. Sign in again and save with `replace: true`.
- The site keeps its sign-in on a domain the snapshot does not cover, such as a separate login domain. Save it again with `replace: true` and `domains` listing every domain involved.
- The site ended the session on its side, or asks again because it sees a new device or address. Snapshots cannot help there.
- The site keeps its sign-in in IndexedDB, which snapshots do not save.
- Another snapshot for the same site, a subdomain or a parent domain was loaded or saved later and replaced its cookies (that result said `Snapshot "…" is no longer loaded in this browser`). Load it again.

**`The snapshot "…" loaded in this browser was lost; load it again with snapshot_load.`** The engine restarted (a page crashed it) and the browser lost its cookies. Load the snapshot again. A sub-agent's browser gets its snapshot back by itself.

**A snapshot is listed as `incomplete`.** Its saved state has no valid metadata, or the other way round, usually after a crash while saving. It cannot be loaded. Delete it with `snapshot_delete` or on the dashboard when your user agrees, and save it again.

**`Snapshot limit (500) reached.`** Ask your user which snapshots they no longer need, and delete those.

**The dashboard's Delete button fails with `403`.** The delete request must come from the dashboard's own origin. Behind a reverse proxy, add the proxy's host name to `ALLOWED_HOSTS` (a name without a port matches the dashboard on any port, such as `https://mcp.example.com:8443`), or set `PUBLIC_URL` to the exact address you open the dashboard at (scheme, host and port). The log line `refused a dashboard snapshot delete` gives the reason.

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
