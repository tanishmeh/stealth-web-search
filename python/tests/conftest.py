"""Shared fixtures for the Python test suite.

- `repo_root` and `site_dir` (test/fixtures/site, the fixture website shared with the TS suites).
- `ts_server`: starts the TypeScript server (`node src/main.ts`) with the safe environment of
  test/helpers/harness.ts, or uses MCP_URL when set. Integration tests request it; it skips when
  node or the Obscura binary is missing, and fails instead when CI or SWS_REQUIRE_INTEGRATION is set.
- `fixture_site`: the fixture website with the recording /echo form target.
- `python_env`: os.environ with python/src first on PYTHONPATH, for starting a tool as a subprocess
  (`[sys.executable, "-m", "sws_tools.<tool>", ...]`), so it runs this checkout's source.
- Async tests use anyio on asyncio: mark them with `@pytest.mark.anyio`.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from sws_tools._repo import repo_root as find_root
from sws_tools.fixture_site import FixtureSite, start_fixture_site
from sws_tools.ts_server import TsServer, node_binary, obscura_binary, start_ts_server

StartServer = Callable[..., TsServer]


SERVER_FIXTURES = frozenset({"ts_server", "ts_server_factory"})
SRC_DIR = Path(__file__).resolve().parents[1] / "src"


def _integration_required() -> bool:
    return bool(os.environ.get("CI") or os.environ.get("SWS_REQUIRE_INTEGRATION"))


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    # every test that starts the TS server is an integration test: `-m "not integration"` skips them
    for item in items:
        if SERVER_FIXTURES & set(getattr(item, "fixturenames", ())):
            item.add_marker(pytest.mark.integration)


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return find_root(Path(__file__).parent)


@pytest.fixture(scope="session")
def site_dir(repo_root: Path) -> Path:
    return repo_root / "test" / "fixtures" / "site"


@pytest.fixture(scope="session")
def python_env() -> dict[str, str]:
    current = os.environ.get("PYTHONPATH")
    return {**os.environ, "PYTHONPATH": os.pathsep.join([str(SRC_DIR), *([current] if current else [])])}


@pytest.fixture
def fixture_site(site_dir: Path) -> Iterator[FixtureSite]:
    with start_fixture_site(site_dir) as site:
        yield site


@pytest.fixture
def ts_server_factory(
    repo_root: Path, tmp_path_factory: pytest.TempPathFactory, request: pytest.FixtureRequest
) -> Iterator[StartServer]:
    """`start(env=None) -> TsServer`: a fresh server per call (for tests that need their own
    environment, e.g. AGENT_LLM_URL); every server is stopped at the end of the test."""
    missing = []
    if node_binary() is None:
        missing.append("node is not on PATH")
    if not os.environ.get("MCP_URL") and obscura_binary(repo_root) is None:
        missing.append("the Obscura binary is missing (npm run obscura:download)")
    if missing:
        message = "integration test needs the TypeScript server: " + "; ".join(missing)
        if _integration_required():
            pytest.fail(message)
        pytest.skip(message)

    started: list[TsServer] = []

    def start(env: dict[str, str] | None = None) -> TsServer:
        external = os.environ.get("MCP_URL")
        if external:
            server = TsServer.external(external)
        else:
            base = tmp_path_factory.mktemp(re.sub(r"[^\w-]", "_", request.node.name)[:40])
            # owner-only, like the mkdtemp folders of the TS harness
            (base / "logs").mkdir(mode=0o700)
            (base / "snapshots").mkdir(mode=0o700)
            server = start_ts_server(env, root=repo_root, log_dir=base / "logs", snapshots_dir=base / "snapshots")
        started.append(server)
        return server

    yield start
    for server in started:
        server.stop()


@pytest.fixture
def ts_server(ts_server_factory: StartServer) -> TsServer:
    """A running server with the default test environment."""
    return ts_server_factory()
