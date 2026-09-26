# Model configuration

The sub-agents (`agent_run`, `agent_automate`, `agent_find`, see [AGENTS.md](AGENTS.md)) need an OpenAI-compatible chat completions model. You describe that model in `config/models.json`, or with the `AGENT_LLM_*` variables in `.env`. This page is the reference for the file.

The file only configures the sub-agents. It does not change the model of your MCP client, of an LM Studio chat, or of `npm run lmstudio:agent`.

## File or variables

Use `config/models.json` when:

- You want the endpoint, key, limits and sampling of a model in one place, checked at startup with clear error messages.
- You use more than one model. List them all and pick one with `AGENT_LLM_MODEL`.
- You already have a provider list from an editor's "custom endpoint" settings. The file uses the same format, so you can paste it.

Use the `AGENT_LLM_*` variables when you only need a URL and a model id, or to override one field of the file for a while (see [Environment overrides](#environment-overrides)). Both are documented in [CONFIGURATION.md](CONFIGURATION.md#sub-agents).

## Quick setup

1. Copy the example:

   ```bash
   cp config/models.example.json config/models.json
   ```

2. Edit `config/models.json`. Set `id` to the model id your server lists (`GET /v1/models`), `url` to its endpoint, and `apiKey` to its key. Delete the providers you do not use. Without `AGENT_LLM_MODEL`, the first model that supports tool calling is used.

3. Start the server. If it is already running, restart it: the file is read once, at startup.

   ```bash
   docker compose up -d --build     # first start
   docker compose restart           # after editing config/models.json
   ```

   `docker compose up -d` alone does not restart a running container when only the file changed.

4. Check the configuration and ask the endpoint for its model list:

   ```bash
   docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping
   ```

   ```text
   Configuration is valid.
   …
   Sub-agents: on
     config          /app/config/models.json (provider "Local vLLM", vendor customendpoint)
     model           qwen3.8-27b (Qwen3.8 27B (vLLM))
     endpoint        http://192.168.1.50:8000/v1/chat/completions
     api key         set
     reasoning       medium (sent as reasoning_effort)
     sampling        temperature 0.4, top_p 0.95
     context budget  65536 tokens, up to 8192 per response (max_tokens)
     streaming       on
     concurrency     2 runs at a time, 40 steps each
     in the file     Local vLLM / qwen3.8-27b, LM Studio / qwen/qwen3.8-27b

   Checking http://192.168.1.50:8000/v1/chat/completions ...
   The endpoint answers and lists qwen3.8-27b.
   ```

   The check exits with `0` when everything is fine, `1` when the endpoint check fails, and `2` when the configuration is invalid. Without `--ping` it only validates the configuration.

Without Docker, run `npm run config:check -- --ping`. It reads `config/models.json` from the project folder. Add `--env-file .env` to load a `.env` file first (variables already set in your shell win).

The server also reports the model at startup. The `agents` field of the `starting` log line names the file and the provider:

```bash
docker compose logs | grep '"agents"'
```

```text
"agents":{"config":"/app/config/models.json","provider":"Local vLLM","endpoint":"http://192.168.1.50:8000/v1/chat/completions","model":"qwen3.8-27b","apiKey":"configured",...}
```

On the dashboard (`http://127.0.0.1:8931/`), the footer of the **Agents** tab shows `Config models.json (Local vLLM)`. It shows `Config environment` when the model comes from the `AGENT_LLM_*` variables.

## Where the file is read from

| How you run the server | File |
|---|---|
| Docker Compose | `/app/config/models.json` in the container. `compose.yaml` mounts `./config` there read-only, so this is `config/models.json` next to `compose.yaml` |
| `npm run dev` or `npm start` | `config/models.json` in the project folder |
| `AGENT_MODELS_FILE=<path>` | That file instead. A relative path is resolved from the current directory (`/app` in the container). The file must exist, or the server does not start |
| `AGENT_MODELS_FILE=none` | No file, even if `config/models.json` exists (`off` works too). Only the `AGENT_LLM_*` variables are used |

Under Docker, `AGENT_MODELS_FILE` is a path inside the container. To keep several files, put them in `config/` and select one, for example `AGENT_MODELS_FILE=/app/config/openai.json`. Everything in `config/` except `models.example.json` is in `.gitignore`, so extra files like this stay out of git.

When there is no file and `AGENT_LLM_URL` is not set, the sub-agents are off and the `agent_*` tools are not offered.

With `npm run dev`, restart the process after editing the file. `--watch` restarts on source changes, not on this file.

## Format

The file is a JSON array of providers. A single provider object (without the array) works too. Each provider lists its models and, optionally, per-model settings.

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
        "vision": false,
        "streaming": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768,
        "thinking": true,
        "supportsReasoningEffort": ["low", "medium", "xhigh"],
        "reasoningEffortFormat": "chat-completions",
        "modelOptions": {
          "temperature": 0.4,
          "top_p": 0.95
        }
      }
    ],
    "settings": {
      "qwen3.8-27b": {
        "reasoningEffort": "medium"
      }
    }
  }
]
```

### Provider fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Provider name. Shown in logs, in `config:check` and on the dashboard. `AGENT_LLM_MODEL` can use it as `<name>/<id>` |
| `vendor` | string | no | Informational. Shown by `config:check` |
| `apiKey` | string | no | Sent as `Authorization: Bearer <key>`. `${VAR}` is replaced by an environment variable (see [Keys from the environment](#keys-from-the-environment)). Empty or missing: no `Authorization` header |
| `apiType` | string | no | Only `"chat-completions"` (OpenAI-compatible `/v1/chat/completions`) is accepted |
| `url` | string | no | Default endpoint for the provider's models that have no `url` of their own |
| `models` | array | yes | The provider's models, at least one |
| `settings` | object | no | Per-model settings, keyed by model `id` |

### Model fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Sent as `model` in every request. Must be an id the endpoint lists (`GET /v1/models`) |
| `name` | string | no | Display name. `AGENT_LLM_MODEL` can select the model by it |
| `url` | string | yes, unless the provider has one | The endpoint: a base URL (`http://host:8000` or `http://host:8000/v1`) or the full `…/v1/chat/completions` URL. `http` or `https`. `${VAR}` is replaced by an environment variable |
| `toolCalling` | boolean | no | `false` means the model cannot be used: sub-agents need tool calling. Missing counts as supported |
| `vision` | boolean | no | Informational. Sub-agents read pages as text and send no images |
| `streaming` | boolean | no | Stream responses. Missing: `AGENT_LLM_STREAMING` (default `true`) |
| `contextWindow` | integer, at least 1024 | no | The model's context length. Caps the agent's context budget (see [Context window and output limit](#context-window-and-output-limit)) |
| `maxOutputTokens` | integer, at least 1 | no | The model's output limit. Caps `AGENT_MAX_OUTPUT_TOKENS` |
| `thinking` | boolean | no | Informational. To switch thinking on or off for Qwen-style chat templates, use `AGENT_LLM_THINKING` |
| `supportsReasoningEffort` | array of strings | no | The `reasoning_effort` values the model accepts. See [Reasoning effort](#reasoning-effort) |
| `reasoningEffortFormat` | `"chat-completions"` or `"none"` | no | `"chat-completions"` sends the effort as the `reasoning_effort` request field. `"none"` never sends it |
| `modelOptions` | object | no | `temperature`, `top_p` and extra request fields. See [Sampling and extra request fields](#sampling-and-extra-request-fields) |

### Settings

| Field | Type | Meaning |
|---|---|---|
| `settings.<model id>.reasoningEffort` | string | The reasoning effort to send for that model. The key must be the model's `id` exactly |

Unknown fields, settings for an `id` the provider does not have, and unknown setting names are ignored with a warning. Misspelled fields therefore show up at startup and in `config:check`.

## Choosing the model

- **`AGENT_LLM_MODEL` set:** the server picks the first model whose `id` is exactly that value. If none matches, it tries `<provider name>/<id>` (for example `LM Studio/qwen/qwen3.8-27b`), then the display `name`. These two ignore case. Use `<provider name>/<id>` when two providers have a model with the same `id`.
- **`AGENT_LLM_MODEL` not set:** the first model in the file whose `toolCalling` is not `false`. Models skipped for `"toolCalling": false` produce a warning.

The request always uses the chosen model's `id`. If `AGENT_LLM_MODEL` matches no model, the server does not start and the message lists the models in the file. If it selects a model with `"toolCalling": false`, the server does not start either. To use a model that is not in the file, set `AGENT_MODELS_FILE=none` and configure it with the `AGENT_LLM_*` variables.

## Reasoning effort

The server decides what to send as `reasoning_effort`, in this order:

1. `AGENT_LLM_REASONING_EFFORT` is set: that value is sent (`none` leaves the field out). It is not checked against `supportsReasoningEffort`.
2. `"reasoningEffortFormat": "none"`, or `supportsReasoningEffort` is an empty list: nothing is sent. A `reasoningEffort` setting for the model is ignored with a warning.
3. `settings.<id>.reasoningEffort` is set: it is sent. If the model has a `supportsReasoningEffort` list, the value must be in it, or the server does not start. Without a list, any value is sent.
4. The model has a `supportsReasoningEffort` list: `medium` is sent if the list offers it. Otherwise nothing is sent.
5. The model declares nothing about reasoning: the `AGENT_LLM_REASONING_EFFORT` default applies, which sends `medium`.

Values are compared without regard to case and sent in lower case. Whether a model uses `reasoning_effort` depends on the server and the model's chat template. For a server that rejects or ignores the field, set `"reasoningEffortFormat": "none"`.

## Sampling and extra request fields

`modelOptions` holds the sampling settings and any other fields your server accepts:

| Key | Rule |
|---|---|
| `temperature` | A number from 0 to 2, or `null` to leave the field out. Missing: `AGENT_LLM_TEMPERATURE` (default `0.4`) |
| `top_p` | A number from 0 to 1, or `null` to leave the field out. Missing: `AGENT_LLM_TOP_P` (default `0.95`) |
| Any other key | Added to every request body as it is, for example `"top_k": 20`, `"min_p": 0.05` or `"repetition_penalty": 1.05` |

The server sets these fields itself, so `modelOptions` cannot contain them: `model`, `messages`, `tools`, `tool_choice`, `stream`, `stream_options`, `max_tokens`, `max_completion_tokens` and `reasoning_effort`. Use `streaming`, `maxOutputTokens` and `settings.<id>.reasoningEffort` instead.

Extra keys are added after the fields the server sets from variables. For example, a `chat_template_kwargs` object in `modelOptions` replaces the one `AGENT_LLM_THINKING` would send.

## Context window and output limit

Each sub-agent run keeps its transcript within a context budget, and each model response is limited to a number of output tokens (reasoning included). The file can only lower these limits:

- **Context budget:** `AGENT_CONTEXT_TOKENS` (default `65536`). If the model's `contextWindow` is smaller, the budget is `contextWindow`. A `contextWindow` below 8192 is too small for sub-agents, and the server does not start. To use more of a large window, raise `AGENT_CONTEXT_TOKENS`, up to `contextWindow`.
- **Output per response:** `AGENT_MAX_OUTPUT_TOKENS` (default `8192`), or the model's `maxOutputTokens` if that is smaller.
- The output limit must be less than half of the context budget. If it is not, and a small `contextWindow` lowered the budget, and you did not set `AGENT_MAX_OUTPUT_TOKENS`, the output limit becomes a quarter of the budget. Otherwise the server does not start.

| `contextWindow` | `maxOutputTokens` | Context budget | Output per response |
|---|---|---|---|
| 262144 | 32768 | 65536 | 8192 |
| 32768 | 8192 | 32768 | 8192 |
| 16384 | 12000 | 16384 | 4096 (a quarter of the budget) |
| 4096 | any | the server does not start | |

The table uses the default `AGENT_CONTEXT_TOKENS` and `AGENT_MAX_OUTPUT_TOKENS`. If you set `AGENT_CONTEXT_TOKENS` above `contextWindow`, the server uses `contextWindow` and logs a warning.

Set `contextWindow` to the context length the server really gives the model: vLLM's `--max-model-len`, or the context length the model is loaded with in LM Studio, Ollama or llama.cpp.

## Environment overrides

A variable that is set to a non-empty value in the environment (or in `.env`) overrides the matching field of the file. The other fields still come from the file.

| Variable | Overrides |
|---|---|
| `AGENT_LLM_URL` | The model's `url` (and the provider's) |
| `AGENT_LLM_API_KEY` | The provider's `apiKey` |
| `AGENT_LLM_TEMPERATURE` | `modelOptions.temperature` (`none` leaves it out) |
| `AGENT_LLM_TOP_P` | `modelOptions.top_p` (`none` leaves it out) |
| `AGENT_LLM_REASONING_EFFORT` | `settings.<id>.reasoningEffort` and the `supportsReasoningEffort` rules (`none` leaves it out) |
| `AGENT_LLM_STREAMING` | `streaming` |
| `AGENT_LLM_EXTRA_BODY` | Merged over the extra fields of `modelOptions`: a key in the variable wins |

These variables work together with the file rather than override it:

| Variable | With a models file |
|---|---|
| `AGENT_LLM_MODEL` | Selects a model in the file (see [Choosing the model](#choosing-the-model)) |
| `AGENT_CONTEXT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS` | The agent's budget, capped by `contextWindow` and `maxOutputTokens` |
| `AGENT_LLM_MAX_TOKENS_FIELD` | No field in the file. `max_tokens` (default) or `max_completion_tokens` (OpenAI reasoning models) |
| `AGENT_LLM_THINKING` | No field in the file. `true`/`false` sends `chat_template_kwargs.enable_thinking` |
| `AGENT_LLM_TIMEOUT_MS` and the other `AGENT_*` settings | No field in the file. They apply as usual |

When one of the first six variables overrides the file, the server logs `agent model from /app/config/models.json; AGENT_LLM_URL from the environment take precedence` (with the variables it used), and `config:check` shows them in an `overridden by` line. A leftover `AGENT_LLM_URL` in `.env` can make changes to the file seem to have no effect.

## Keys from the environment

`apiKey` and `url` can contain `${NAME}`. The server replaces it with the environment variable `NAME` when it starts. This keeps the key out of the file:

```json
{ "apiKey": "${OPENAI_API_KEY}" }
```

```ini
# .env
OPENAI_API_KEY=your-api-key
```

Pick a name of your own. Do not use one of the `AGENT_LLM_*` variables here: `AGENT_LLM_URL` and `AGENT_LLM_API_KEY` override the file for whichever model is selected (see [Environment overrides](#environment-overrides)), and the startup log then reports an override.

Docker Compose passes every variable in `.env` into the container, so `${NAME}` finds it there. With `npm run dev`, set the variable in the shell that starts the server. If the variable is not set or empty, the server does not start. Only `${NAME}` with letters, digits and underscores is replaced, and only in `apiKey` and `url`.

## Comments, trailing commas and duplicate keys

The parser is lenient about the things editors often leave in such files:

- `//` and `/* … */` comments are allowed.
- Trailing commas before `]` or `}` are allowed.
- A key that appears twice in the same object is reported with its line number, and the last one wins. Standard JSON parsing keeps the last one too, but silently.

```jsonc
[
  {
    "name": "Local vLLM",
    // the second "settings" block wins: reasoningEffort is "medium"
    "settings": { "qwen3.8-27b": { "reasoningEffort": "xhigh" } },
    "settings": { "qwen3.8-27b": { "reasoningEffort": "medium" } },
    "models": [ /* … */ ],
  },
]
```

```text
/app/config/models.json line 6: "settings" appears more than once in the same object; the last one is used
```

Merge such blocks into one to keep the settings you meant.

## Examples

Each example is a complete `config/models.json`. From inside the container, `host.docker.internal` is your own machine and `127.0.0.1` is the container itself.

### vLLM on another machine

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
        "url": "http://192.168.1.50:8000/v1",
        "toolCalling": true,
        "streaming": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768,
        "supportsReasoningEffort": ["low", "medium", "xhigh"],
        "modelOptions": { "temperature": 0.4, "top_p": 0.95, "top_k": 20 }
      }
    ],
    "settings": { "qwen3.8-27b": { "reasoningEffort": "medium" } }
  }
]
```

- `id` is the name vLLM serves the model under (`--served-model-name`, or the model path).
- vLLM needs `--enable-auto-tool-choice` and a `--tool-call-parser` for the model, or the model answers in text instead of calling tools.
- `apiKey` is the value of vLLM's `--api-key`. Without one, any value works.
- `top_k` is an extra request field, sent as it is.

### LM Studio on the same machine

```json
[
  {
    "name": "LM Studio",
    "vendor": "lmstudio",
    "apiKey": "lm-studio",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "qwen/qwen3.8-27b",
        "name": "Qwen3.8 27B (LM Studio)",
        "url": "http://host.docker.internal:1234/v1",
        "toolCalling": true,
        "streaming": true,
        "contextWindow": 32768,
        "maxOutputTokens": 8192,
        "supportsReasoningEffort": ["low", "medium", "high"],
        "modelOptions": { "temperature": 0.4, "top_p": 0.95 }
      }
    ],
    "settings": { "qwen/qwen3.8-27b": { "reasoningEffort": "low" } }
  }
]
```

- Start LM Studio's server (**Developer > Start Server**) and load the model with at least the `contextWindow` above. See [LM_STUDIO.md](LM_STUDIO.md).
- The key only matters when LM Studio's **Require Authentication** is on. Then use its token.
- Docker Desktop (macOS, Windows) reaches LM Studio on `127.0.0.1` through `host.docker.internal`. On Linux, turn on **Serve on Local Network**.

### Ollama

```json
[
  {
    "name": "Ollama",
    "vendor": "ollama",
    "apiKey": "ollama",
    "models": [
      {
        "id": "qwen3:32b",
        "url": "http://host.docker.internal:11434/v1",
        "toolCalling": true,
        "contextWindow": 32768,
        "reasoningEffortFormat": "none",
        "modelOptions": { "temperature": 0.4, "top_p": 0.95 }
      }
    ]
  }
]
```

- `id` is the name `ollama list` shows.
- Ollama ignores the key. Any value works, or leave `apiKey` out.
- Ollama loads models with a small context by default. Start it with a larger one (`OLLAMA_CONTEXT_LENGTH=32768 ollama serve`) and set `contextWindow` to the same value.
- `"reasoningEffortFormat": "none"` keeps `reasoning_effort` out of the requests.
- On Linux, Ollama must listen beyond loopback (`OLLAMA_HOST=0.0.0.0`).

### llama.cpp server

```json
[
  {
    "name": "llama.cpp",
    "vendor": "llamacpp",
    "models": [
      {
        "id": "qwen3-32b",
        "url": "http://host.docker.internal:8080/v1",
        "toolCalling": true,
        "contextWindow": 32768,
        "reasoningEffortFormat": "none"
      }
    ]
  }
]
```

- Start `llama-server` with `--jinja` (needed for tool calling), `-c 32768` to match `contextWindow`, and `--alias qwen3-32b` so `GET /v1/models` lists the `id` above.
- No `apiKey` means no `Authorization` header. Add one if you started `llama-server` with `--api-key`.
- `temperature` and `top_p` are not in `modelOptions`, so the `AGENT_LLM_TEMPERATURE` and `AGENT_LLM_TOP_P` defaults (`0.4`, `0.95`) are sent.

### OpenAI

```json
[
  {
    "name": "OpenAI",
    "vendor": "openai",
    "apiKey": "${OPENAI_API_KEY}",
    "apiType": "chat-completions",
    "url": "https://api.openai.com/v1",
    "models": [
      {
        "id": "gpt-5",
        "toolCalling": true,
        "supportsReasoningEffort": ["low", "medium", "high"],
        "modelOptions": { "temperature": null, "top_p": null }
      }
    ],
    "settings": { "gpt-5": { "reasoningEffort": "low" } }
  }
]
```

```ini
# .env
OPENAI_API_KEY=your-api-key
AGENT_LLM_MAX_TOKENS_FIELD=max_completion_tokens
```

- Reasoning models (o-series, gpt-5) only accept the default sampling, so `temperature` and `top_p` are `null` (left out). They also need `max_completion_tokens`, which is set with `AGENT_LLM_MAX_TOKENS_FIELD` in `.env`: the file has no field for it.
- For a non-reasoning model (gpt-4o, gpt-4.1), use `"reasoningEffortFormat": "none"` instead of `supportsReasoningEffort`, drop the `null` sampling options, and keep the default `max_tokens`.
- `contextWindow` is left out, so the agent uses the default budget (`AGENT_CONTEXT_TOKENS`, 65536 tokens).
- The provider `url` applies to every model of the provider that has no `url`.

### Several models

List several providers or models, as `config/models.example.json` does, and choose one in `.env`:

```ini
AGENT_LLM_MODEL=qwen/qwen3.8-27b
```

Any of `qwen/qwen3.8-27b` (the id), `LM Studio/qwen/qwen3.8-27b` (provider and id) or `Qwen3.8 27B (LM Studio)` (the name) selects the LM Studio model of the example. Run `docker compose up -d` after changing `.env`.

## Docker and Linux notes

- `compose.yaml` mounts `./config` at `/app/config` read-only. Keep the file at `config/models.json` next to `compose.yaml`.
- The server runs as uid 1000 in the container and must be able to read the file. `cp` normally creates it readable by everyone (mode 644), which is enough. On Linux, if you made it private (`chmod 600`) and your user is not uid 1000 (check with `id -u`), give the file to uid 1000 (`sudo chown 1000 config/models.json`), or make it readable again and keep the key in `.env` with `${NAME}`.
- Every file in `config/` except the example is in `.gitignore`, and the whole `config/` folder is excluded from the Docker build context. The file is never committed or built into the image; it is only mounted at runtime.
- `host.docker.internal` only resolves inside Docker. Run `--ping` checks for such URLs in the container, not with `npm run config:check` on the host.
- Model requests come from the server process, not from the browser, so `ALLOW_PRIVATE_NETWORK` does not apply to them. A LAN address such as `http://192.168.1.50:8000/v1` works without it.

## Error messages

An invalid file stops the server at startup (exit code 2). The message goes to the container output (`docker compose logs`) and starts with `Invalid configuration:`. Problems in the file are listed under `AGENT_MODELS_FILE:`. Under Compose the container keeps restarting until you fix the file, and `docker compose run --rm --no-deps stealth-web-search node dist/check-config.js` shows the same message.

| Message | Meaning |
|---|---|
| `… does not exist` | `AGENT_MODELS_FILE` names a file that is not there. Under Docker the path is inside the container |
| `cannot read …: EACCES: permission denied …` | The server (uid 1000 in Docker) cannot read the file. See [Docker and Linux notes](#docker-and-linux-notes) |
| `… is not valid JSON: … (line N column M)` | A syntax error, such as a missing comma or quote. Comments and trailing commas are not the problem |
| `… line N: unterminated string` | A string is missing its closing `"` before the end of the line |
| `… line N: unterminated /* comment` | A `/*` comment has no `*/` |
| `… is not a valid models file: <path>: <problem>` | A field is missing or has the wrong type, for example `[0].models[0].id: Invalid input: expected string, received undefined` or `[0].models[0].contextWindow: Invalid input: expected number, received string`. `[0]` is the first provider |
| `(top level): must list at least one provider` | The file is an empty array |
| `[0].models: must list at least one model` | A provider has an empty `models` list |
| `[0].apiType: only "chat-completions" (OpenAI-compatible /v1/chat/completions) is supported` | `apiType` has another value. Remove it or set `"chat-completions"` |
| `reasoningEffortFormat: expected one of: chat-completions, none` | `reasoningEffortFormat` has another value |
| `AGENT_LLM_MODEL "…" is not in …. Models in the file: …` | `AGENT_LLM_MODEL` matches no model. The message lists them as `provider / id`; you can copy an entry as it is |
| `model "…" has "toolCalling": false; sub-agents need a model that supports tool calling` | `AGENT_LLM_MODEL` selects a model marked `"toolCalling": false` |
| `no model supports tool calling ("toolCalling": false on all of them); sub-agents need one` | Every model in the file is marked `"toolCalling": false` |
| `the model has no "url" (and the provider has none either)` | Add `url` to the model or the provider |
| `url: expected an http(s) URL, got "…"` | `url` does not start with `http://` or `https://`, for example `host.docker.internal:1234/v1`. When the value cannot be read as a URL at all (`192.168.1.50:8000/v1`), the message adds `such as http://127.0.0.1:8000/v1` |
| `apiKey uses ${NAME}, but the environment variable NAME is not set` | Set `NAME` in `.env` (Docker) or in your shell (`npm run dev`). The same message exists for `url` |
| `reasoningEffort "…" is not in supportsReasoningEffort (…)` | The setting is not one of the values the model lists |
| `modelOptions cannot set … (the server sets these; …)` | `modelOptions` contains a field the server sets itself. See [Sampling and extra request fields](#sampling-and-extra-request-fields) |
| `modelOptions.temperature must be a number between 0 and 2 (or null to leave it out)` | Also for `top_p` (0 to 1). Numbers must not be quoted |
| `contextWindow N of "…" is too small for sub-agents (at least 8192)` | Load the model with a larger context, or use another model |
| `AGENT_MAX_OUTPUT_TOKENS: must be less than half of the context budget (N tokens)` | Lower `AGENT_MAX_OUTPUT_TOKENS` or `maxOutputTokens` |

Most messages about the chosen model start with the file, provider and model, for example `/app/config/models.json (Local vLLM / qwen3.8-27b): …`.

These are warnings. The server starts, logs them, and `config:check` lists them:

| Warning | Meaning |
|---|---|
| `line N: "…" appears more than once in the same object; the last one is used` | A duplicated key. See [Comments, trailing commas and duplicate keys](#comments-trailing-commas-and-duplicate-keys) |
| `unknown field … is ignored`, `unknown setting … is ignored` | A misspelled or unsupported field |
| `settings for "…" in provider "…" match none of its models` | The key under `settings` is not the `id` of one of the provider's models |
| `skipped models with "toolCalling": false; using "…"` | The first models in the file cannot call tools |
| `reasoningEffort "…" is ignored because the model does not take one` | The model has `"reasoningEffortFormat": "none"` or an empty `supportsReasoningEffort` |
| `AGENT_CONTEXT_TOKENS N is more than the model's contextWindow; using M` | The budget was lowered to `contextWindow` |

Errors from the endpoint at run time name the variables (`Check AGENT_LLM_API_KEY`, `Check AGENT_LLM_URL and AGENT_LLM_MODEL`). With a models file, these mean the provider's `apiKey`, and the model's `url` and `id`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#sub-agents).

## Security

- The file holds API keys. It is in `.gitignore` and excluded from the Docker build context, so it is not committed or built into the image. Any other file you add to `config/` is ignored too.
- To keep keys out of the file entirely, use `${NAME}` and put the key in `.env`, which is also in `.gitignore`.
- The server does not print the key. The startup log shows `"apiKey":"configured"`, `config:check` shows `api key set`, and the dashboard shows only the endpoint's origin.
- The container mounts the folder read-only, so the server cannot change the file.
- Every sub-agent request goes to the configured endpoint, with the task, the pages the agent reads and its notes. Use an endpoint you trust with that data.
