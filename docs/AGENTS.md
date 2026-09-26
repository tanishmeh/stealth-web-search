# Sub-agents

Besides the `browser_*` tools, which let your agent (the **host agent**) drive the browser step by step, the server can run **sub-agents**: the host hands over a whole job and gets back only the result. Sub-agents run inside the server (inside the Docker container, next to Obscura) and talk to any **OpenAI-compatible chat completions endpoint**: vLLM, LM Studio, llama.cpp, Ollama, OpenAI and others.

| Tool | Agent | The host gives | The host gets back |
|---|---|---|---|
| [`agent_run`](TOOLS.md#agent_run) | Agentic | TASK (what to do) and OUTPUT (what to send back) | The OUTPUT |
| [`agent_automate`](TOOLS.md#agent_automate) | Automation | TASK and OUTPUT | A stored, verified script: its name, parameters, how to run it, the verification result, plus the task's OUTPUT |
| [`agent_find`](TOOLS.md#agent_find) | Finder | OBJECTIVE (what to find), optionally OUTPUT | The answer, confidence, conflicts between sources, and the cited links with supporting quotes |

The regular `browser_*` tools stay available: the host can keep driving its own browser while sub-agents work.

## How it works

```text
host agent ──MCP──▶ agent_run / agent_automate / agent_find
                         │
                         ▼
               sub-agent (in the server)  ◀──chat completions──▶  your model endpoint
                         │ tool calls (browser_*, web_search, note, finish, …)
                         ▼
               its own isolated browser (a separate Obscura CDP connection: own tabs, cookies, storage)
```

- **Isolated browser per run.** Obscura keeps pages and cookies per CDP connection, so every run gets a private browser that starts empty and is discarded afterwards. The host's browser and other runs are never touched, and runs can work at the same time (`AGENT_MAX_CONCURRENT`, default 2; more wait in a queue). Sub-agent and script browsers also run on a second Obscura engine process (`OBSCURA_SEPARATE_ENGINE`, on by default), so a page that crashes the engine during a run (Obscura v0.2.2 has such bugs) cannot reset the host's browser; the run itself reconnects and is told its pages were reset. That engine never persists cookies, even with `OBSCURA_STORAGE_DIR`.
- **Same tools, same guards.** Sub-agents use the regular browser tools through the same code path as MCP clients, so URL scheme rules, the SSRF guard (`ALLOW_PRIVATE_NETWORK`), timeouts and secret redaction all apply. Sub-agents cannot start sub-agents.
- **Everything is logged and visible.** Each model request and response, and every tool call, is logged with the run id. The dashboard lists runs in the **Agents** tab (live step, current action, the model's reasoning as it streams, the result), and its browser picker switches the live view to any sub-agent's browser. A JSON transcript of every run is written to `logs/agent-runs/`.
- **Context budget.** Each run keeps its transcript within `AGENT_CONTEXT_TOKENS` (64k by default). Tool results are capped, older results are shortened first, and if needed the oldest steps are dropped. Facts the agent saved with `note` are kept. The characters-per-token ratio is calibrated from the token counts the endpoint reports.
- **Budgets.** `max_steps` (per call, default `AGENT_MAX_STEPS`=40, 50 for automation) and `AGENT_MAX_RUNTIME_MS` (15 min). When a budget runs out, the agent is made to call `finish` with what it has, and the result says so (`forced: true`). If even that last turn does not finish in time, the result contains the notes the agent saved (and, for the finder, the sources it had cited).

## Setup

The sub-agents need an OpenAI-compatible chat completions model. Describe it in `config/models.json` (recommended), or with `AGENT_LLM_*` variables in `.env`.

### With `config/models.json`

Copy the example, edit it, and start or restart the server:

```bash
cp config/models.example.json config/models.json
docker compose up -d --build     # first start
docker compose restart           # after editing config/models.json
```

```json
[
  {
    "name": "Local vLLM",
    "vendor": "customendpoint",
    "apiKey": "your-api-key",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "qwen3.8-27b",
        "name": "Qwen3.8 27B (vLLM)",
        "url": "http://192.168.1.50:8000/v1/chat/completions",
        "toolCalling": true,
        "streaming": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768,
        "supportsReasoningEffort": ["low", "medium", "xhigh"],
        "reasoningEffortFormat": "chat-completions",
        "modelOptions": { "temperature": 0.4, "top_p": 0.95 }
      }
    ],
    "settings": { "qwen3.8-27b": { "reasoningEffort": "medium" } }
  }
]
```

This is the provider format editors use for "custom endpoint" models, so you can paste an existing list. The file can list several providers and models: the first model with tool calling is used, or the one `AGENT_LLM_MODEL` names. `contextWindow` and `maxOutputTokens` cap the agent's budget (`AGENT_CONTEXT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`), and `modelOptions` holds sampling and extra request fields. Every field, the rules, and examples for vLLM, LM Studio, Ollama, llama.cpp and OpenAI are in [MODELS.md](MODELS.md).

Check it, including whether the endpoint answers:

```bash
docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping
```

### With environment variables

Without a models file, set the endpoint in `.env` next to `compose.yaml` and run `docker compose up -d`:

```ini
AGENT_LLM_URL=http://192.168.1.50:8000/v1/chat/completions   # base URL (…/v1) or the full endpoint
AGENT_LLM_API_KEY=your-api-key
AGENT_LLM_MODEL=qwen3.8-27b                                   # default: the first model the endpoint lists
AGENT_LLM_TEMPERATURE=0.4
AGENT_LLM_TOP_P=0.95
AGENT_LLM_REASONING_EFFORT=medium                             # sent as reasoning_effort; "none" leaves it out
AGENT_CONTEXT_TOKENS=65536
AGENT_MAX_OUTPUT_TOKENS=8192
```

With a models file, the URL, key, sampling, reasoning effort and streaming variables override the matching fields of the file when they are set, `AGENT_LLM_MODEL` selects a model in the file, and the file's `contextWindow` and `maxOutputTokens` cap the two budget variables ([details](MODELS.md#environment-overrides)). `AGENT_MODELS_FILE=none` ignores the file. All settings are listed in [CONFIGURATION.md](CONFIGURATION.md#sub-agents).

### What the server checks

At startup the server logs where the model comes from (the `agents` field of the `starting` line: the file and provider, or `AGENT_LLM_* environment variables`). It then asks the endpoint for its models and logs either `agent model endpoint reachable` (with the models it lists) or a warning. The **Agents** tab of the dashboard shows the same in its footer (`Config models.json (Local vLLM)`).

The `agent_*` tools are only offered when a models file or `AGENT_LLM_URL` configures a model. The `script_*` tools are always available. Both follow `TOOLSETS` like every other group (the default `all` includes them; with a custom list, add `agents,scripts`).

The **model** must support tool calling (OpenAI `tools` / `tool_calls`); vLLM needs `--enable-auto-tool-choice` and a tool-call parser for the model. Reasoning models work: streamed `reasoning` / `reasoning_content` is shown on the dashboard and kept in transcripts, but never sent back to the model. Other request fields (`top_k`, `repetition_penalty`, …) go in `modelOptions` in the models file, or in `AGENT_LLM_EXTRA_BODY` as JSON. For Qwen-style chat templates, `AGENT_LLM_THINKING=false` turns thinking off.

### Where is the model?

The endpoint is reached from inside the container:

| Model server | `url` in `config/models.json`, or `AGENT_LLM_URL` |
|---|---|
| Another machine on your network | `http://<its-ip>:<port>/v1` |
| Your own machine (LM Studio, Ollama, vLLM…) | `http://host.docker.internal:<port>/v1` (LM Studio: `http://host.docker.internal:1234/v1`) |
| A hosted API | `https://api.example.com/v1` plus the key (`apiKey`, or `AGENT_LLM_API_KEY`) |

On Linux, `host.docker.internal` reaches your machine only on addresses the model server listens on beyond loopback: LM Studio **Serve on Local Network**, `OLLAMA_HOST=0.0.0.0`, vLLM `--host 0.0.0.0`. Docker Desktop (macOS, Windows) also reaches servers on 127.0.0.1.

**OpenAI and other hosted APIs** are stricter about request fields. For OpenAI non-reasoning models (gpt-4o, gpt-4.1), leave `reasoning_effort` out: `"reasoningEffortFormat": "none"` in the models file, or `AGENT_LLM_REASONING_EFFORT=none`. For reasoning models (o-series, gpt-5), set `AGENT_LLM_MAX_TOKENS_FIELD=max_completion_tokens` in `.env`, and leave the sampling fields out: `"temperature": null` and `"top_p": null` in `modelOptions`, or `AGENT_LLM_TEMPERATURE=none` and `AGENT_LLM_TOP_P=none` (they only accept the defaults). Without a models file, also set `AGENT_LLM_MODEL`. See the [OpenAI example](MODELS.md#openai).

## Waiting for results

Runs usually take from 10 seconds to a few minutes. `agent_run`, `agent_automate` and `agent_find` wait up to `wait_seconds` (default `AGENT_WAIT_SECONDS`=170, which fits under LM Studio's 180 s tool timeout that `npm run lmstudio:setup` configures). If the run is not done by then, the tool returns right away with:

```text
Agent run r3f9a1c2 (finder) is still running: step 6 of 40, 1 min 50 s so far; now: browser_navigate https://…
Call agent_wait with {"run_id": "r3f9a1c2"} to wait for the result (agent_status to check progress, agent_cancel to stop it).
```

The run keeps going; the host collects the result with `agent_wait`. While a tool waits, the server sends MCP **progress notifications** (`step 6: browser_navigate …`) if the client asked for them, so clients that reset their timeout on progress wait patiently. `agent_status` without a `run_id` lists recent runs.

Results come as readable text plus `structuredContent` (JSON) with the same data: `run_id`, `status` (`completed`, `failed` or `cancelled`), `success`, `steps`, `duration_ms`, the kind-specific fields below, and `transcript` (path of the JSON transcript in the container).

## Agentic mode: `agent_run`

```json
{
  "task": "On https://books.toscrape.com, open the Poetry category and read the first 3 books listed there.",
  "output": "A JSON array of 3 objects {title, price}: the full title and the price exactly as shown.",
  "output_format": "json"
}
```

```text
Agent run r7669894 (agentic) completed — success. 6 steps, 19.3 s.

OUTPUT:
[{"title": "A Light in the Attic", "price": "£51.77"}, {"title": "The Black Maria", "price": "£52.15"}, {"title": "Shakespeare's Sonnets", "price": "£20.66"}]
```

The agent has the core, content, forms and tabs browser tools, `browser_evaluate`, `web_search`, `note`, and `finish(output, success, notes)`. With `output_format: "json"`, `finish` only accepts valid JSON, and `structuredContent.output` is the parsed value. If the task cannot be done (login required, site down), the agent reports `success: false` with notes on what it tried.

## Automation agent: `agent_automate`

The automation agent works in three phases:

1. **Explore.** It does the task once and works out the pages, URLs and stable CSS selectors that work.
2. **Script.** It writes a JavaScript script that repeats the job for any parameter values, and saves it (`script_save`). The syntax is checked on save.
3. **Verify.** It runs the script in a **fresh, empty browser** (`script_test`) with the example parameters, compares the output with what it saw while exploring, and fixes and re-tests until it is right. If the agent never tested the final version, the server runs it once before reporting.

```json
{
  "task": "On https://quotes.toscrape.com, get the first 3 quotes for the tag \"love\" (tag pages are at /tag/<tag>/): the quote text and its author.",
  "output": "A JSON array of {text, author} objects in page order.",
  "parameters": "the tag, and how many quotes to return",
  "script_name": "quotes-by-tag"
}
```

```text
Agent run rc425b07 (automation) completed — success. 5 steps, 34.6 s.

Script "quotes-by-tag" (version 1): Fetches quotes for a given tag from quotes.toscrape.com and returns the first N quotes with their authors.
Verification: PASSED — version 1 ran successfully in a fresh browser in 0.4 s with {"tag":"love","count":3}

Run it (no model needed): script_run {"name":"quotes-by-tag","params":{"tag":"love","count":3}}

Parameters:
- tag (string, required): The tag to look up, e.g. "love" (used in the URL /tag/<tag>/) Example: "love"
- count (integer, optional, default 3): How many quotes to return (first N in page order) Example: 3

Returns: A JSON array of {text, author} objects in page order.
Example output (from verification): [ … ]

Usage notes: …

TASK OUTPUT (from the exploratory run):
[ … ]
```

`structuredContent.script` has the same information in machine-readable form, including `run_with: {"tool": "script_run", "arguments": {…}}`. Later, anyone can replay the job **without a model**, in well under a second for simple pages:

```json
{ "name": "quotes-by-tag", "params": { "tag": "life", "count": 2 } }
```

`script_run` validates the parameters (types, required, defaults; unknown names are rejected), runs the script in a fresh isolated browser, and returns its output (JSON), its log and the time it took.

If `script_name` is taken and `overwrite` is not `true`, the agent picks a free name (`quotes-by-tag-2`).

### Scripts

Scripts are stored in `SCRIPTS_DIR` (`/data/scripts` in the container, on the `scripts` Docker volume) as two plain files: `<name>.js` (the code) and `<name>.json` (description, parameters, output description, version, verification result, run count). Manage them with `script_list`, `script_get` (includes the source), `script_run` and `script_delete`, or look at them directly:

```bash
docker compose exec stealth-web-search ls /data/scripts
```

```bash
docker compose cp stealth-web-search:/data/scripts ./my-scripts
```

A script defines `async function run(params)` and returns JSON-serializable data. It uses a `browser` object whose methods map onto the browser tools (so every call is logged and shown on the dashboard):

```js
async function run(params) {
  await browser.goto('https://quotes.toscrape.com/tag/' + encodeURIComponent(params.tag) + '/');
  await browser.waitFor('.quote .text');
  const data = await browser.extract({ 'texts[]': '.quote .text', 'authors[]': '.quote .author' });
  log('found', data.texts.length, 'quotes');
  return data.texts.slice(0, params.count).map((t, i) => ({ text: t.replace(/^[“"]|[”"]$/g, ''), author: data.authors[i] }));
}
```

| Method | Returns |
|---|---|
| `goto(url, {waitUntil?})` | `{url, title, status}` |
| `back()`, `forward()`, `reload()` | `{url, title}` |
| `url()`, `title()` | string |
| `click(selector)`, `clickText(text, {exact?, index?})` | message; `clickText` clicks a link/button by its visible text |
| `fill(selector, value)`, `type(selector, text, {submit?})`, `press(key, selector?)` | message |
| `select(selector, valueOrValues)`, `check(selector, checked = true)`, `scroll(direction \| selector, amountPx?)` | message |
| `waitFor(selector, {state?, timeout?})`, `waitForText(text, {gone?, timeout?})` | `true` (throws on timeout) |
| `wait(seconds)`, `sleep(ms)` | |
| `text(selector?)`, `markdown({selector?})`, `snapshot()` | string |
| `links({filter?, internalOnly?, limit?})` | `[{text, href}]` |
| `extract(schema)` | object, like [`browser_extract`](TOOLS.md#browser_extract) (`"items[]"` for all matches, `@attr` for attributes) |
| `evaluate(codeOrFunction, ...args)` | the value, computed in the page |
| `count(selector)`, `exists(selector)`, `attr(selector, name)` | number, boolean, string or `null` |
| `log(...values)` (also `console.log`) | recorded in the run's log |

**The sandbox.** Scripts run in [QuickJS](https://github.com/justjake/quickjs-emscripten) compiled to WebAssembly: a separate JavaScript engine with no Node.js APIs. There is no `require`, `process`, file system, network (`fetch`) or timers. The only way out is the `browser` object, which goes through the browser tools and their URL/SSRF guards. Each run gets a fresh engine with a memory limit (`SCRIPT_MEMORY_MB`, 64), a time limit (`SCRIPT_TIMEOUT_MS`, 5 min, which also stops endless loops) and a limit of 5000 browser calls. Page JavaScript run by `evaluate` runs in the (isolated) page, as with `browser_evaluate`.

## Finder agent: `agent_find`

```json
{ "objective": "What is the default TCP port that a PostgreSQL server listens on?", "min_sources": 2 }
```

```text
Agent run r795fa66 (finder) completed — success. 10 steps, 53.5 s.

ANSWER:
The default TCP port that a PostgreSQL server listens on is 5432. …

Confidence: high

SOURCES:
[1] PostgreSQL: Documentation: 18: 19.3. Connections and Authentication — https://www.postgresql.org/docs/current/runtime-config-connection.html
    "port (integer) # The TCP port the server listens on; 5432 by default."
[2] Default PostgreSQL Port 5432: Configure, Verify, and Change Your Postgres Port — https://www.dbvis.com/thetable/default-postgresql-port-5432-…
    "For example the PostgreSQL default port is 5432."

Notes: Confirmed on two independent sites: official PostgreSQL documentation (postgresql.org) and dbvis.com. No conflicts found.
```

How the finder backs its answer:

- **`web_search`** opens a search results page in its browser (DuckDuckGo, with Bing as fallback; `AGENT_SEARCH_ENGINE`) and lists titles, URLs and snippets. It is told that snippets are not evidence and that it must open and read the pages.
- **`cite_source(url, quote)`** is accepted only for pages the agent actually opened in this run. The quote is checked against the text it read from that page. Sources whose quote was not found are marked `(quote not verified on the page)` in the result.
- **`finish`** is refused until sources on `min_sources` different websites (default 2) have been cited. The agent can set `insufficient_sources` with an explanation; the confidence is then reported as `low`.
- Conflicts between sources are reported in `conflicts`.

`structuredContent` has `answer`, `confidence`, `sources: [{n, title, url, quotes: [{text, verified}]}]`, `conflicts` and `notes`.

## Watching sub-agents

Open the dashboard (`http://127.0.0.1:8931/`):

- The **Agents** tab lists runs with their kind, status, current step and action, the model's reasoning as it streams, and the result. **Details** shows the task, every step (reasoning, tool calls and results), cited sources, notes and the transcript path. The tab also lists stored scripts.
- **Watch** (or the browser picker in the live view toolbar) switches the live view, tabs, console and network panes to that run's private browser. After a run ends, its last frame stays visible.
- Activity entries made by sub-agents carry the run id (`agent:finder r795fa66`), and script calls are labelled `script:<name>`.

Logs: component `agent` (run lifecycle, one line per run with steps, tokens and outcome), `agent-llm` (every model request and response: timing, token usage, tool calls, finish reason), `tool` (every tool call, with `agentRunId` and `browserId`), and `script` (script runs and their `log()` lines). See [LOGGING.md](LOGGING.md).

## Testing

- `npm run test:integration` includes `test/integration/agents.test.ts`. It uses a scripted fake OpenAI-compatible model that streams like vLLM, so it covers all three agents, scripts, cancellation, progress and errors deterministically, without a GPU.
- `npm run agents:e2e` runs live scenarios against a running server with your real model (`MCP_URL`, default `http://127.0.0.1:8931/mcp`). It uses the server's shared browser for its ground truth (it navigates the active tab), needs the `core`, `content`, `tabs`, `agents` and `scripts` tools, and stores a script named `e2e-quotes-by-tag`. It checks the results against ground truth that it reads itself: books from books.toscrape.com, a quotes script replayed with other parameters, finder answers confirmed on two websites, and two agents running at the same time. It also checks that the host's browser was not touched. Use `--only run,automate,find,parallel`, `--repeat N` and `--json results.json`.

## Limits and tips

- Sub-agents inherit Obscura's limits ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)). They see pages as text (no vision), so heavily visual sites are hard for them.
- Give concrete TASKs: the site, what counts as done, and the exact OUTPUT shape. For `agent_automate`, include example values: they become the parameters' examples and the verification input.
- Small models do better with smaller jobs. Split big jobs into several `agent_run` calls; each can run in parallel with the others.
- Obscura v0.2.2 quirk: a page that declares a global variable with the same name as an element id (`var q` next to `id="q"`) sees the element instead of its variable. This rarely matters, but it can break a site's own search script.
- Task texts, the agent's notes and its transcript are logged as they are. Values the agent types into password-like fields are masked in logs (`LOG_REDACT_SECRETS`), but free text is not, so do not put secrets into a TASK. If you must, set `AGENT_TRANSCRIPTS=false`, `LOG_FILE_LEVEL=warn` and `LOG_LEVEL=warn`; the dashboard still shows the task while the server runs.
- Sub-agents browse the public web. Sites behind a login need cookies, and sub-agent browsers start empty: run such jobs on the host browser (a login inside a TASK puts the credentials in the logs, see above).
