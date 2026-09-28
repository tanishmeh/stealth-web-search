#!/usr/bin/env python3
"""Add, update or remove the Stealth Web Search server in LM Studio's mcp.json.

    npm run lmstudio:setup                       # add http://127.0.0.1:8931/mcp as "stealth-web-search"
    npm run lmstudio:setup -- --token s3cret     # server started with AUTH_TOKEN
    npm run lmstudio:setup -- --print            # show the JSON and an "Add to LM Studio" deeplink only
    npm run lmstudio:setup -- --remove

Other servers in the file are left untouched, a timestamped backup is written next to the file
before any change, and the result is 2-space indented JSON, byte for byte what JavaScript's
JSON.stringify(data, null, 2) writes, so LM Studio's own formatting is kept. LM Studio watches
the file and reloads it; no restart is needed.

Standard library only, for any Python 3.9 or newer (the macOS python3 works):
`python3 scripts/setup_lmstudio.py --help`.
"""

from __future__ import annotations

import base64
import contextlib
import copy
import json
import math
import os
import re
import shutil
import stat
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

DEFAULT_NAME = "stealth-web-search"
DEFAULT_URL = "http://127.0.0.1:8931/mcp"
DEFAULT_TIMEOUT_MS = 180_000

USAGE = f"""Usage: npm run lmstudio:setup -- [options]
   or: python3 scripts/setup_lmstudio.py [options]

Adds the Stealth Web Search server to LM Studio's mcp.json (or updates it).

Options:
  --url <url>        MCP endpoint (default {DEFAULT_URL})
  --name <name>      server key, lowercase kebab-case (default {DEFAULT_NAME}; LM Studio plugin id mcp/<name>)
  --token <token>    add "Authorization: Bearer <token>" (the server's AUTH_TOKEN)
  --no-token         remove a previously configured Authorization header
  --timeout <ms>     tool call timeout in milliseconds (default {DEFAULT_TIMEOUT_MS})
  --config <path>    mcp.json to edit (default: mcp.json in the LM Studio home named in
                     ~/.lmstudio-home-pointer, else ~/.lmstudio/mcp.json)
  --remove           remove the server entry
  --dry-run          show the resulting file without writing it
  --print            print the server JSON and an lmstudio://add_mcp deeplink; change nothing
  -h, --help"""

STRING_OPTIONS = ("url", "name", "token", "timeout", "config")
BOOLEAN_OPTIONS = ("no-token", "remove", "dry-run", "print", "help")
SHORT_OPTIONS = {"h": "help"}

NAME_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
SECRET_HEADER = re.compile(
    r"^(authorization|proxy-authorization|cookie|x-api-key|api-key)\Z|token|secret", re.IGNORECASE
)
AUTH_SCHEME = re.compile(r"^(Bearer|Basic|Token)\s+", re.IGNORECASE)
# JavaScript's String.prototype.trim() and Number() strip these (WhiteSpace and LineTerminator)
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
# encodeURIComponent leaves these unescaped (besides letters and digits)
URI_COMPONENT_SAFE = "-_.!~*'()"
# characters WHATWG URL parsing rejects in a host name
FORBIDDEN_HOST = re.compile(r"[\x00-\x20#/:<>?@\[\\\]^|\x7f]")


class UsageError(Exception):
    """A bad command line: exit code 2 with the usage text."""


class ConfigError(Exception):
    """mcp.json cannot be used; nothing was changed (exit code 1)."""


# ---------------------------------------------------------------- JavaScript-compatible values


def js_trim(text: str) -> str:
    return text.strip(JS_WHITESPACE)


def js_number(text: str) -> float:
    """JavaScript's Number(text): decimal, Infinity, 0x/0o/0b literals, '' is 0, anything else NaN."""
    s = js_trim(text)
    if not s:
        return 0.0
    if re.fullmatch(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)", s):
        return float(s)
    prefixed = re.fullmatch(r"0(?:([xX])([0-9a-fA-F]+)|([oO])([0-7]+)|([bB])([01]+))", s)
    if prefixed:
        digits = prefixed.group(2) or prefixed.group(4) or prefixed.group(6)
        base = 16 if prefixed.group(1) else 8 if prefixed.group(3) else 2
        try:
            return float(int(digits, base))
        except OverflowError:
            return math.inf
    return math.nan


def format_js_number(value: float) -> str:
    """Number.prototype.toString(): the shortest round-trip digits, in JavaScript's notation."""
    if math.isnan(value) or math.isinf(value):
        return "null"  # what JSON.stringify writes for them
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exp = repr(abs(value)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + (int(exp) if exp else 0)  # digits before the decimal point
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k, n = len(digits), point
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        text = "0." + "0" * -n + digits
    else:
        e = n - 1
        text = f"{digits[0]}{'.' + digits[1:] if k > 1 else ''}e{'+' if e > 0 else '-'}{abs(e)}"
    return sign + text


def _is_array_index(key: str) -> bool:
    return bool(re.fullmatch(r"0|[1-9][0-9]*", key)) and int(key) < 2**32 - 1


def _quote(text: str) -> str:
    # the same escapes as JSON.stringify: control characters, quote, backslash, and lone surrogates
    quoted = json.dumps(text, ensure_ascii=False)
    return re.sub("[\ud800-\udfff]", lambda m: f"\\u{ord(m.group()):04x}", quoted)


def to_json(value: Any, indent: int | None = None, _level: int = 0) -> str:
    """JSON.stringify(value, null, indent): JavaScript's key order (integer-like keys first),
    number formatting and string escapes, so an mcp.json written by LM Studio or by the earlier
    JavaScript version of this script is rewritten byte for byte."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)  # kept exact (JavaScript would round integers above 2**53)
    if isinstance(value, float):
        return format_js_number(value)
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, dict):
        keys = sorted((k for k in value if _is_array_index(k)), key=int) + [k for k in value if not _is_array_index(k)]
        items = [(_quote(k), to_json(value[k], indent, _level + 1)) for k in keys]
        if not items:
            return "{}"
        if indent is None:
            return "{" + ",".join(f"{k}:{v}" for k, v in items) + "}"
        inner = "\n" + " " * (indent * (_level + 1))
        return "{" + ",".join(f"{inner}{k}: {v}" for k, v in items) + "\n" + " " * (indent * _level) + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        parts = [to_json(v, indent, _level + 1) for v in value]
        if indent is None:
            return "[" + ",".join(parts) + "]"
        inner = "\n" + " " * (indent * (_level + 1))
        return "[" + ",".join(inner + p for p in parts) + "\n" + " " * (indent * _level) + "]"
    raise TypeError(f"cannot serialize {type(value).__name__}")


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


def parse_json(text: str) -> Any:
    """JSON.parse: like json.loads, but NaN and Infinity are errors as in JavaScript."""
    return json.loads(text, parse_constant=_reject_constant)


def serialize(data: Any) -> str:
    return to_json(data, 2) + "\n"


# ---------------------------------------------------------------- command line


def parse_argv(argv: list[str]) -> dict[str, Any]:
    """Node's util.parseArgs in strict mode: known options only, no positionals, the last one wins."""
    values: dict[str, Any] = {}
    args = list(argv)
    while args:
        arg = args.pop(0)
        if arg == "--":
            if args:
                raise UsageError(f"Unexpected argument '{args[0]}'. This command does not take positional arguments")
            break
        if arg.startswith("--"):
            name, has_value, value = arg[2:].partition("=")
            if name in STRING_OPTIONS:
                if not has_value:
                    if not args:
                        raise UsageError(f"Option '--{name} <value>' argument missing")
                    value = args.pop(0)
                    if len(value) > 1 and value.startswith("-"):
                        raise UsageError(
                            f"Option '--{name}' argument is ambiguous.\n"
                            f"Did you forget to specify the option argument for '--{name}'?\n"
                            f"To specify an option argument starting with a dash use '--{name}=-XYZ'."
                        )
                values[name] = value
            elif name in BOOLEAN_OPTIONS:
                if has_value:
                    raise UsageError(f"Option '--{name}' does not take an argument")
                values[name] = True
            else:
                raise UsageError(f"Unknown option '--{name}'")
        elif arg.startswith("-") and len(arg) > 1:
            for letter in arg[1:]:
                if letter not in SHORT_OPTIONS:
                    raise UsageError(f"Unknown option '-{letter}'")
                values[SHORT_OPTIONS[letter]] = True
        else:
            raise UsageError(f"Unexpected argument '{arg}'. This command does not take positional arguments")
    return values


def _ipv4_number(part: str) -> int | None:
    """The WHATWG IPv4 number parser: decimal, 0x hex or 0-prefixed octal; None when it is not one."""
    digits, radix = "0-9", 10
    if part[:2] in ("0x", "0X"):
        part, digits, radix = part[2:], "0-9a-fA-F", 16
    elif len(part) > 1 and part[0] == "0":
        part, digits, radix = part[1:], "0-7", 8
    if part == "":
        return 0 if radix != 10 else None
    return int(part, radix) if re.fullmatch(f"[{digits}]+", part) else None


def _bad_ipv4(host: str) -> bool:
    """A host that ends in a number must be a valid IPv4 address (the WHATWG host parser); True
    when it ends in one and is not."""
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    last = parts[-1]
    if not re.fullmatch(r"[0-9]+|0[xX][0-9a-fA-F]*", last):
        return False
    numbers = [_ipv4_number(p) for p in parts]
    if len(parts) > 4 or any(n is None for n in numbers):
        return True
    values = [n for n in numbers if n is not None]
    return any(n > 255 for n in values[:-1]) or values[-1] >= 256 ** (5 - len(values))


def url_host(raw: str) -> str:
    """The host of a URL as new URL() reads it for http(s): percent-decoded and lower-case. Raises
    ValueError for a host that is not valid UTF-8 once decoded."""
    host = urllib.parse.urlsplit(raw).hostname or ""
    return urllib.parse.unquote_to_bytes(host).decode("utf-8").lower()


def url_problem(raw: str) -> str | None:
    """None for a usable http(s) URL, else the error message (JavaScript's new URL() rules, roughly)."""
    invalid = f'--url is not a valid URL: "{raw}"'
    try:
        parts = urllib.parse.urlsplit(raw)
        parts.port  # noqa: B018 - raises ValueError for a bad port
    except ValueError:
        return invalid
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]*", parts.scheme or "-"):
        return invalid
    if parts.scheme.lower() not in ("http", "https"):
        return f'--url must use http or https, got "{raw}"'
    if (parts.hostname or "").startswith("[") or ":" in (parts.hostname or ""):
        return None  # an IPv6 address; urlsplit checked it
    try:
        host = url_host(raw)
    except ValueError:  # %-escapes that are not UTF-8
        return invalid
    # '%' is a forbidden host character too: an escape that does not decode (http://%zz/) stays invalid
    if not host or FORBIDDEN_HOST.search(host) or "%" in host or _bad_ipv4(host):
        return invalid
    return None


def parse(argv: list[str]) -> dict[str, Any] | None:
    """The options, or None for --help."""
    v = parse_argv(argv)
    if v.get("help"):
        return None

    name = v.get("name", DEFAULT_NAME)
    if not NAME_PATTERN.fullmatch(name) or len(name) > 100:
        raise UsageError(
            f'--name must be lowercase kebab-case (letters, digits and single dashes), got "{name}". '
            "LM Studio derives the plugin id mcp/<name> from it."
        )

    raw_url = v.get("url", DEFAULT_URL)
    problem = url_problem(raw_url)
    if problem:
        raise UsageError(problem)
    warnings = []
    hostname = url_host(raw_url)
    if hostname == "localhost":
        warnings.append(
            "localhost can resolve to ::1 on macOS while the server listens on 127.0.0.1; prefer http://127.0.0.1:<port>/mcp."
        )
    if hostname == "host.docker.internal":
        warnings.append(
            "host.docker.internal only resolves inside containers; LM Studio runs on the host and should use http://127.0.0.1:<port>/mcp."
        )

    timeout: float = DEFAULT_TIMEOUT_MS
    if "timeout" in v:
        number = js_number(v["timeout"])
        if not (math.isfinite(number) and number.is_integer() and number >= 1):
            raise UsageError(f'--timeout must be a positive integer (milliseconds), got "{v["timeout"]}"')
        timeout = int(number) if number < 2**53 else number
        if timeout < 1_000:
            warnings.append(
                f"--timeout is in milliseconds; {timeout} ms is too short for browser tools (recommended {DEFAULT_TIMEOUT_MS})."
            )

    if "token" in v and v.get("no-token"):
        raise UsageError("use either --token or --no-token, not both")
    if "token" in v and not js_trim(v["token"]):
        raise UsageError("--token must not be empty")
    if v.get("remove") and v.get("print"):
        raise UsageError("--remove and --print cannot be combined")

    config = v["config"] if "config" in v else os.path.join(lm_studio_home(), "mcp.json")
    return {
        "name": name,
        "url": raw_url,
        "token": js_trim(v["token"]) if "token" in v else None,
        "clear_token": bool(v.get("no-token")),
        "timeout": timeout,
        "config_path": os.path.abspath(config),
        "remove": bool(v.get("remove")),
        "dry_run": bool(v.get("dry-run")),
        "print": bool(v.get("print")),
        "warnings": warnings,
    }


def lm_studio_home() -> str:
    """LM Studio's home: the path LM Studio records in ~/.lmstudio-home-pointer, else ~/.lmstudio
    (LM Studio has no environment variable for it)."""
    home = str(Path.home())
    try:
        pointed = js_trim(Path(home, ".lmstudio-home-pointer").read_text(encoding="utf-8"))
        if pointed and os.path.isabs(pointed):
            return pointed
    except (OSError, UnicodeDecodeError):
        pass  # no pointer file: default location
    return os.path.join(home, ".lmstudio")


# ---------------------------------------------------------------- mcp.json


def read_config(file: str) -> dict[str, Any]:
    if not os.path.exists(file):
        return {"exists": False, "raw": None, "data": {"mcpServers": {}}}
    try:
        raw = Path(file).read_bytes().decode("utf-8")
    except UnicodeDecodeError as err:
        raise ConfigError(f"{file} is not valid UTF-8 text ({err}); nothing was changed.") from None
    except OSError as err:
        raise ConfigError(f"cannot read {file}: {err.strerror or err}") from None
    if not js_trim(raw):
        return {"exists": True, "raw": raw, "data": {"mcpServers": {}}}
    try:
        data = parse_json(raw)
    except ValueError as err:  # json.JSONDecodeError included
        raise ConfigError(
            f"{file} is not valid JSON ({err}). Fix it in LM Studio (Program > Install > Edit mcp.json) "
            "or pass --config; nothing was changed."
        ) from None
    if not isinstance(data, dict):
        raise ConfigError(f"{file} must contain a JSON object; nothing was changed.")
    data.setdefault("mcpServers", {})
    if not isinstance(data["mcpServers"], dict):
        raise ConfigError(f'"mcpServers" in {file} must be an object; nothing was changed.')
    return {"exists": True, "raw": raw, "data": data}


def build_entry(existing: Any, opts: dict[str, Any]) -> dict[str, Any]:
    # Keep fields we do not manage (for example "auth"), but drop stdio fields:
    # LM Studio treats any entry with "command" as a stdio server.
    entry = dict(existing) if isinstance(existing, dict) else {}
    for key in ("command", "args", "cwd", "env"):
        entry.pop(key, None)
    headers = dict(entry["headers"]) if isinstance(entry.get("headers"), dict) else {}
    for key in list(headers):
        if key.lower() == "authorization" and (opts["token"] or opts["clear_token"]):
            del headers[key]
    if opts["token"]:
        headers["Authorization"] = f"Bearer {opts['token']}"
    for key in ("url", "headers", "timeout"):
        entry.pop(key, None)
    # stable, readable key order: url, headers, timeout, then the rest
    ordered: dict[str, Any] = {"url": opts["url"]}
    if headers:
        ordered["headers"] = headers
    ordered["timeout"] = opts["timeout"]
    ordered.update(entry)
    return ordered


def timestamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def redact_config(data: dict[str, Any]) -> dict[str, Any]:
    """Copy of an mcp.json object with header, env and OAuth secrets masked, for printing."""
    masked = copy.deepcopy(data)
    servers = masked.get("mcpServers")
    for entry in servers.values() if isinstance(servers, dict) else ():
        if not isinstance(entry, dict):
            continue
        headers = entry.get("headers")
        if isinstance(headers, dict):
            for key, value in list(headers.items()):
                if not isinstance(value, str) or not SECRET_HEADER.search(key):
                    continue
                scheme = AUTH_SCHEME.match(value)
                headers[key] = f"{scheme.group(0) if scheme else ''}<redacted>"
        env = entry.get("env")
        if isinstance(env, dict):
            for key in env:
                env[key] = "<redacted>"
        elif isinstance(env, list):
            entry["env"] = ["<redacted>"] * len(env)
        auth = entry.get("auth")
        if isinstance(auth, dict):
            for key in auth:
                if re.search("secret", key, re.IGNORECASE):
                    auth[key] = "<redacted>"
    return masked


def write_target(file: str) -> str:
    """The file that really holds the config: follow a symlink (dotfile managers) instead of
    replacing it, including one whose target does not exist yet."""
    path = file
    for _ in range(40):
        try:
            st = os.lstat(path)
        except OSError:
            return path  # missing: write here
        if not stat.S_ISLNK(st.st_mode):
            return path
        real = os.path.realpath(path)
        if os.path.exists(real):
            return real
        path = os.path.normpath(os.path.join(os.path.dirname(path), os.readlink(path)))  # dangling: one hop
    return file


def _binary_flag() -> int:
    return getattr(os, "O_BINARY", 0)


def copy_with_mode(src: str, dst: str) -> None:
    """copyFileSync: the copy gets the source's permissions (a backup of a private file stays private)."""
    mode = stat.S_IMODE(os.stat(src).st_mode)
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _binary_flag(), 0o600)
    with os.fdopen(fd, "wb") as out, open(src, "rb") as source:
        shutil.copyfileobj(source, out)
    os.chmod(dst, mode)


def write_atomically(target: str, text: str, mode: int) -> None:
    tmp = f"{target}.tmp-{os.getpid()}"
    with contextlib.suppress(FileNotFoundError):
        os.unlink(tmp)  # a leftover from an interrupted run
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _binary_flag(), 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(text.encode("utf-8"))
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


# ---------------------------------------------------------------- main


def run(argv: list[str]) -> int:
    try:
        opts = parse(argv)
    except UsageError as err:
        sys.stderr.write(f"setup-lmstudio: {err}\n\n{USAGE}\n")
        return 2
    if opts is None:
        sys.stdout.write(f"{USAGE}\n")
        return 0
    for warning in opts["warnings"]:
        sys.stderr.write(f"warning: {warning}\n")
    name, config_path = opts["name"], opts["config_path"]

    if opts["print"]:
        entry = build_entry(None, opts)
        config = base64.b64encode(to_json(entry).encode("utf-8")).decode("ascii")
        query = f"name={urllib.parse.quote(name, safe=URI_COMPONENT_SAFE)}&config={urllib.parse.quote(config, safe=URI_COMPONENT_SAFE)}"
        sys.stdout.write(
            f"mcp.json entry (LM Studio > Program > Install > Edit mcp.json):\n\n{serialize({'mcpServers': {name: entry}})}\n"
            f"Add to LM Studio deeplink (open it in a browser or with `open` on macOS):\n\nlmstudio://add_mcp?{query}\n\n"
            f"Web install page:\n\nhttps://lmstudio.ai/install-mcp?{query}\n"
        )
        if opts["token"]:
            sys.stderr.write("note: the deeplink contains your token in base64; do not share it.\n")
        return 0

    try:
        current = read_config(config_path)
    except ConfigError as err:
        sys.stderr.write(f"setup-lmstudio: {err}\n")
        return 1
    data = copy.deepcopy(current["data"])
    servers = data["mcpServers"]
    had = name in servers

    if opts["remove"]:
        if not had:
            sys.stdout.write(f'"{name}" is not configured in {config_path}; nothing to do.\n')
            return 0
        del servers[name]
    else:
        servers[name] = build_entry(servers[name] if had else None, opts)

    output = serialize(data)
    if (
        current["exists"]
        and current["raw"] is not None
        and to_json(current["data"]) == to_json(data)
        and current["raw"] == output
    ):
        sys.stdout.write(f'{config_path} already has "{name}" configured this way; nothing changed.\n')
        return 0

    action = f'remove "{name}" from' if opts["remove"] else f'{"update" if had else "add"} "{name}" in'
    if opts["dry_run"]:
        sys.stdout.write(
            f"Dry run: would {action} {config_path}{'' if current['exists'] else ' (new file)'} "
            f"(secrets shown as <redacted>):\n\n{serialize(redact_config(data))}"
        )
        return 0

    target = write_target(config_path)
    backup = None
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if current["exists"]:
            backup = f"{target}.bak-{timestamp()}"
            i = 1
            while os.path.lexists(backup):
                backup = f"{target}.bak-{timestamp()}-{i}"
                i += 1
            copy_with_mode(target, backup)
        # Keep the file's permissions, but never leave a bearer token readable by other users.
        mode = stat.S_IMODE(os.stat(target).st_mode) if current["exists"] else 0o644
        headers = servers.get(name, {}).get("headers") if not opts["remove"] else None
        holds_token = isinstance(headers, dict) and any(k.lower() == "authorization" for k in headers)
        if holds_token and mode & 0o077:
            mode = (mode & 0o700) | 0o600
            sys.stdout.write(f"note: {target} now holds a token, so it is made readable by you only (mode {mode:o}).\n")
        write_atomically(target, output, mode)
    except OSError as err:
        where = err.filename or target
        sys.stderr.write(f"setup-lmstudio: cannot write {where}: {err.strerror or err}\n")
        return 1

    verb = "Removed" if opts["remove"] else "Updated" if had else "Added"
    link = f" (symlink to {target})" if target != config_path else ""
    saved = f" (backup: {os.path.basename(backup)})" if backup else ""
    sys.stdout.write(f'{verb} "{name}" {"from" if opts["remove"] else "in"} {config_path}{link}{saved}.\n')
    if not opts["remove"]:
        server = re.sub(r"/mcp/?\Z", "", opts["url"])
        sys.stdout.write(
            f"\nLM Studio reloads mcp.json automatically. In a chat, open the Integrations panel and enable mcp/{name}.\n"
            f"Make sure the server is running: curl {server}/healthz\n"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):  # not a text stream
            stream.reconfigure(errors="backslashreplace")  # type: ignore[attr-defined]
    try:
        return run(sys.argv[1:] if argv is None else argv)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
