# Contributing

This guide covers the development setup, the test suites and what a pull request needs. For larger changes, open an issue first so the approach can be agreed before you write the code.

Security problems are not reported in issues. See [SECURITY.md](SECURITY.md).

## Development setup

You need:

- [Node.js 24+](https://nodejs.org) (`package.json` requires `>=24.0.0`) and npm
- Python 3.9 or newer for `npm run obscura:download` and `npm run lmstudio:setup`: they are standard-library scripts, so the `python3` of a recent Linux distribution, or of macOS with the Xcode Command Line Tools (`xcode-select --install`), is enough (on Windows, install [Python](https://www.python.org/downloads/) or [uv](https://docs.astral.sh/uv/)). The launcher also tries `python3.9` to `python3.14` when `python3` is older, and `PYTHON` picks one
- Python 3.10 or newer for the other Python tools, which live in [`python/`](python/README.md): `npm run lmstudio:agent`, `npm run lmstudio:e2e`, `npm run agents:e2e`, `npm run site:build` and `npm run site:serve`, and the Python tests. With [uv](https://docs.astral.sh/uv/) installed there is nothing to set up; otherwise run `npm run py:setup` once, which creates `python/.venv` with the versions of `python/uv.lock`
- Git
- For the Docker suite: Docker with the Compose plugin, version 2.24 or newer (`docker compose version`)
- For the live model checks: [LM Studio](https://lmstudio.ai), or any OpenAI-compatible model server with tool calling

Get the code and run the server without Docker:

```bash
git clone https://github.com/tanishmeh/stealth-web-search.git
cd stealth-web-search
npm ci
npm run obscura:download     # fetches the Obscura binary for your OS into .obscura/ (sha256-verified)
npm run dev                  # runs src/main.ts with auto-reload on http://127.0.0.1:8931
```

`npm run obscura:download` picks the same Obscura release as the `Dockerfile`, so local runs and the image use the same engine. It runs `scripts/download_obscura.py` with the first Python 3.9+ it finds (`PYTHON` picks one). A second run does nothing while `.obscura/VERSION` matches; `-- --force` downloads again, and `-- --dest <dir>` installs elsewhere.

Things to know about `npm run dev`:

- It does not read `.env`. Set variables in your shell, or run `node --env-file=.env --watch src/main.ts` instead.
- It reads `config/models.json` from the project folder, like the container does. Copy `config/models.example.json` to start one. The file is gitignored.
- Logs go to `./logs/`, automation scripts to `./data/scripts` and snapshots (saved sign-ins) to `./data/snapshots`. All of them are gitignored. Snapshots hold live session cookies: never commit or share that folder.
- It exposes an unauthenticated Obscura CDP socket on `127.0.0.1` while it runs (see [Security](README.md#security) in the README). Do not run it on a shared machine.

`npm run build` compiles `src/` to `dist/` and copies the dashboard's static files. `npm start` runs the built server. The Docker image runs the same `dist/main.js`.

## Project layout

```text
src/
  main.ts              startup, shutdown
  config.ts            environment configuration
  models-config.ts     reads config/models.json (the sub-agents' model)
  check-config.ts      npm run config:check
  logger.ts            structured logging (stdout, rotating file, dashboard)
  obscura/process.ts   starts and supervises Obscura
  cdp/client.ts        Chrome DevTools Protocol client
  browser/             browsers (shared + isolated), tabs, page scripts, live view
  mcp/                 HTTP server, MCP transports, sessions, tool runner
  tools/               the browser_*, agent_*, script_* and snapshot_* tools
  agents/              sub-agents: model client, agent loop, the three agent kinds, web search
  scripts/             automation scripts: store, QuickJS sandbox, browser API
  snapshots/           saved sign-ins: encrypted file store, capture and load
  util/                shared helpers: log summaries, secret masking, limits
  dashboard/           dashboard API and static UI
  stdio-bridge.ts      stdio <-> HTTP bridge
scripts/               Obscura download and LM Studio setup (Python 3.9+), the npm launcher for the Python tools, docs generator
python/                Python tools: LM Studio command-line agent and e2e, sub-agent e2e, website builder (python/README.md)
config/                models.example.json (copy it to models.json)
test/                  unit and integration tests, fixture website
docs/                  getting started, clients, LM Studio, configuration, models file, sub-agents, snapshots, tools, logging, troubleshooting, architecture
site/                  the website's landing page and assets
examples/              MCP client configuration files
```

[Architecture](docs/ARCHITECTURE.md) explains how the pieces fit together and has a source map.

## Tests

| Command | What it runs | What it needs |
|---|---|---|
| `npm run typecheck` | `tsc` over `src/`, `scripts/` and `test/`, without emitting files | Nothing else |
| `npm test` | Unit tests in `test/unit/` | Nothing else: no browser, no model |
| `npm run test:integration` | Integration tests in `test/integration/`. They start real servers and Obscura against the local fixture website in `test/fixtures/site/`. Sub-agents run against scripted stand-in models, so no GPU is needed | The Obscura binary from `npm run obscura:download` |
| `npm run test:py` | The Python tests in `python/tests/`: the LM Studio command-line agent and e2e runner (against the real server and a scripted stand-in for LM Studio), the sub-agent e2e runner, the website builder, the standard-library scripts. Tests that start the TypeScript server are marked `integration`; `npm run test:py -- -m "not integration"` skips them | The Python tools (uv, or `npm run py:setup`); the integration tests also need the Obscura binary |
| `npm run lint:py` | ruff check and format check over `python/` and `scripts/*.py`. `npm run lint:py -- --fix` fixes what it can | The Python tools |
| `npm run test:docker` | The same integration suite against the running container. CI also runs the Python agent host tests against it: `MCP_URL=http://127.0.0.1:8931/mcp FIXTURE_HOST=host.docker.internal npm run test:py -- tests/lmstudio_agent tests/lmstudio_e2e` | The container started with `compose.test.yaml` (see below) |
| `npm run lmstudio:e2e` | Scenarios with a real local model, judged by objective checks. Add `-- --online` for the public JS-rendered site | LM Studio's local server (`127.0.0.1:1234`, or `LMSTUDIO_URL`) with a tool-capable model loaded, and the Python tools |
| `npm run agents:e2e` | Live sub-agent scenarios (`run`, `automate`, `find`, `parallel`) with the model the server is configured with | A running server with sub-agents enabled, internet access, and the Python tools (uv, or `npm run py:setup`) |
| `npm run config:check` | Validates the environment variables and `config/models.json`, and prints the settings the server will use | Nothing. Add `-- --ping` to check that the model endpoint answers |

Run `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run test:py` and `npm run lint:py` before every pull request. CI (`.github/workflows/ci.yml`) runs them, the build, the website build and the Docker suite on every pull request and on pushes to `main`. It installs the Python tools with `uv sync --locked`, so a `pyproject.toml` change needs an updated `python/uv.lock` and `python/constraints.txt` (see [python/README.md](python/README.md)).

### The Docker suite

The fixture website runs on your machine, so the container's browser must be allowed to reach `host.docker.internal`. `compose.test.yaml` sets `ALLOW_PRIVATE_NETWORK=true` for that:

```bash
docker compose -f compose.yaml -f compose.test.yaml up -d --build
npm run test:docker
docker compose up -d --build   # afterwards: back to the normal settings (private network blocked)
```

`npm run test:docker` uses `MCP_URL=http://127.0.0.1:8931/mcp` and `FIXTURE_HOST=host.docker.internal` unless you set them. With `HOST_PORT` or `AUTH_TOKEN` in `.env`:

```bash
MCP_URL=http://127.0.0.1:<port>/mcp AUTH_TOKEN=<token> npm run test:docker
```

Some tests need a server that the suite starts itself (for example to read its log files or configure a scripted model). They are skipped against the container and run in `npm run test:integration`. The tests that save snapshots in the container (its real `snapshots` volume) use unique names and delete them afterwards, also when an assertion fails.

On Linux, the container runs as uid 1000 and writes to `./logs`. If your user id is not 1000, run `sudo chown -R 1000:1000 logs` once.

### Live model checks

`npm run lmstudio:e2e` finds a server in this order: `--mcp-url`, then `MCP_URL`, then `http://127.0.0.1:8931/mcp` if it answers, and otherwise it spawns a local server (this needs `npm run obscura:download`). `--spawn` always starts a local server. Against the Docker container, the browser must reach the fixture site on your host: set `ALLOW_PRIVATE_NETWORK=true` in `.env`, run `docker compose up -d`, then `FIXTURE_HOST=host.docker.internal npm run lmstudio:e2e`. See [LM Studio](docs/LM_STUDIO.md#8-end-to-end-checks-with-the-real-model).

`npm run agents:e2e` talks to the server at `--mcp-url` or `MCP_URL` (default `http://127.0.0.1:8931/mcp`; set `AUTH_TOKEN` if the server has one). The server needs a model in `config/models.json` or `AGENT_LLM_URL`, and the `core`, `content`, `tabs`, `agents` and `scripts` tools. The script navigates the shared browser's active tab to read its ground truth and stores a script named `e2e-quotes-by-tag`. Use `--only run,automate,find,parallel`, `--repeat N` and `--json results.json`. It is the `sws-agents-e2e` command of the `python/` package, and its checks are unit-tested without a model in `python/tests/agents_e2e/` (`npm run test:py`). See [Sub-agents](docs/AGENTS.md#testing).

### Checking the model configuration

```bash
npm run config:check                          # validate and print the settings
npm run config:check -- --ping                # also ask the model endpoint for its model list
npm run config:check -- --env-file .env       # load .env first (variables already set win)
```

The exit code is `0` when everything is fine, `1` when the endpoint check fails and `2` when the configuration is invalid. `host.docker.internal` only resolves inside Docker, so check such endpoints in the container:

```bash
docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping
```

## Documentation

- `docs/TOOLS.md` and `docs/tools.json` (the tool counts the website shows) are generated from the tool definitions. When you add, rename or change a tool, run `npm run docs:tools` and commit both files. Do not edit them by hand. CI and the Pages workflow fail when either is out of date. The tool counts and the tool table in `README.md` are written by hand, so update them too.
- A new or changed environment variable goes in `.env.example` and [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- A new or changed field in the models file goes in `config/models.example.json` and [docs/MODELS.md](docs/MODELS.md).
- The website (GitHub Pages) is built by `.github/workflows/pages.yml` on every push to `main`: the landing page from `site/index.html`, and one page for each Markdown file listed in `GROUPS` in `python/src/sws_tools/website/pages.py` (the files in `docs/`, plus `CONTRIBUTING.md`, `SECURITY.md` and `CHANGELOG.md`). Edit those files, not the generated `_site/`, and add a new document to that list. `npm run site:build` builds it locally with the Python builder (`sws-site`, so it needs uv or `npm run py:setup`) and fails on a broken link or anchor; `npm run site:serve` also serves it on `http://127.0.0.1:4173`. In a fork, turn on **Settings > Pages > Source: GitHub Actions** once before the workflow can deploy.
- Match the tone of the existing docs: plain, direct, second person, short sentences. Use `127.0.0.1`, not `localhost`, in local URLs, and `192.168.1.50` or `10.0.0.5` for example LAN addresses. Every code block gets a language tag.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for changes users will notice.

## Code style

- TypeScript in strict mode, as ES modules. Node 24 runs the `.ts` files directly by stripping the types (`npm run dev`, the tests and the scripts in `scripts/`), and `npm run build` compiles them with `tsc` for the Docker image.
- Because of the type stripping, use only erasable TypeScript syntax (`erasableSyntaxOnly` in `tsconfig.json`): no `enum`, no `namespace`, no constructor parameter properties. Import types with `import type` (`verbatimModuleSyntax`). Relative imports end in `.ts`, and the build rewrites them to `.js`.
- There is no linter or formatter for the TypeScript. Match the surrounding code: two-space indentation, single quotes, semicolons.
- Python (`python/` and `scripts/*.py`) is formatted and linted with ruff (`npm run lint:py`, configured in `python/pyproject.toml`), and `python/src` is type-checked with mypy in strict mode (`cd python && .venv/bin/mypy`, or `uv run --project python mypy`). The package targets Python 3.10+. `scripts/setup_lmstudio.py` and `scripts/download_obscura.py` target 3.9+ and use only the standard library.
- The dashboard UI in `src/dashboard/public/` is plain HTML, CSS and JavaScript with no build step.
- Tools are defined with `defineTool` in `src/tools/*.ts` and listed in `ALL_TOOLS` in `src/tools/index.ts`. Input schemas use Zod.
- Keep comments purposeful: explain why the code does something, a quirk it works around, or a limit it enforces. Do not restate what the code says.
- Never log secrets. Values that can hold credentials go through the existing redaction (`LOG_REDACT_SECRETS`).

## Pull requests

A good pull request:

- Does one thing, and says what it changes and why.
- Adds or updates tests for the behaviour it changes. Bug fixes come with a test that fails without the fix.
- Passes `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run test:py` and `npm run lint:py`. Changes to the container, LM Studio integration or sub-agents are also checked with the Docker suite, `npm run lmstudio:e2e` or `npm run agents:e2e`, as relevant.
- Updates the README, `docs/`, `.env.example` and `CHANGELOG.md` where behaviour or configuration changes, and regenerates `docs/TOOLS.md` and `docs/tools.json` when tool definitions change.
- Contains no secrets or private data: no API keys, tokens, private IP addresses or personal details, in the code, the tests or the description.

### Logs and transcripts

Log files in `logs/` and sub-agent transcripts in `logs/agent-runs/` can contain page content, URLs, text the agent typed, task texts, answers to sub-agent questions and model responses. With `LOG_REDACT_SECRETS=false` they also contain passwords, cookie values and credential headers. Never attach them to an issue or pull request unredacted, and never attach snapshot files. Paste only the lines that matter, and remove anything private first.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the license of this project.
