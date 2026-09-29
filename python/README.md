# stealth-web-search-tools

Python tools for [Stealth Web Search](https://github.com/tanishmeh/stealth-web-search) that run outside the server: the LM Studio CLI agent host, the live end-to-end runners and the website builder. The MCP server stays in TypeScript (`src/`); these tools talk to it over HTTP.

| Command | npm script | What it does |
|---|---|---|
| `sws-lmstudio-agent` | `npm run lmstudio:agent` | LM Studio CLI agent host |
| `sws-lmstudio-e2e` | `npm run lmstudio:e2e` | LM Studio end-to-end scenarios |
| `sws-agents-e2e` | `npm run agents:e2e` | Live sub-agent scenarios |
| `sws-site` | `npm run site:build`, `npm run site:serve` | Website builder |
| `sws-tools` | | Lists the commands; `sws-tools info` shows which Python runs them |

Two more tools are single standard-library files for any Python 3.9 or newer, with no packages: `scripts/setup_lmstudio.py` (`npm run lmstudio:setup`) and `scripts/download_obscura.py` (`npm run obscura:download`).

## Setup

The package needs Python 3.10 or newer. Pick one:

- **uv** ([install](https://docs.astral.sh/uv/getting-started/installation/)): nothing else to do. The npm scripts run the tools with `uv run --project python`, which creates `python/.venv` from `uv.lock` on first use.
- **pip**: `npm run py:setup` creates `python/.venv` with the first Python 3.10+ it finds (set `PYTHON` to choose one) and installs the package with its dev tools (`pip install -e 'python[dev]'`), held to the versions of `uv.lock` by `constraints.txt`. Run it again after `pyproject.toml` changes. (With uv on PATH, `npm run py:setup` runs `uv sync` instead; `PYTHON` then picks uv's interpreter.)

The npm scripts go through `scripts/py.mjs`, which uses uv when it is installed, else `python/.venv`, else a Python that already has the package, and puts `python/src` first on `PYTHONPATH` so the checkout's source always runs. Arguments after `--` reach the tool unchanged, and its exit code is the script's.

## Development

```bash
npm run test:py                 # pytest, from python/ (arguments are passed on: npm run test:py -- -k fixture)
npm run test:py -- -m "not integration"   # skip the tests that start the TypeScript server
npm run lint:py                 # ruff check and format check, python/ and scripts/*.py
```

With the venv active, or through `uv run --project python`: `ruff format`, `ruff check --fix` and `mypy` (configured in `pyproject.toml`).

Integration tests start the real server (`node src/main.ts`) with the same safe environment as `test/helpers/harness.ts`, so they need Node 24 and the Obscura binary (`npm run obscura:download`). They are skipped when either is missing, except in CI. Set `MCP_URL` to test a server that is already running instead.

Layout: `src/sws_tools/<tool>/` holds each command (`cli.py` has its `main`), `src/sws_tools/ts_server.py` starts the TypeScript server, `src/sws_tools/fixture_site.py` serves the fixture website (`test/fixtures/site`), and `tests/` holds the pytest suite.

After changing dependencies in `pyproject.toml`, update the lock with `uv lock --project python`, export it for the pip route with `uv export --project python --locked --extra dev --no-hashes --no-emit-project -o python/constraints.txt` (run from the repository root), and commit both files. CI installs with `uv sync --locked` and fails when `constraints.txt` does not match `uv.lock`.
