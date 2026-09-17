# Using Stealth Browser MCP with LM Studio

This guide connects a local model running in [LM Studio](https://lmstudio.ai) to the browser. There are two ways to use it:

| | What you get | LM Studio setup |
|---|---|---|
| **A. Chat in the LM Studio app** | Ask for web tasks in a normal LM Studio chat. The model calls the browser tools and you approve each call. | Add the server to `mcp.json` once |
| **B. Command-line agent** (`npm run lmstudio:agent`) | A scripted agent loop in your terminal with a readable transcript. The model can see screenshots. Scripts and the E2E checks use this. | None: only the local API server must be running |

Both go through the same MCP endpoint. Every tool call appears in the server logs and on the live dashboard at `http://127.0.0.1:8931/`, so you can watch the model browse.

Tested with LM Studio 0.4.18 on macOS and `qwen/qwen3.8-27b` (MLX 4-bit, vision, tool use, reasoning).

---

## 1. Prerequisites

- **LM Studio 0.3.17 or newer.** MCP support arrived in 0.3.17. The model list API used by the CLI agent needs 0.4.
- **A model trained for tool use.** In LM Studio's model list these models show a hammer icon, and `lms ls` lists them with the `tool use` capability. Qwen3-family models work well. Models with vision also let the CLI agent show them screenshots.
- **A context length of at least 32k tokens.** The tool definitions alone take about 8k tokens with all 41 tools enabled, and each page snapshot adds up to about 3k. LM Studio's default of 4k–8k is far too small.
- **The Stealth Browser MCP server** running in Docker (recommended) or locally with Node 24.

## 2. Start the server

```bash
docker compose up -d
curl -s http://127.0.0.1:8931/healthz      # {"ok":true,...}
```

Open `http://127.0.0.1:8931/` to see the live dashboard. The container publishes the port on `127.0.0.1` only.

Without Docker: `npm ci && npm run obscura:download && npm run dev`.

> Always use `127.0.0.1`, never `localhost`, in LM Studio and in every URL below. On macOS `localhost` resolves to IPv6 `::1` first. LM Studio's own API listens on `127.0.0.1:1234` only.

## 3. Add the server to LM Studio (for option A)

LM Studio only connects to MCP servers on your own machine when they are listed in `~/.lmstudio/mcp.json`. It rejects local URLs passed per request with *"URL resolves to a non-public address"*. Choose one of these methods.

### 3a. The setup script (recommended)

```bash
npm run lmstudio:setup
```

```
Added "stealth-browser" in /Users/you/.lmstudio/mcp.json (backup: mcp.json.bak-20260917-101500).
```

The script adds or updates only its own entry and keeps your other servers. It writes a timestamped backup next to the file before changing it. It creates the file if it does not exist, and edits the real file when `mcp.json` is a symlink. When the entry holds a token, the file is made readable by you only. LM Studio notices the change without a restart.

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | `http://127.0.0.1:8931/mcp` | Server endpoint (use your `HOST_PORT` if you changed it) |
| `--token <token>` | none | Adds `Authorization: Bearer <token>`. Use it when the server has `AUTH_TOKEN` set |
| `--no-token` | | Removes a previously added token |
| `--timeout <ms>` | `180000` | Tool call timeout in **milliseconds**. LM Studio's default is 60 s |
| `--name <name>` | `stealth-browser` | Entry name, in lowercase kebab-case. The plugin id becomes `mcp/<name>` |
| `--config <path>` | `$LMSTUDIO_HOME/mcp.json`, else the LM Studio home named in `~/.lmstudio-home-pointer`, else `~/.lmstudio/mcp.json` | File to edit |
| `--dry-run` | | Print the result without writing it. Tokens and `env` values are shown as `<redacted>` |
| `--remove` | | Remove the entry |
| `--print` | | Print the JSON and an "Add to LM Studio" link, and change nothing |

### 3b. Edit mcp.json by hand

In LM Studio, open the right sidebar's **Program** tab and choose **Install > Edit mcp.json**. Add the entry inside `mcpServers` (see also [`examples/lmstudio-mcp.json`](../examples/lmstudio-mcp.json)):

```json
{
  "mcpServers": {
    "stealth-browser": {
      "url": "http://127.0.0.1:8931/mcp",
      "timeout": 180000
    }
  }
}
```

With `AUTH_TOKEN` set on the server, add `"headers": { "Authorization": "Bearer <token>" }` to the entry.

### 3c. Deeplink

Open this link to add the default configuration through LM Studio's install dialog:

```bash
open "lmstudio://add_mcp?name=stealth-browser&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg5MzEvbWNwIiwidGltZW91dCI6MTgwMDAwfQ%3D%3D"
```

For a different URL or a token, generate the link with `npm run lmstudio:setup -- --print --url ... --token ...`. A link that includes a token contains that token in base64, so do not share it.

## 4. Use it in a chat

1. **Load the model with a large context.** In the model loader, set *Context Length* to 32768 or more. From a terminal:
   ```bash
   ~/.lmstudio/bin/lms load qwen/qwen3.8-27b --context-length 32768
   ```
2. **Enable the integration.** Open a new chat and open the **Integrations** panel (the plug icon next to the message box, or the right sidebar in some versions). Turn on **mcp/stealth-browser**. You can turn individual tools off in the same panel.
3. **Ask for a task.** For example:
   > Open https://quotes.toscrape.com/js/ and tell me who wrote the first three quotes.
4. **Approve tool calls.** LM Studio shows a confirmation dialog with the tool name and its arguments, which you can edit. Choose **Allow once**, or **Always allow** to stop the prompts for that tool. Manage these choices under **App Settings > Tools & Integrations**. To trust every tool of this server, allow the pattern `mcp/stealth-browser:*`.
5. **Watch the dashboard** at `http://127.0.0.1:8931/`. It shows a live view of the page, each tool call with its arguments and result, console output and network requests.

Good prompting habits for browser tasks:
- Give the full URL.
- Say exactly what to return ("the exact text of", "a list of", "the price of").
- For multi-step tasks, list the steps in order ("fill X, check Y, then submit").

## 5. Recommended model settings

| Setting | Recommendation | Why |
|---|---|---|
| Model | Tool-use trained (hammer icon). Qwen3-family models at 14B or larger are reliable | Smaller or untrained models call tools with wrong arguments or write the call as plain text |
| Context length | 32k minimum, 64k for long sessions | Tool definitions (~8k tokens for all 41 tools) plus snapshots add up quickly |
| Temperature | 0.1–0.3 | Browser tasks need precise, repeatable actions |
| Reasoning | Low or medium | Full reasoning is slower and rarely helps with navigation steps |
| Tool set | `TOOLSETS=core` for models under ~14B | 16 tools instead of 41 keeps the prompt short and the choice easy |

To shrink the tool list, set `TOOLSETS` in `.env` and restart with `docker compose up -d`:

```bash
TOOLSETS=core               # navigate, snapshot, click, fill, type, keys, select, check, scroll, waits, screenshot
TOOLSETS=core,content       # adds markdown, links, search, extract, get_text ...
```

LM Studio reads the tool list when a chat first uses the server. Start a new chat after changing `TOOLSETS`.

## 6. What the model can and cannot see

- **Text is what counts.** `browser_snapshot` returns the page text and a list of interactive elements with refs (`e12`). The model uses those refs with `browser_click`, `browser_fill` and similar tools. Most tasks need nothing else.
- **In LM Studio chats the model does not see screenshots.** LM Studio saves image results from MCP tools to the chat folder and shows them to *you*. The model only receives a short placeholder, even when it supports vision. Ask it to use `browser_snapshot`, `browser_markdown` or `browser_get_text` instead.
- **Long results are cut at 50,000 characters** by LM Studio. The server's tools already page and truncate their output well below that.
- **The CLI agent (option B) forwards screenshots as images** to vision models, and drops old images to save context. Pass `--no-vision` to turn this off.
- Obscura v0.2.2 does not paint typed input values or checkbox states in screenshots, even though they are set. `browser_snapshot` and the submitted data are the source of truth.

## 7. The command-line agent

The agent is its own MCP client. It connects to the server over Streamable HTTP and uses LM Studio's OpenAI-compatible API (`/v1/chat/completions` with function tools). It needs no `mcp.json` entry, token or LM Studio setting. Only LM Studio's local server must be running: **Developer > Start Server**, or `~/.lmstudio/bin/lms server start`.

```bash
npm run lmstudio:agent -- "Open https://example.com and tell me the main heading"
# or
node scripts/lmstudio-agent.ts "Go to https://news.ycombinator.com and list the top 3 story titles" --max-steps 15
```

Sample transcript (vision model, all tools):

```
$ node scripts/lmstudio-agent.ts "Open https://example.com, take a screenshot with browser_screenshot, and tell me from the image what color the page background is and whether the text is centered."
Stealth Browser agent | model qwen/qwen3.8-27b | reasoning low | vision on | 41 tools | http://127.0.0.1:8931/mcp
Task: Open https://example.com, take a screenshot with browser_screenshot, and tell me ...

[step 1] +55 ms waiting for the model...
  thinking: The user wants me to open https://example.com, take a screenshot, ... Let me start by navigating to the page.
  model 52.5 s | 8043 prompt + 76 output tokens
  -> browser_navigate {"url":"https://example.com"}
  <- ok 211 ms
     Navigated to https://example.com/ — "Example Domain" (HTTP 200)

[step 2] +52.8 s waiting for the model...
  thinking: Let me take a screenshot to see the page.
  model 5.0 s | 8110 prompt + 42 output tokens
  -> browser_screenshot {"full_page":true}
  <- ok 14 ms | 1 image(s)
     Screenshot of the full page of https://example.com/ — "Example Domain" (png, 17 KB)
     [image image/png attached in the next message]

[step 3] +57.7 s waiting for the model...
  thinking: The screenshot shows the Example Domain page. The background is a light gray/off-white color ...
  model 18.7 s | 8205 prompt + 136 output tokens

Final answer (3 steps, 2 tool calls, 76.5 s)
- Background color: Light gray / off-white (a very pale gray, roughly #f0f0f0).
- Text alignment: ...
```

The first step is the slowest because LM Studio processes the tool definitions once (about 8,000 prompt tokens with all 41 tools). Later steps reuse its prompt cache. With `--toolsets core` the prompt is about 3,300 tokens.

| Option | Default | Meaning |
|---|---|---|
| `--model <id>` | `LMSTUDIO_MODEL`, else the first **loaded** LLM trained for tool use | LM Studio model id. A model that is not loaded is loaded on first use (JIT) |
| `--max-steps <n>` | 25 | Model rounds before the agent gives up |
| `--reasoning <mode>` | `low` | `none`, `low`, `medium`, `high` or `on` (the model's default). Sent as `reasoning_effort` |
| `--tools a,b` | all | Offer only these tools to the model |
| `--toolsets core,...` | all | Offer only tools from these groups (client-side counterpart of `TOOLSETS`). Unknown group names are an error |
| `--no-vision` | vision on if the model supports it | Never send screenshots as images |
| `--json <file>` | | Write the full transcript: messages, reasoning, every tool call with arguments, result and timing, token usage |
| `--quiet` | | Print only the final answer, which suits shell scripts |
| `--temperature`, `--max-tokens`, `--max-result-chars` | 0.2, 8192, 12000 | Sampling, output limit per response (reasoning included), and tool result truncation |
| `--instructions <text>` | | Extra system prompt text |
| `--mcp-url`, `--lmstudio-url` | `MCP_URL` / `LMSTUDIO_URL`, else `http://127.0.0.1:8931/mcp` / `http://127.0.0.1:1234` | Endpoints |

Environment variables: `MCP_URL`, `AUTH_TOKEN` (the server's token), `LMSTUDIO_URL`, `LM_API_TOKEN` (when LM Studio's *Require Authentication* is on), `LMSTUDIO_MODEL`, `NO_COLOR`.

Exit codes: `0` final answer, `1` error, `2` usage error, `3` step limit reached (a best-effort answer is still printed), `130` interrupted.

How the loop behaves:
- MCP tool schemas become OpenAI function tools. The server's own instructions are added to the system prompt.
- Tool results go back as `role: "tool"` messages, truncated to `--max-result-chars`. Tool results older than the last six are shortened to keep the context small. When LM Studio reports the loaded context length, older results are shortened further so the conversation, the tool definitions and `--max-tokens` fit in it; the newest result always stays whole. A warning is printed when the context is too small for the tool list.
- LM Studio rejects images inside tool messages. Screenshots are therefore sent in a following `role: "user"` message, and only the most recent image is kept.
- Invalid tool-call JSON, unknown tool names, empty replies and tool calls written as plain text are reported back to the model so it can correct itself. It gets at most two nudges for empty replies and text tool calls. If it still writes tool calls as text, the run ends with an error (exit code 1) rather than printing that text as the answer.
- Transient LM Studio errors are retried. If the MCP session is lost (idle timeout or server restart), the agent reconnects once.
- The model's reasoning (`reasoning_content`, or `<think>` blocks) streams to the terminal in dim text.

## 8. End-to-end checks with the real model

`scripts/lmstudio-e2e.ts` starts the local fixture website and runs scenarios through the same agent loop. Each scenario is judged by an objective assertion, not by the model's own claims:

| Scenario | Task given to the model | Passes when |
|---|---|---|
| **a** read page | Open the fixture `index.html`, report the exact h1 text and the price of Pear | The answer contains `Hello Fixture` and `$2`, and `browser_navigate` succeeded |
| **b** form | Open `form.html`, fill the email with `e2e@example.com`, check "I agree", submit | The fixture server received `POST /echo` whose body contains `email=e2e%40example.com` and `agree=yes` |
| **c** JS-rendered (with `--online`) | Open `https://quotes.toscrape.com/js/`, report who wrote the first quote | The answer contains `Albert Einstein` |
| **d** activity log | (runs after the others) | `GET /api/state` shows every tool call the agent made, with matching arguments and status, and the log stream has a matching `tool call` record |

```bash
npm run lmstudio:e2e                                  # a, b, d
npm run lmstudio:e2e -- --online                      # a, b, c, d
npm run lmstudio:e2e -- --only a,d --repeat 3         # repeat model scenarios to check reliability
npm run lmstudio:e2e -- --quiet --json e2e-results.json
```

The script finds a server in this order: `MCP_URL` or `--mcp-url`, then `http://127.0.0.1:8931/mcp` if it answers, and otherwise it spawns a local server (this needs `npm run obscura:download`). Before calling the model, it checks that the browser can open the fixture site.

Against the Docker container, the browser must reach the fixture site on your host:

```bash
# .env: ALLOW_PRIVATE_NETWORK=true   (then docker compose up -d)
FIXTURE_HOST=host.docker.internal npm run lmstudio:e2e
```

The script prints a summary table and exits non-zero when any check fails. This is a real run (`--online --repeat 2`, all 41 tools):

```
scenario                       result  steps  tool calls  duration  tools used
-----------------------------  ------  -----  ----------  --------  -----------------------------------------------------
a#1 read page                  PASS    4      3           43.3 s    browser_navigate, browser_snapshot, browser_get_text
a#2 read page                  PASS    3      3           39.1 s    browser_navigate, browser_extract, browser_search
b#1 fill and submit form       PASS    5      4           77.7 s    browser_navigate, browser_snapshot, browser_fill_form
b#2 fill and submit form       PASS    5      4           63.1 s    browser_navigate, browser_snapshot, browser_fill_form
c#1 JS-rendered site (online)  PASS    3      2           38.9 s    browser_navigate, browser_snapshot
c#2 JS-rendered site (online)  PASS    4      3           44.7 s    browser_navigate, browser_extract, browser_snapshot
d server activity feed         PASS    -      19          -         17 log records matched

All 7 checks passed in 306.8 s
```

Timings are for `qwen/qwen3.8-27b` (MLX 4-bit, reasoning `low`) on Apple Silicon. Across four runs, scenario a took 22–55 s, b 38–78 s and c 39–82 s. Each model round takes 4–25 s. The first round of a scenario is the slowest because the tool definitions have to be processed. How many steps a run takes varies, because the model picks different tools, but every run passed. The activity check counts only log records still in the server's in-memory log buffer, so "log records matched" can be lower than the tool call count.

## 9. LM Studio's REST API with MCP (advanced)

LM Studio's native `POST /api/v1/chat` can call `mcp.json` servers itself through `"integrations": ["mcp/stealth-browser"]`. This requires three settings under **Developer > Server Settings**:

1. **Require Authentication** on, with an API token (send `Authorization: Bearer $LM_API_TOKEN`).
2. **Allow calling servers from mcp.json** on. This option requires 1.
3. The token must be allowed to use MCP integrations.

```bash
curl http://127.0.0.1:1234/api/v1/chat \
  -H "Authorization: Bearer $LM_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen3.8-27b",
    "input": "Open https://example.com and tell me the page title.",
    "integrations": [{"type": "plugin", "id": "mcp/stealth-browser", "allowed_tools": ["browser_navigate", "browser_snapshot"]}],
    "context_length": 32768, "reasoning": "low"
  }'
```

Without those settings the API answers `403 Permission denied to use plugin 'mcp/stealth-browser'`. Passing the server as `ephemeral_mcp` with a `server_url` does not work for local servers (`URL resolves to a non-public address`), by design since LM Studio 0.4.15. For automation, the CLI agent (section 7) is simpler and needs none of these settings.

## 10. Troubleshooting

**The integration does not appear, or LM Studio shows an MCP error**
- Check that the server is up: `curl -s http://127.0.0.1:8931/healthz`.
- Check that `mcp.json` is valid JSON with the entry inside `"mcpServers"`: `npm run lmstudio:setup -- --dry-run` fails loudly on invalid JSON.
- Use a lowercase kebab-case name. LM Studio rejects plugin ids like `mcp/Stealth_Browser`.
- Use a `"url"` entry, not `"command"`. Stdio MCP servers have been reported to hang in some LM Studio versions.
- Watch LM Studio's logs while you enable the integration: `~/.lmstudio/bin/lms log stream --source server`. Request logs are also written to `~/.lmstudio/server-logs/`.

**`connection refused` / `fetch failed`**
- Use `http://127.0.0.1:8931/mcp`, not `localhost`.
- Run `docker compose ps` to check that the container is running and publishes `127.0.0.1:8931->8931`. If you changed `HOST_PORT`, update the URL.
- Never put `host.docker.internal` in LM Studio's `mcp.json`. LM Studio runs on the host, where that name does not resolve.

**Tool calls fail after 60 seconds**
The entry is missing `"timeout": 180000`, or the timeout was written in seconds. The unit is milliseconds. Re-run `npm run lmstudio:setup`.

**`401 Unauthorized`**
The server has `AUTH_TOKEN` set. Run `npm run lmstudio:setup -- --token <token>`.

**`403 Invalid Host`**
You reached the server through a hostname that is not allowed. Use `127.0.0.1` or add the name to `ALLOWED_HOSTS`.

**`Navigation … failed: private/internal addresses are blocked`**
The browser refuses to open local addresses by default. Set `ALLOW_PRIVATE_NETWORK=true`. From inside the container, your host is `http://host.docker.internal:<port>`, not `127.0.0.1`.

**The model does not call tools, or writes `<tool_call>` text instead**
- Use a model trained for tool use, and check that the integration is enabled in this chat.
- Increase the context length. When the tool definitions are cut off, models stop calling tools.
- Reduce the tool list with `TOOLSETS=core` and start a new chat.
- The CLI agent detects tool calls written as text and asks the model to retry. If that keeps happening, try another model or `--reasoning medium`.

**`context length exceeded` / the model forgets the task**
Reload the model with a larger context (`lms load <model> --context-length 65536`). Ask for `browser_snapshot` with `max_chars`, or `browser_get_text` on a selector, instead of whole pages. Start a new chat for a new task.

**The model says it cannot see the screenshot**
This is expected in LM Studio chats (section 6). Ask it to read the page with `browser_snapshot`.

**The CLI agent says `No loaded LM Studio model is trained for tool use`**
Load one (`~/.lmstudio/bin/lms load <model> --context-length 32768`) or pass `--model <id>`. `~/.lmstudio/bin/lms ls` lists installed models and `lms ps` lists loaded ones.

**Where to look**
- LM Studio: `~/.lmstudio/bin/lms log stream --source server --json` for API requests. `lms log stream --source model --filter input,output` shows the exact prompt, including the injected tool definitions.
- Stealth Browser MCP: the dashboard's Activity and Logs tabs, `docker compose logs -f`, or `jq -c 'select(.component=="tool")' logs/current.log`. LM Studio's MCP client identifies itself as `lmstudio-mcp-server-session`. The CLI agent appears as `lmstudio-agent` and the E2E script as `lmstudio-e2e`.

**LM Studio and Docker networking**
- LM Studio (host) to the server (container): `http://127.0.0.1:8931/mcp` through the published port.
- A process inside a container calling LM Studio: `http://host.docker.internal:1234`. Docker Desktop forwards it even though LM Studio listens only on `127.0.0.1`. On Linux, LM Studio must listen on a non-loopback interface.
