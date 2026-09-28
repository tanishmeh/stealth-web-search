# Using Stealth Web Search with LM Studio

This guide connects Stealth Web Search to models running in [LM Studio](https://lmstudio.ai). LM Studio can play two roles, and you can use either one or both, even with the same model.

1. **LM Studio uses the tools (LM Studio is the MCP host).** You chat in the LM Studio app and the model calls the server's tools: it browses step by step with the `browser_*` tools or, when a sub-agent model is configured, hands whole jobs to sub-agents with the `agent_*` tools. You approve each call. LM Studio finds the server through one entry in its `mcp.json`. Set it up in [section 3](#3-add-the-server-to-lm-studio) with one click on **[Add to LM Studio](https://lmstudio.ai/install-mcp?name=stealth-web-search&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg5MzEvbWNwIiwidGltZW91dCI6MTgwMDAwfQ%3D%3D)**, or with `npm run lmstudio:setup`.
2. **LM Studio runs the sub-agents' model.** The sub-agents (`agent_run`, `agent_automate`, `agent_find`) run inside the container and send their model requests to LM Studio's local server. You configure this in `config/models.json` with the `LM Studio` provider from [`config/models.example.json`](../config/models.example.json). See [section 9b](#9b-lm-studio-as-the-model-for-sub-agents).

| | 1. LM Studio uses the tools | 2. LM Studio runs the sub-agents' model |
|---|---|---|
| Direction | LM Studio calls the server at `http://127.0.0.1:8931/mcp` | The server, in Docker, calls LM Studio at `http://host.docker.internal:1234/v1/chat/completions` |
| Configured in | LM Studio's `mcp.json` (`~/.lmstudio/mcp.json`) | `config/models.json` in this repository, or the `AGENT_LLM_*` variables in `.env` |
| Set up with | The Add to LM Studio link, `npm run lmstudio:setup`, or by hand | `cp config/models.example.json config/models.json`, then select the LM Studio model |
| LM Studio needs | Version 0.3.18 or newer and a model trained for tool use | Its local server running (**Developer > Start Server**) and a model trained for tool use |
| Sections | [3](#3-add-the-server-to-lm-studio) to [6](#6-what-the-model-can-and-cannot-see) | [9b](#9b-lm-studio-as-the-model-for-sub-agents) |

For integration 1 there is also a **command-line agent** (`npm run lmstudio:agent`, [section 7](#7-the-command-line-agent)). It runs a scripted agent loop in your terminal with a readable transcript, talks to LM Studio's API directly and needs no `mcp.json` entry. A vision model can see screenshots. Scripts and the end-to-end checks ([section 8](#8-end-to-end-checks-with-the-real-model)) use it.

Every tool call appears in the server logs and on the live dashboard at `http://127.0.0.1:8931/`, so you can watch the model browse.

Tested with LM Studio 0.4.18 on macOS and `qwen/qwen3.8-27b` (MLX 4-bit, vision, tool use, reasoning).

---

## 1. Prerequisites

- **LM Studio 0.3.18 or newer.** MCP support arrived in 0.3.17, but the per-server `timeout` in `mcp.json`, which this setup needs for tool calls longer than 60 s, arrived in 0.3.18. The model list API used by the CLI agent needs 0.4.
- **A model trained for tool use.** In LM Studio's model list these models show a hammer icon, and `lms ls` lists them with the `tool use` capability. Qwen3-family models work well. Models with vision also let the CLI agent show them screenshots.
- **A context length of at least 32k tokens.** The tool definitions alone take about 9.5k tokens for the 50 tools the server offers by default (41 `browser_*`, 4 `script_*` and 5 `snapshot_*` tools). With a sub-agent model configured, the 7 `agent_*` tools are added (57 tools, about 12k tokens). Each page snapshot adds up to about 3k. LM Studio's default of 4k–8k is far too small.
- **The Stealth Web Search server** running in Docker (recommended) or locally with Node 24.
- **LM Studio's local server** (**Developer > Start Server**, or `~/.lmstudio/bin/lms server start`) for the CLI agent, the end-to-end checks and integration 2. Chats in the app do not need it.
- **Python 3.10 or newer, or [uv](https://docs.astral.sh/uv/getting-started/installation/)**, for the CLI agent and the end-to-end checks ([section 7](#7-the-command-line-agent)). The server and the chat integration do not need Python.

## 2. Start the server

```bash
docker compose up -d
curl -s http://127.0.0.1:8931/healthz      # {"ok":true,...}
```

Open `http://127.0.0.1:8931/` to see the live dashboard. The container publishes the port on `127.0.0.1` only.

Without Docker: `npm ci && npm run obscura:download && npm run dev`.

> Always use `127.0.0.1`, never `localhost`, in LM Studio and in every URL below. On macOS `localhost` resolves to IPv6 `::1` first. LM Studio's own API listens on `127.0.0.1:1234` only.

## 3. Add the server to LM Studio

This sets up integration 1. LM Studio only connects to MCP servers on your own machine when they are listed in `~/.lmstudio/mcp.json`. It rejects local URLs passed per request with *"URL resolves to a non-public address"*. Choose one of these methods. They all add the same entry, named `stealth-web-search`, which LM Studio shows as the integration `mcp/stealth-web-search`.

### 3a. One click: Add to LM Studio

With the server on the default address and no `AUTH_TOKEN`, open this link:

**[Add to LM Studio](https://lmstudio.ai/install-mcp?name=stealth-web-search&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg5MzEvbWNwIiwidGltZW91dCI6MTgwMDAwfQ%3D%3D)**

It opens a page on lmstudio.ai, which launches LM Studio's install dialog for `stealth-web-search`. Confirm the install in LM Studio. The link's `config` parameter is this entry, base64-encoded:

```json
{"url":"http://127.0.0.1:8931/mcp","timeout":180000}
```

The same install dialog opens from the `lmstudio://` deeplink, without the detour through the website:

```bash
open "lmstudio://add_mcp?name=stealth-web-search&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg5MzEvbWNwIiwidGltZW91dCI6MTgwMDAwfQ%3D%3D"
```

`open` is the macOS command. On other systems, paste the `lmstudio://` link into your browser's address bar.

For a different URL or a token, generate both links with `npm run lmstudio:setup -- --print --url ... --token ...`. A link that includes a token contains that token in base64, so do not share it.

### 3b. The setup script

Use the script when you changed `HOST_PORT`, set `AUTH_TOKEN`, or want to script the setup. It is `scripts/setup_lmstudio.py`, a standard-library Python script: it needs Python 3.9 or newer (the `python3` of a recent Linux distribution, or of macOS with the Xcode Command Line Tools) and no `npm ci`.

```bash
npm run lmstudio:setup              # or, without npm: python3 scripts/setup_lmstudio.py
```

```text
Added "stealth-web-search" in /Users/you/.lmstudio/mcp.json (backup: mcp.json.bak-20260917-101500).

LM Studio reloads mcp.json automatically. In a chat, open the Integrations panel and enable mcp/stealth-web-search.
Make sure the server is running: curl http://127.0.0.1:8931/healthz
```

The script adds or updates only its own entry and keeps your other servers. It writes a timestamped backup next to the file before changing it. It creates the file if it does not exist, and edits the real file when `mcp.json` is a symlink. When the entry holds a token, the file is made readable by you only. LM Studio notices the change without a restart.

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | `http://127.0.0.1:8931/mcp` | Server endpoint (use your `HOST_PORT` if you changed it). The script warns about `localhost` and `host.docker.internal` URLs |
| `--token <token>` | none | Adds `Authorization: Bearer <token>`. Use it when the server has `AUTH_TOKEN` set |
| `--no-token` | | Removes a previously added token. Cannot be combined with `--token` |
| `--timeout <ms>` | `180000` | Tool call timeout in **milliseconds**. LM Studio's default is 60 s. Stored scripts (`script_run`) can run up to `SCRIPT_TIMEOUT_MS` (5 min by default): if you use long ones, set `--timeout 330000` or lower `SCRIPT_TIMEOUT_MS` below 180 s |
| `--name <name>` | `stealth-web-search` | Entry name, in lowercase kebab-case. The plugin id becomes `mcp/<name>` |
| `--config <path>` | `mcp.json` in the LM Studio home named in `~/.lmstudio-home-pointer`, else `~/.lmstudio/mcp.json` | File to edit |
| `--dry-run` | | Print the result without writing it. Tokens and `env` values are shown as `<redacted>` |
| `--remove` | | Remove the entry |
| `--print` | | Print the `mcp.json` entry, the `lmstudio://` deeplink and the lmstudio.ai install link, and change nothing. Cannot be combined with `--remove` |
| `-h`, `--help` | | Show the usage text |

The script exits with `2` on invalid options and `1` when `mcp.json` is not valid JSON; it changes nothing in either case. An existing entry that uses `command` (a stdio server) is replaced by a `url` entry.

### 3c. Edit mcp.json by hand

In LM Studio, open the right sidebar's **Program** tab and choose **Install > Edit mcp.json**. Add the entry inside `mcpServers` (see also [`examples/lmstudio-mcp.json`](../examples/lmstudio-mcp.json)):

```json
{
  "mcpServers": {
    "stealth-web-search": {
      "url": "http://127.0.0.1:8931/mcp",
      "timeout": 180000
    }
  }
}
```

With `AUTH_TOKEN` set on the server, add `"headers": { "Authorization": "Bearer <token>" }` to the entry.

## 4. Use it in a chat

1. **Load the model with a large context.** In the model loader, set *Context Length* to 32768 or more. From a terminal:
   ```bash
   ~/.lmstudio/bin/lms load qwen/qwen3.8-27b --context-length 32768
   ```
2. **Enable the integration.** Open a new chat and open the **Integrations** panel (the plug icon next to the message box, or the right sidebar in some versions). Turn on **mcp/stealth-web-search**. You can turn individual tools off in the same panel.
3. **Ask for a task.** For example:
   > Open https://quotes.toscrape.com/js/ and tell me who wrote the first three quotes.
4. **Approve tool calls.** LM Studio shows a confirmation dialog with the tool name and its arguments, which you can edit. Choose **Allow once**, or **Always allow** to stop the prompts for that tool. Manage these choices under **App Settings > Tools & Integrations**. To trust every tool of this server, allow the pattern `mcp/stealth-web-search:*`.
5. **Watch the dashboard** at `http://127.0.0.1:8931/`. It shows a live view of the page, each tool call with its arguments and result, console output and network requests.

Good prompting habits for browser tasks:
- Give the full URL.
- Say exactly what to return ("the exact text of", "a list of", "the price of").
- For multi-step tasks, list the steps in order ("fill X, check Y, then submit").

When a sub-agent model is configured ([section 9b](#9b-lm-studio-as-the-model-for-sub-agents)), the chat can also hand over a whole job with `agent_run`, `agent_automate` or `agent_find`, and gets back only the result. See [AGENTS.md](AGENTS.md).

## 5. Recommended model settings

| Setting | Recommendation | Why |
|---|---|---|
| Model | Tool-use trained (hammer icon). Qwen3-family models at 14B or larger are reliable | Smaller or untrained models call tools with wrong arguments or write the call as plain text |
| Context length | 32k minimum, 64k for long sessions | Tool definitions (~9.5k tokens for the default 50 tools) plus page snapshots add up quickly |
| Temperature | 0.1–0.3 | Browser tasks need precise, repeatable actions |
| Reasoning | Low or medium | Full reasoning is slower and rarely helps with navigation steps |
| Tool set | `TOOLSETS=core` for models under ~14B | 16 tools instead of 50 (57 with sub-agents) keeps the prompt short and the choice easy |

To shrink the tool list, set `TOOLSETS` in `.env` and restart with `docker compose up -d`:

```ini
TOOLSETS=core               # navigate, back, forward, reload, snapshot, click, fill, type, keys, select, check, scroll, waits, screenshot
TOOLSETS=core,content       # adds markdown, links, search, extract, get_text ...
TOOLSETS=core,agents        # core plus the 7 agent_* tools (needs a sub-agent model, section 9b)
```

The groups are `core` (16 tools), `content` (8), `forms` (2), `tabs` (5), `state` (5), `debug` (3), `capture` (2), `agents` (7), `scripts` (4) and `snapshots` (5). A custom list leaves out every group it does not name, including `agents`, `scripts` and `snapshots`. Sub-agents use their own tools whatever `TOOLSETS` says, except `save_sign_in`, which they get only when `TOOLSETS` includes `snapshots` (or `all`).

LM Studio reads the tool list when a chat first uses the server. Start a new chat after changing `TOOLSETS`.

## 6. What the model can and cannot see

- **Text is what counts.** `browser_snapshot` returns the page text and a list of interactive elements with refs (`e12`). The model uses those refs with `browser_click`, `browser_fill` and similar tools. Most tasks need nothing else.
- **In LM Studio chats the model does not see screenshots.** LM Studio saves image results from MCP tools to the chat folder and shows them to *you*. The model only receives a short placeholder, even when it supports vision. Ask it to use `browser_snapshot`, `browser_markdown` or `browser_get_text` instead.
- **Long results are cut at 50,000 characters** by LM Studio. The server's tools already page and truncate their output well below that.
- **The CLI agent forwards screenshots as images** to vision models, and drops old images to save context. Pass `--no-vision` to turn this off.
- **Sub-agents read pages as text only**, whatever the model supports.
- Obscura v0.2.2 does not paint typed input values or checkbox states in screenshots, even though they are set. `browser_snapshot` and the submitted data are the source of truth.

## 7. The command-line agent

The agent is its own MCP client. It connects to the server over Streamable HTTP and uses LM Studio's OpenAI-compatible API (`/v1/chat/completions` with function tools). It needs no `mcp.json` entry, token or LM Studio setting. Only LM Studio's local server must be running: **Developer > Start Server**, or `~/.lmstudio/bin/lms server start`.

It is a Python command, `sws-lmstudio-agent`, from the [`python/`](../python/README.md) package (Python 3.10 or newer). `npm run lmstudio:agent` runs it with [uv](https://docs.astral.sh/uv/getting-started/installation/) when uv is installed, and otherwise from `python/.venv`, which `npm run py:setup` creates once. Arguments after `--` reach the agent unchanged.

```bash
npm run lmstudio:agent -- "Open https://example.com and tell me the main heading"
# or, with uv, straight from the package
uv run --project python sws-lmstudio-agent "Go to https://news.ycombinator.com and list the top 3 story titles" --max-steps 15
```

The agent does not need the rest of the repository: `uvx --from ./python sws-lmstudio-agent "..."` (or `pip install ./python`) installs it on its own, for use against a server that runs elsewhere.

Sample transcript (vision model, all tools):

```text
$ npm run lmstudio:agent -- "Open https://example.com, take a screenshot with browser_screenshot, and tell me from the image what color the page background is and whether the text is centered."
Stealth Web Search agent | model qwen/qwen3.8-27b | reasoning low | vision on | 41 tools | http://127.0.0.1:8931/mcp
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

The first step is the slowest because LM Studio processes the tool definitions once (about 8,000 prompt tokens with all 41 browser tools). Later steps reuse its prompt cache. With `--toolsets core` the prompt is about 3,300 tokens. The sample was recorded with the 41 `browser_*` tools. The current default list has 50 tools (57 with sub-agents), so expect a somewhat larger first prompt.

| Option | Default | Meaning |
|---|---|---|
| `--model <id>` | `LMSTUDIO_MODEL`, else the first **loaded** LLM trained for tool use | LM Studio model id. A model that is not loaded is loaded on first use (JIT) |
| `--max-steps <n>` | 25 | Model rounds before the agent gives up |
| `--reasoning <mode>` | `low` | `none`, `low`, `medium`, `high` or `on` (the model's default). Sent as `reasoning_effort`, except to a model that LM Studio lists without reasoning options |
| `--tools a,b` | all | Offer only these tools to the model |
| `--toolsets core,...` | all | Offer only tools from these groups (client-side counterpart of `TOOLSETS`, same group names), or with these names. The groups come from the server's tool list, so a group the server does not offer (for example `agents` without a sub-agent model) is an unknown name, and unknown names are an error |
| `--no-vision` | vision on if the model supports it | Never send screenshots as images. `--vision` forces them on |
| `--interactive`, `--no-interactive` | on when stdin and stdout are a terminal and `--quiet` is not set | Ask you when a sub-agent run it started waits for your answer, for example to approve a purchase ([below](#approving-a-sub-agents-purchase)). `--no-interactive` never asks. `--interactive` also asks with `--quiet`, piped input (one answer per line of stdin) or redirected output |
| `--json <file>` | | Write the full transcript: messages, reasoning, every tool call with arguments, result and timing, token usage, the questions put to you and your answers (`userTurns`), and the sub-agent runs still waiting at the end (`waitingRuns`) |
| `--quiet`, `-q` | | Print only the final answer, which suits shell scripts |
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
- The model's reasoning is printed in dim text. It streams as it arrives when LM Studio sends it as `reasoning_content`. `<think>` blocks in the reply are printed when the response ends.
- When the server offers `agent_reply`, the system prompt tells the model how to handle [sub-agent questions](AGENTS.md#questions-from-sub-agents). It is told to answer from the task. When the task approves a purchase, it passes those words to `agent_run` (or `agent_automate`) as `purchase_approval` and answers the matching confirm question "Yes" itself. It is also told never to send a password, to give a one-time code only when the task contains it, to answer only the questions of runs it started (runs of other clients are theirs to answer), and to cancel a run it cannot answer. A purchase the task did not approve is put to you, or refused when the agent cannot ask you: see the next section.

### Approving a sub-agent's purchase

A sub-agent always asks before it places an order or pays, and the server keeps the order button blocked until the host has answered ([Orders and payments](AGENTS.md#orders-and-payments)). Here the command-line agent is the host:

- **You approved the purchase in the task**, for example *"… order it; approved up to $15"*: the model passes your words as `purchase_approval` and answers the matching question "Yes" itself, without asking you. A task that only says what to buy (*"order one Blue Mug"*) does not approve the purchase.
- **Interactive** (the default in a terminal): for a purchase the task did not approve, the model ends its turn by asking you, with the item, the total, the delivery address, the payment method and the site. The agent prints that question and the sub-agent's own, and waits for your answer. Your answer goes back to the model, which answers the sub-agent with `agent_reply` ("Yes" only if you approve, "No" otherwise) and carries on. It asks the same way when the checkout differs from the approval or goes beyond it, and for other confirm questions (sending a message, deleting) the task did not approve. Press Enter without an answer to stop: the sub-agent run stays waiting and continues without an answer after `AGENT_REPLY_TIMEOUT_MS` (30 minutes), without the step it asked about, so nothing is ordered. The questions and your answers count toward `--max-steps`.
- **Not interactive** (`--no-interactive`, `--quiet`, or stdin or stdout is not a terminal): nobody can answer while the agent runs. The model replies "No" to a purchase the task did not approve, or one that goes beyond the approval, and says in its final answer that the order is ready and needs your approval, with the item and the total. It also replies "No" to other confirm questions the task did not approve.

In both modes the model is told never to end with a final answer while a run it started is waiting. If it does, or the agent stops at the step limit or on an error, the agent says which run still waits and that it continues without an answer after its timeout.

```text
$ npm run lmstudio:agent -- "Order one Blue Mug from https://shop.example/checkout"
...
[step 2] +9.8 s waiting for the model...
  model 3.1 s | 9214 prompt + 61 output tokens

Question for you (a sub-agent run waits for your answer)
The shop is ready to order one Blue Mug for $17.49, delivered to 1 Example Street and paid with the card ending 4242. Would you like me to place this order? (Yes/No)
  run r1a2b3c4 asks on https://shop.example: Place the order for one Blue Mug, total $17.49, delivered to 1 Example Street, paid with the card ending 4242?
Your answer (Enter to leave it unanswered): yes

[step 3] +31.4 s waiting for the model...
  model 2.6 s | 9390 prompt + 58 output tokens
  -> agent_reply {"run_id":"r1a2b3c4","question_id":"q1a2b3","answer":"Yes"}
...
```

## 8. End-to-end checks with the real model

`npm run lmstudio:e2e` (the `sws-lmstudio-e2e` command of the [`python/`](../python/README.md) package, set up as for the [command-line agent](#7-the-command-line-agent)) starts the local fixture website and runs scenarios through the same agent loop. Each scenario is judged by an objective assertion, not by the model's own claims:

| Scenario | Task given to the model | Passes when |
|---|---|---|
| **a** read page | Open the fixture `index.html`, report the exact h1 text and the price of Pear | The answer contains `Hello Fixture` and `$2`, and `browser_navigate` succeeded |
| **b** form | Open `form.html`, fill the email with `e2e@example.com`, check "I agree", submit | The fixture server received `POST /echo` whose body contains `email=e2e%40example.com` and `agree=yes` |
| **c** JS-rendered (with `--online`) | Open `https://quotes.toscrape.com/js/`, report who wrote the first quote | The answer contains `Albert Einstein` |
| **d** activity log | (runs after the others) | `GET /api/state` lists every tool call the agent made, with the same status (and the same URL for `browser_navigate`), and the server's log buffer has a matching `tool call` record |

```bash
npm run lmstudio:e2e                                  # a, b, d
npm run lmstudio:e2e -- --online                      # a, b, c, d
npm run lmstudio:e2e -- --only a,d --repeat 3         # repeat model scenarios to check reliability
npm run lmstudio:e2e -- --quiet --json e2e-results.json
```

| Option | Default | Meaning |
|---|---|---|
| `--only <a,b,c,d>` | `a,b,d` | Scenarios to run. Naming `c` here runs it even without `--online` |
| `--online` | | Also run the scenarios that need the internet (`c`) |
| `--repeat <n>` | 1 | Run each model scenario `n` times |
| `--model <id>` | `LMSTUDIO_MODEL`, else the first loaded LLM trained for tool use | LM Studio model id |
| `--reasoning <mode>` | `low` | `none`, `low`, `medium`, `high` or `on` |
| `--max-steps <n>` | 10 for a, 15 for b, 12 for c | Step limit for every scenario |
| `--mcp-url <url>` | see below | MCP endpoint |
| `--spawn` | | Always start a local server for the run |
| `--quiet`, `-q` | | Print no transcripts, only one result line per scenario and the summary |
| `--json <file>` | | Write the results, with transcripts, as JSON |

Environment variables: `MCP_URL`, `AUTH_TOKEN`, `LMSTUDIO_URL`, `LM_API_TOKEN`, `LMSTUDIO_MODEL`, `FIXTURE_HOST`.

The script finds a server in this order: `--mcp-url`, then `MCP_URL`, then `http://127.0.0.1:8931/mcp` if it answers, and otherwise it spawns a local server (this needs `npm run obscura:download`). Before calling the model, it checks that the browser can open the fixture site.

Against the Docker container, the browser must reach the fixture site on your host:

```bash
# .env: ALLOW_PRIVATE_NETWORK=true   (then docker compose up -d)
FIXTURE_HOST=host.docker.internal npm run lmstudio:e2e
```

The script prints a summary table and exits with `1` when any check fails (`2` for invalid options). This is a real run (`--online --repeat 2`, all 41 tools):

```text
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

LM Studio's native `POST /api/v1/chat` can call `mcp.json` servers itself through `"integrations": ["mcp/stealth-web-search"]`. This requires three settings under **Developer > Server Settings**:

1. **Require Authentication** on, with an API token (send `Authorization: Bearer $LM_API_TOKEN`).
2. **Allow calling servers from mcp.json** on. This option requires 1.
3. The token must be allowed to use MCP integrations.

```bash
curl http://127.0.0.1:1234/api/v1/chat \
  -H "Authorization: Bearer $LM_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen3.8-27b",
    "input": "Open https://example.com and tell me the page title.",
    "integrations": [{"type": "plugin", "id": "mcp/stealth-web-search", "allowed_tools": ["browser_navigate", "browser_snapshot"]}],
    "context_length": 32768, "reasoning": "low"
  }'
```

Without those settings the API answers `403 Permission denied to use plugin 'mcp/stealth-web-search'`. Passing the server as `ephemeral_mcp` with a `server_url` does not work for local servers (`URL resolves to a non-public address`), by design since LM Studio 0.4.15. For automation, the CLI agent (section 7) is simpler and needs none of these settings.

## 9b. LM Studio as the model for sub-agents

This is integration 2. The sub-agents (`agent_run`, `agent_automate`, `agent_find`, see [AGENTS.md](AGENTS.md)) run inside the container and work with any OpenAI-compatible chat completions endpoint. LM Studio's local server is one. The container reaches it on your machine through `host.docker.internal`. [MODELS.md](MODELS.md) describes the model file in full.

### With config/models.json (recommended)

1. **Create the file.** It is gitignored, and `compose.yaml` mounts `./config` read-only at `/app/config`, where the server looks for it:
   ```bash
   cp config/models.example.json config/models.json
   ```
2. **Select the LM Studio model.** The example lists two providers: `Local vLLM` first, then `LM Studio`. Without `AGENT_LLM_MODEL` the server uses the first model that supports tool calling, which is the vLLM one. Either delete the `Local vLLM` provider from your copy, or add this line to `.env`:
   ```ini
   AGENT_LLM_MODEL=qwen/qwen3.8-27b
   ```
   `AGENT_LLM_MODEL` matches a model `id`, `provider/id` (`LM Studio/qwen/qwen3.8-27b`) or a model `name`.
3. **Adjust the LM Studio provider** to your model. This is the provider from the example:
   ```json
   {
     "name": "LM Studio",
     "vendor": "lmstudio",
     "apiKey": "lm-studio",
     "apiType": "chat-completions",
     "models": [
       {
         "id": "qwen/qwen3.8-27b",
         "name": "Qwen3.8 27B (LM Studio)",
         "url": "http://host.docker.internal:1234/v1/chat/completions",
         "toolCalling": true,
         "vision": true,
         "streaming": true,
         "contextWindow": 32768,
         "maxOutputTokens": 8192,
         "thinking": true,
         "supportsReasoningEffort": ["low", "medium", "high"],
         "reasoningEffortFormat": "chat-completions",
         "modelOptions": {
           "temperature": 0.4,
           "top_p": 0.95
         }
       }
     ],
     "settings": {
       "qwen/qwen3.8-27b": {
         "reasoningEffort": "low"
       }
     }
   }
   ```

   | Field | What to put there for LM Studio |
   |---|---|
   | `id` | The model id as LM Studio lists it (`~/.lmstudio/bin/lms ls`, or `lms ps` for loaded models). It is sent as `model` in every request. Use the same id as the key in `settings` |
   | `url` | `http://host.docker.internal:1234/v1/chat/completions`. Change the port if LM Studio's server uses another one. A base URL such as `http://host.docker.internal:1234/v1` works too |
   | `apiKey` | Any text while LM Studio's *Require Authentication* is off. When it is on, an LM Studio API token, for example `"${LM_API_TOKEN}"` with `LM_API_TOKEN` set in `.env` |
   | `contextWindow` | The context length you load the model with, at least 8192. It caps the sub-agents' context budget (`AGENT_CONTEXT_TOKENS`, 65536 by default) |
   | `maxOutputTokens` | Output limit per response, sent as `max_tokens`. It caps `AGENT_MAX_OUTPUT_TOKENS` (8192 by default) |
   | `supportsReasoningEffort`, `settings.<id>.reasoningEffort` | The efforts the model accepts, and the one sent as `reasoning_effort`. The setting must be one of the listed values |
   | `modelOptions` | Request fields added to every request: `temperature`, `top_p`, and others such as `top_k` |
   | `toolCalling` | Leave it `true`. Models with `false` are never used for sub-agents |
   | `vision`, `thinking` | Informational only. Sub-agents read pages as text |

4. **Load the model and start LM Studio's server.** Load it with at least the context length in `contextWindow`:
   ```bash
   ~/.lmstudio/bin/lms server start
   ~/.lmstudio/bin/lms load qwen/qwen3.8-27b --context-length 32768
   ```
5. **Restart the server.** It reads `config/models.json` only at startup. `--force-recreate` restarts the container even when only that file changed, and also applies changes to `.env`:
   ```bash
   docker compose up -d --force-recreate
   ```
6. **Check the result** from inside the container, where `host.docker.internal` resolves:
   ```bash
   docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping
   ```
   After the server settings, it prints the sub-agent settings:
   ```text
   Sub-agents: on
     config          /app/config/models.json (provider "LM Studio", vendor lmstudio)
     model           qwen/qwen3.8-27b (Qwen3.8 27B (LM Studio))
     endpoint        http://host.docker.internal:1234/v1/chat/completions
     api key         set
     reasoning       low (sent as reasoning_effort)
     sampling        temperature 0.4, top_p 0.95
     context budget  32768 tokens, up to 8192 per response (max_tokens)
     streaming       on
     concurrency     2 runs at a time, 40 steps each
     in the file     Local vLLM / qwen3.8-27b, LM Studio / qwen/qwen3.8-27b
   ```
   The `in the file` line appears when the file lists more than one model. `--ping` then asks LM Studio for its model list and prints `The endpoint answers and lists ...`. The check exits with `1` when the endpoint does not answer or does not list the model id, and with `2` when the configuration is invalid. On the host, `npm run config:check -- --env-file .env` validates the same settings (without `--env-file` it does not read `.env`), but its `--ping` cannot reach `host.docker.internal`. At startup the server also logs `agent model endpoint reachable`, or a warning.

When `config/models.json` exists, variables that are set in `.env` still override it field by field: `AGENT_LLM_URL`, `AGENT_LLM_API_KEY`, `AGENT_LLM_TEMPERATURE`, `AGENT_LLM_TOP_P`, `AGENT_LLM_REASONING_EFFORT` and `AGENT_LLM_STREAMING`. The check lists them under `overridden by`. Remove an old `AGENT_LLM_URL` line from `.env` when you move to the file. `AGENT_MODELS_FILE` points the server to another file, and `AGENT_MODELS_FILE=none` ignores the file.

### With environment variables

Without `config/models.json`, set the endpoint in `.env` and restart with `docker compose up -d`:

```ini
AGENT_LLM_URL=http://host.docker.internal:1234/v1
AGENT_LLM_MODEL=qwen/qwen3.8-27b
# AGENT_LLM_API_KEY=your-api-key   only if "Require Authentication" is on
AGENT_CONTEXT_TOKENS=32768     # at most the context length the model is loaded with
AGENT_MAX_OUTPUT_TOKENS=6144
```

All `AGENT_*` settings are listed in [CONFIGURATION.md](CONFIGURATION.md#sub-agents).

### One model for the chat and the sub-agents

An LM Studio chat can use the sub-agent tools like any other tool. The chat model is the host agent, and the sub-agents use the model from the file, which can be the same loaded model. LM Studio then answers the chat's requests and the sub-agents' requests. What that means in practice:

- **The chat waits while a sub-agent works.** A chat does not generate while it waits for a tool result, so a single run has the model to itself. Runs that overlap (`AGENT_MAX_CONCURRENT`, 2 by default) share the model and each runs slower than it would alone. Set `AGENT_MAX_CONCURRENT=1` in `.env` to queue them instead.
- **The contexts are separate.** Each run has its own conversation. The pages a sub-agent reads never enter the chat; the chat receives only the result.
- **One context length applies to both.** The model is loaded once, with one context length. The chat (about 12k tokens of tool definitions plus the conversation) and each sub-agent request must fit in it. Keep `contextWindow` at or below the loaded context length.
- **Settings are per request.** The chat uses the settings of the LM Studio chat. The sub-agents send their own `reasoning_effort`, `temperature` and `top_p` from the file.
- **Long runs return early.** The `agent_*` tools answer "still running" after 170 s (`AGENT_WAIT_SECONDS`), which fits under the 180 s timeout in `mcp.json` (stored scripts are the exception: see the `--timeout` option above). The chat model then calls `agent_wait` to collect the result.
- **Questions come back at once.** When a sub-agent asks something, for example before it places an order, the tool returns the question right away, well within the timeout. The chat model shows it to you; answer in the chat, and it calls `agent_reply`, which again waits at most 170 s. If the model ends its turn instead, the run keeps waiting for 30 minutes (`AGENT_REPLY_TIMEOUT_MS`): tell the model what to answer. Small models may answer questions on their own. To approve a purchase up front, say so with its limits (*"order it, up to $15, go ahead"*): the model passes your words as `purchase_approval` and approves the matching question itself. For no questions at all, ask for `allow_questions: false` (the agent then does not order). See [Questions from sub-agents](AGENTS.md#short-tool-timeouts-and-lm-studio).

## 10. Troubleshooting

**The integration does not appear, or LM Studio shows an MCP error**
- Check that the server is up: `curl -s http://127.0.0.1:8931/healthz`.
- Check that `mcp.json` is valid JSON with the entry inside `"mcpServers"`: `npm run lmstudio:setup -- --dry-run` fails loudly on invalid JSON.
- Use a lowercase kebab-case name. LM Studio rejects plugin ids like `mcp/Stealth_Web_Search`.
- Use a `"url"` entry, not `"command"`. Stdio MCP servers have been reported to hang in some LM Studio versions.
- Watch LM Studio's logs while you enable the integration: `~/.lmstudio/bin/lms log stream --source server`. Request logs are also written to `~/.lmstudio/server-logs/`.

**`connection refused` / `fetch failed`**
- Use `http://127.0.0.1:8931/mcp`, not `localhost`.
- Run `docker compose ps` to check that the container is running and publishes `127.0.0.1:8931->8931`. If you changed `HOST_PORT`, update the URL.
- Never put `host.docker.internal` in LM Studio's `mcp.json`. LM Studio runs on the host, where that name does not resolve.

**Tool calls fail after 60 seconds**
The entry is missing `"timeout": 180000`, or the timeout was written in seconds. The unit is milliseconds. Re-run `npm run lmstudio:setup`, or check the entry under **Program > Install > Edit mcp.json**. LM Studio older than 0.3.18 ignores and removes the `timeout` key: update LM Studio. A stored script that runs longer than the timeout also fails this way (see `--timeout` in section 3).

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

**Sub-agents: the check says `The endpoint did not answer`, or runs cannot reach the model**
- Start LM Studio's server (**Developer > Start Server**) and load the model.
- In `config/models.json` use `http://host.docker.internal:1234`, not `127.0.0.1`: inside the container, `127.0.0.1` is the container itself.
- Run the check in the container (`docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping`), not on the host.
- On Linux, turn on **Serve on Local Network** in LM Studio. Docker Desktop (macOS, Windows) reaches LM Studio on `127.0.0.1` without it.

**Sub-agents use the vLLM model instead of LM Studio**
The server uses the first model in `config/models.json` that supports tool calling. Set `AGENT_LLM_MODEL` to the LM Studio model id, or delete the other provider from your copy. A leftover `AGENT_LLM_URL` in `.env` also overrides the file's `url`.

**`AGENT_LLM_MODEL "…" is not in /app/config/models.json`**
The value must match a model `id`, `provider/id` or `name` in the file. The error lists the models the file contains.

**`cannot read /app/config/models.json`**
The server runs as uid 1000 in Docker. Make the file readable: `chmod 644 config/models.json`.

**Where to look**
- LM Studio: `~/.lmstudio/bin/lms log stream --source server --json` for API requests. `lms log stream --source model --filter input,output` shows the exact prompt, including the injected tool definitions.
- Stealth Web Search: the dashboard's Activity panel and its Agents and Logs tabs, `docker compose logs -f`, or `jq -c 'select(.component=="tool")' logs/current.log`. LM Studio's MCP client identifies itself as `lmstudio-mcp-server-session`. The CLI agent appears as `lmstudio-agent` and the E2E script as `lmstudio-e2e`. Sub-agent model requests are logged with component `agent-llm`.

**LM Studio and Docker networking**
- LM Studio (host) to the server (container): `http://127.0.0.1:8931/mcp` through the published port. This goes in `mcp.json`.
- The server (container) to LM Studio, for the sub-agents: `http://host.docker.internal:1234`. This goes in `config/models.json`. Docker Desktop forwards it even though LM Studio listens only on `127.0.0.1`. On Linux, LM Studio must listen on a non-loopback interface.
