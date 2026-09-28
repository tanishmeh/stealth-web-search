"""scripts/setup_lmstudio.py beyond the black-box node test (test/unit/setup-lmstudio.test.ts).

The expected strings come from Node 24 (JSON.stringify, String(Number(...))): the script must
rewrite an mcp.json byte for byte as the earlier JavaScript version did.
"""

from __future__ import annotations

import json
import math
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from tests.scripts.helpers import SCRIPTS_DIR, load_script

SCRIPT = SCRIPTS_DIR / "setup_lmstudio.py"
setup = load_script("setup_lmstudio")


@pytest.mark.parametrize(
    ("value", "js"),
    [
        (1.0, "1"),
        (0.1, "0.1"),
        (1e-7, "1e-7"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (123456789012345680000.0, "123456789012345680000"),
        (0.000001, "0.000001"),
        (0.0000015, "0.0000015"),
        (1.5e300, "1.5e+300"),
        (-0.0, "0"),
        (5e-324, "5e-324"),
        (-3.75, "-3.75"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (0.1 + 0.2, "0.30000000000000004"),
        (123e-20, "1.23e-18"),
        (math.inf, "null"),
        (math.nan, "null"),
    ],
)
def test_numbers_are_written_like_javascript(value: float, js: str) -> None:
    assert setup.format_js_number(value) == js


@pytest.mark.parametrize(
    ("text", "js"),
    [
        ("1e3", 1000.0),
        ("0x10", 16.0),
        (" 42 ", 42.0),
        ("1.5", 1.5),
        ("", 0.0),
        ("+5", 5.0),
        ("-5", -5.0),
        ("0b11", 3.0),
        ("0o17", 15.0),
        (".5e1", 5.0),
        ("1.", 1.0),
        ("\u00a07\ufeff", 7.0),
        ("0X1f", 31.0),
        ("Infinity", math.inf),
        ("-Infinity", -math.inf),
        ("1e400", math.inf),
    ],
)
def test_number_parsing_follows_javascript_number(text: str, js: float) -> None:
    assert setup.js_number(text) == js


@pytest.mark.parametrize("text", ["abc", "1_000", "+0x10", "inf", "nan", "1e", "0x", "\uff11\uff12"])
def test_number_parsing_rejects_what_javascript_rejects(text: str) -> None:
    assert math.isnan(setup.js_number(text))


def test_json_matches_json_stringify() -> None:
    data = setup.parse_json(
        '{"b":1,"10":2,"2":3,"a":{"x":[1,{"1":true}],"4294967295":0,"4294967294":0,"01":1},'
        '"s":"\\u2028\\u0001\\ud800\\"\\\\/\\t","e":[],"o":{},"n":null}'
    )
    # integer-like keys first (up to 2**32 - 2), escapes, empty containers: as Node 24 prints them
    assert setup.to_json(data, 2) == (
        '{\n  "2": 3,\n  "10": 2,\n  "b": 1,\n  "a": {\n    "4294967294": 0,\n    "x": [\n      1,\n'
        '      {\n        "1": true\n      }\n    ],\n    "4294967295": 0,\n    "01": 1\n  },\n'
        '  "s": "\u2028\\u0001\\ud800\\"\\\\/\\t",\n  "e": [],\n  "o": {},\n  "n": null\n}'
    )
    assert setup.to_json(data) == (
        '{"2":3,"10":2,"b":1,"a":{"4294967294":0,"x":[1,{"1":true}],"4294967295":0,"01":1},'
        '"s":"\u2028\\u0001\\ud800\\"\\\\/\\t","e":[],"o":{},"n":null}'
    )
    with pytest.raises(ValueError, match="NaN"):
        setup.parse_json('{"x": NaN}')


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["--foo"], "Unknown option '--foo'"),
        (["-x"], "Unknown option '-x'"),
        (["pos"], "Unexpected argument 'pos'. This command does not take positional arguments"),
        (["--", "x"], "Unexpected argument 'x'"),
        (["--url"], "Option '--url <value>' argument missing"),
        (["--url", "-x"], "Option '--url' argument is ambiguous."),
        (["--remove=1"], "Option '--remove' does not take an argument"),
    ],
)
def test_option_errors_match_node_parse_args(argv: list[str], message: str) -> None:
    with pytest.raises(setup.UsageError) as err:
        setup.parse_argv(argv)
    assert str(err.value).startswith(message)


def test_option_values() -> None:
    assert setup.parse_argv(["--url=http://x/mcp", "--timeout", "1", "--timeout", "2", "-h", "--url", "-"]) == {
        "url": "-",
        "timeout": "2",
        "help": True,
    }


@pytest.mark.parametrize(
    ("url", "problem"),
    [
        ("http://127.0.0.1:8931/mcp", None),
        ("HTTPS://example.com/mcp", None),
        ("http://[::1]:8931/mcp", None),
        ("ftp://x", "must use http or https"),
        ("mailto:x@y", "must use http or https"),
        ("not a url", "is not a valid URL"),
        ("http://", "is not a valid URL"),
        ("http://127.0.0.1:99999/mcp", "is not a valid URL"),
        ("http://exa mple.com/mcp", "is not a valid URL"),
        # new URL()'s host rules: %-escapes decode (and must decode to a valid host) ...
        ("http://%zz/", "is not a valid URL"),
        ("http://%ff/", "is not a valid URL"),
        ("http://%2F/", "is not a valid URL"),
        ("http://%41/mcp", None),
        # ... and a host whose last label is a number must be a valid IPv4 address
        ("http://1.2.3.4.5/mcp", "is not a valid URL"),
        ("http://1.2.3.256/mcp", "is not a valid URL"),
        ("http://08/mcp", "is not a valid URL"),
        ("http://a.0x1f/mcp", "is not a valid URL"),
        ("http://4294967296/mcp", "is not a valid URL"),
        ("http://0x7f.1/mcp", None),
        ("http://1.2.3.4./mcp", None),
        ("http://4294967295/mcp", None),
        ("http://1.2.3.4.5.a/mcp", None),
        ("http://a.0x1g/mcp", None),
    ],
)
def test_url_checks(url: str, problem: str | None) -> None:
    result = setup.url_problem(url)
    assert result is None if problem is None else problem in (result or "")


def test_host_warnings_read_the_host_as_new_url_does() -> None:
    for url in ("http://LOCALHOST:8931/mcp", "http://%6Cocalhost:8931/mcp"):
        options = setup.parse(["--url", url, "--print"])
        assert options is not None
        assert options["url"] == url
        assert [w.split(" ")[0] for w in options["warnings"]] == ["localhost"]


def run(python: str, env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([python, str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=60)


def test_update_remove_and_unchanged(script_python: str, script_env: dict[str, str], tmp_path: Path) -> None:
    file = tmp_path / "mcp.json"
    added = run(script_python, script_env, "--config", str(file), "--url", "http://127.0.0.1:9000/mcp")
    assert added.returncode == 0, added.stderr
    assert added.stdout == (
        f'Added "stealth-web-search" in {file}.\n\n'
        "LM Studio reloads mcp.json automatically. In a chat, open the Integrations panel and enable mcp/stealth-web-search.\n"
        "Make sure the server is running: curl http://127.0.0.1:9000/healthz\n"
    )
    again = run(script_python, script_env, "--config", str(file), "--url", "http://127.0.0.1:9000/mcp")
    assert again.stdout == f'{file} already has "stealth-web-search" configured this way; nothing changed.\n'
    assert not list(tmp_path.glob("mcp.json.bak-*")), "an unchanged file gets no backup"

    removed = run(script_python, script_env, "--config", str(file), "--remove")
    assert removed.returncode == 0, removed.stderr
    assert removed.stdout.startswith(f'Removed "stealth-web-search" from {file} (backup: mcp.json.bak-')
    assert json.loads(file.read_text()) == {"mcpServers": {}}
    missing = run(script_python, script_env, "--config", str(file), "--remove")
    assert missing.stdout == f'"stealth-web-search" is not configured in {file}; nothing to do.\n'


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions")
def test_a_backup_keeps_the_permissions_of_a_private_file(
    script_python: str, script_env: dict[str, str], tmp_path: Path
) -> None:
    file = tmp_path / "mcp.json"
    file.write_text(
        '{"mcpServers":{"stealth-web-search":{"url":"http://127.0.0.1:8931/mcp","headers":{"Authorization":"Bearer old"}}}}'
    )
    file.chmod(0o600)
    res = run(script_python, script_env, "--config", str(file), "--no-token")
    assert res.returncode == 0, res.stderr
    (backup,) = tmp_path.glob("mcp.json.bak-*")
    assert stat.S_IMODE(backup.stat().st_mode) == 0o600, "the backup holds the old token"
    assert stat.S_IMODE(file.stat().st_mode) == 0o600
    assert "headers" not in json.loads(file.read_text())["mcpServers"]["stealth-web-search"]
    assert not list(tmp_path.glob("*.tmp-*"))


def test_turns_a_stdio_entry_into_a_url_entry(script_python: str, script_env: dict[str, str], tmp_path: Path) -> None:
    file = tmp_path / "mcp.json"
    file.write_text(
        '{"mcpServers":{"stealth-web-search":{"command":"node","args":["x"],"cwd":"/","env":{"A":"b"},'
        '"auth":{"client_secret":"zz"},"headers":{"authorization":"Bearer old","X-Other":"1"}}}}'
    )
    res = run(script_python, script_env, "--config", str(file), "--token", " new ")
    assert res.returncode == 0, res.stderr
    assert file.read_text() == (
        '{\n  "mcpServers": {\n    "stealth-web-search": {\n      "url": "http://127.0.0.1:8931/mcp",\n'
        '      "headers": {\n        "X-Other": "1",\n        "Authorization": "Bearer new"\n      },\n'
        '      "timeout": 180000,\n      "auth": {\n        "client_secret": "zz"\n      }\n    }\n  }\n}\n'
    )


def test_warnings_and_print(script_python: str, script_env: dict[str, str]) -> None:
    res = run(
        script_python, script_env, "--print", "--url", "http://localhost:8931/mcp", "--token", "t", "--timeout", "500"
    )
    assert res.returncode == 0, res.stderr
    assert res.stderr.splitlines() == [
        "warning: localhost can resolve to ::1 on macOS while the server listens on 127.0.0.1; prefer http://127.0.0.1:<port>/mcp.",
        "warning: --timeout is in milliseconds; 500 ms is too short for browser tools (recommended 180000).",
        "note: the deeplink contains your token in base64; do not share it.",
    ]
    # base64 of {"url":"http://localhost:8931/mcp","headers":{"Authorization":"Bearer t"},"timeout":500}, as encodeURIComponent writes it
    assert (
        "lmstudio://add_mcp?name=stealth-web-search&config=eyJ1cmwiOiJodHRwOi8vbG9jYWxob3N0Ojg5MzEvbWNwIiwiaGVhZGVycyI6eyJB"
        "dXRob3JpemF0aW9uIjoiQmVhcmVyIHQifSwidGltZW91dCI6NTAwfQ%3D%3D\n" in res.stdout
    )


def test_help_and_usage_errors(script_python: str, script_env: dict[str, str]) -> None:
    res = run(script_python, script_env, "--help")
    assert res.returncode == 0
    assert res.stdout.startswith("Usage: npm run lmstudio:setup -- [options]\n")
    bad = run(script_python, script_env, "--timeout", "1.5")
    assert bad.returncode == 2
    assert bad.stderr.startswith(
        'setup-lmstudio: --timeout must be a positive integer (milliseconds), got "1.5"\n\nUsage:'
    )


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions")
def test_reports_an_unwritable_folder(script_python: str, script_env: dict[str, str], tmp_path: Path) -> None:
    if os.geteuid() == 0:
        pytest.skip("root can write anywhere")
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        res = run(script_python, script_env, "--config", str(locked / "sub" / "mcp.json"))
    finally:
        locked.chmod(0o700)
    assert res.returncode == 1
    assert res.stderr.startswith("setup-lmstudio: cannot write ")
