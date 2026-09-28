"""LM Studio's API: the model list (native /api/v1/models) and streaming chat completions
(OpenAI-compatible /v1/chat/completions)."""

from __future__ import annotations

import codecs
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import anyio
import httpx2

from ._js import is_array_index, js_json, js_parse, js_round, js_slice, js_string, js_trim, js_truthy
from .abort import AbortSignal, abortable
from .errors import AgentError, HttpStatusError, error_code, error_message

MODELS_TIMEOUT_S = 15.0


@dataclass
class ModelInfo:
    id: str
    listed: bool
    """LM Studio knows this model (False: an id passed explicitly that is not in the model list)."""
    loaded: bool
    vision: bool
    tool_use: bool
    reasoning: list[Any] | None
    context_length: Any = None
    key: Any = None


@dataclass
class Completion:
    content: str = ""
    reasoning: str = ""
    tool_calls: list[dict[str, str]] = field(default_factory=list)
    """[{"id", "name", "arguments"}] in index order."""
    finish_reason: Any = None
    usage: Any = None
    reasoning_streamed: bool = False


def auth_headers(token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


def lmstudio_unreachable(base: str, exc: BaseException) -> AgentError:
    code = error_code(exc) or error_message(exc)
    return AgentError(
        f"Cannot reach LM Studio at {base} ({code}). Start the local server (LM Studio > Developer > Start Server, or "
        "`~/.lmstudio/bin/lms server start`) and use 127.0.0.1 rather than localhost. Override with LMSTUDIO_URL.",
        transient=True,
    )


def strip_slashes(url: str) -> str:
    return re.sub(r"/+$", "", url)


def _get(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else None


def _first(items: Any) -> Any:
    return items[0] if isinstance(items, list) and items else None


async def list_models(http: httpx2.AsyncClient, lmstudio_url: str, token: str | None) -> list[ModelInfo] | None:
    """LLMs known to LM Studio with their capabilities; None when the native model list is unavailable."""
    base = strip_slashes(lmstudio_url)
    try:
        with anyio.fail_after(MODELS_TIMEOUT_S):
            res = await http.get(f"{base}/api/v1/models", headers=auth_headers(token), follow_redirects=True)
    except (httpx2.HTTPError, httpx2.InvalidURL, OSError, TimeoutError) as exc:
        raise lmstudio_unreachable(base, exc) from exc
    if res.status_code in (401, 403):
        raise AgentError(
            f'LM Studio rejected the request (HTTP {res.status_code}). "Require Authentication" is on: '
            "set LM_API_TOKEN to an API token."
        )
    try:
        body = js_parse(res.content.decode("utf-8", "replace"))
    except ValueError:
        body = None
    models = _get(body, "models")
    if res.status_code != 200 or not isinstance(models, list):
        return None
    out: list[ModelInfo] = []
    for m in models:
        if _get(m, "type") != "llm":
            continue
        instances = _get(m, "loaded_instances")
        first = _first(instances)
        caps = _get(m, "capabilities")
        options = _get(_get(caps, "reasoning"), "allowed_options")
        instance_id = _get(first, "id")
        out.append(
            ModelInfo(
                id=instance_id if instance_id is not None else _get(m, "key"),
                listed=True,
                loaded=isinstance(instances, list) and len(instances) > 0,
                vision=bool(_get(caps, "vision")),
                tool_use=bool(_get(caps, "trained_for_tool_use")),
                reasoning=options if isinstance(options, list) else None,
                context_length=_get(_get(first, "config"), "context_length"),
                key=_get(m, "key"),
            )
        )
    return out


async def resolve_model(
    http: httpx2.AsyncClient, lmstudio_url: str, token: str | None, requested: str | None = None
) -> ModelInfo:
    models = await list_models(http, lmstudio_url, token)
    if requested:
        for m in models or []:
            if requested in (m.id, m.key):
                return ModelInfo(
                    id=requested,
                    listed=m.listed,
                    loaded=m.loaded,
                    vision=m.vision,
                    tool_use=m.tool_use,
                    reasoning=m.reasoning,
                    context_length=m.context_length,
                    key=m.key,
                )
        return ModelInfo(id=requested, listed=False, loaded=False, vision=False, tool_use=True, reasoning=None)
    if models is None:
        raise AgentError(
            "Could not list models from LM Studio (GET /api/v1/models needs LM Studio 0.4 or newer). "
            "Pass --model <id> or set LMSTUDIO_MODEL."
        )
    loaded = [m for m in models if m.loaded and m.tool_use]
    if loaded:
        return loaded[0]
    installed = [js_string(m.key) for m in models if m.tool_use]
    if installed:
        raise AgentError(
            "No loaded LM Studio model is trained for tool use. Load one first, e.g. "
            f"`~/.lmstudio/bin/lms load {installed[0]} --context-length 32768`, or pass --model {installed[0]} "
            f"(LM Studio loads it on demand). Tool-capable models installed: {', '.join(installed)}."
        )
    raise AgentError(
        "No tool-capable LLM is installed in LM Studio. Download one trained for tool use (for example a Qwen3 model) "
        "and load it with a context length of at least 32k, or pass --model <id>."
    )


_CONTEXT = re.compile(r"context|n_ctx|too long|exceed", re.I | re.A)
_MODEL = re.compile(r"model", re.I | re.A)
_NOT_FOUND = re.compile(r"not found|no model", re.I | re.A)


def describe_lmstudio_error(status: int, body: str) -> str:
    message = body
    try:
        parsed = js_parse(body)
    except ValueError:
        pass
    else:
        error = _get(parsed, "error")
        if isinstance(error, str):
            message = error
        elif isinstance(error, dict) and error.get("message") is not None:
            message = js_string(error["message"])
    message = js_slice(message, 0, 1000)
    if status in (401, 403):
        return f"LM Studio rejected the request (HTTP {status}): {message}. Set LM_API_TOKEN."
    if _CONTEXT.search(message):
        return (
            f"LM Studio: {message}. The conversation no longer fits the model context: reload the model with a "
            "larger context length (32k or more) or lower --max-result-chars."
        )
    if status == 404 or (_MODEL.search(message) and _NOT_FOUND.search(message)):
        return f"LM Studio: {message}. Check the model id with `~/.lmstudio/bin/lms ls` or omit --model to use the loaded one."
    return f"LM Studio HTTP {status}: {message}"


class _StreamParser:
    """Accumulates a streamed completion from SSE `data:` events, like the TS parser did."""

    def __init__(self, on_reasoning: Callable[[str], None]) -> None:
        self.out = Completion()
        self.calls: dict[float, dict[str, str]] = {}
        self._on_reasoning = on_reasoning

    def event(self, data: str) -> None:
        if data == "[DONE]":
            return
        try:
            chunk = js_parse(data)
        except ValueError:
            return
        error = _get(chunk, "error")
        if js_truthy(error):
            msg = error if isinstance(error, str) else error.get("message") if isinstance(error, dict) else None
            text = js_string(msg) if msg is not None else js_json(error)
            raise HttpStatusError(500, describe_lmstudio_error(500, js_json({"error": text})))
        usage = _get(chunk, "usage")
        if js_truthy(usage):
            self.out.usage = usage
        choice = _first(_get(chunk, "choices"))
        if not js_truthy(choice):
            return
        delta = _get(choice, "delta")
        if delta is None:
            delta = _get(choice, "message")
        if delta is None:
            delta = {}
        reasoning = _get(delta, "reasoning_content")
        if reasoning is None:
            reasoning = _get(delta, "reasoning")
        if isinstance(reasoning, str) and reasoning:
            self.out.reasoning += reasoning
            self.out.reasoning_streamed = True
            self._on_reasoning(reasoning)
        content = _get(delta, "content")
        if isinstance(content, str):
            self.out.content += content
        tool_calls = _get(delta, "tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                index = _get(tc, "index")
                if not isinstance(index, (int, float)) or isinstance(index, bool):
                    index = len(self.calls)
                entry = self.calls.get(index) or {"id": "", "name": "", "arguments": ""}
                tc_id = _get(tc, "id")
                if js_truthy(tc_id):
                    entry["id"] = js_string(tc_id)
                function = _get(tc, "function")
                name = _get(function, "name")
                if js_truthy(name):
                    entry["name"] += js_string(name)
                arguments = _get(function, "arguments")
                if isinstance(arguments, str):
                    entry["arguments"] += arguments
                elif isinstance(arguments, (dict, list)):
                    entry["arguments"] = js_json(arguments)
                self.calls[index] = entry
        finish = _get(choice, "finish_reason")
        if js_truthy(finish):
            self.out.finish_reason = finish

    def json_body(self, text: str) -> None:
        """A non-streamed JSON completion (a server that ignores stream: true)."""
        try:
            parsed = js_parse(text)
        except ValueError as exc:
            raise AgentError(f"LM Studio returned invalid JSON: {exc}") from exc
        choice = _first(_get(parsed, "choices"))
        message = _get(choice, "message")
        if message is None:
            message = {}
        content = _get(message, "content")
        self.out.content = "" if content is None else js_string(content)
        reasoning = _get(message, "reasoning_content")
        self.out.reasoning = "" if reasoning is None else js_string(reasoning)
        self.out.finish_reason = _get(choice, "finish_reason")
        self.out.usage = _get(parsed, "usage")
        tool_calls = _get(message, "tool_calls")
        for i, tc in enumerate(tool_calls if isinstance(tool_calls, list) else []):
            function = _get(tc, "function")
            name = _get(function, "name")
            arguments = _get(function, "arguments")
            tc_id = _get(tc, "id")
            self.calls[i] = {
                "id": js_string("" if tc_id is None else tc_id),
                "name": "" if name is None else js_string(name),
                "arguments": arguments
                if isinstance(arguments, str)
                else js_json({} if arguments is None else arguments),
            }

    def finish(self) -> Completion:
        self.out.tool_calls = [self.calls[k] for k in sorted(self.calls)]
        return self.out


class BodyEncoder:
    """JSON.stringify of chat request bodies, reusing the JSON of the tool list and of messages that
    did not change since the previous step (the history grows by a few messages per step, and
    compact_history replaces a message's content rather than editing it)."""

    def __init__(self) -> None:
        self._messages: dict[int, tuple[Any, Any, str]] = {}
        self._tools: tuple[Any, str] | None = None

    def _message(self, message: Any) -> str:
        if not isinstance(message, dict):
            return js_json(message)
        content, tool_calls = message.get("content"), message.get("tool_calls")
        hit = self._messages.get(id(message))
        if hit is not None and hit[0] is content and hit[1] is tool_calls:
            return hit[2]
        text = js_json(message)
        self._messages[id(message)] = (content, tool_calls, text)
        return text

    def _value(self, key: str, value: Any) -> str:
        if key == "messages" and isinstance(value, list):
            return "[" + ",".join(self._message(m) for m in value) + "]"
        if key == "tools" and isinstance(value, list):
            if self._tools is None or self._tools[0] is not value:
                self._tools = (value, js_json(value))
            return self._tools[1]
        return js_json(value)

    def encode(self, body: dict[str, Any]) -> str:
        if any(is_array_index(key) for key in body):
            return js_json(body)  # JSON.stringify would reorder these keys
        return "{" + ",".join(f"{js_json(key)}:{self._value(key, value)}" for key, value in body.items()) + "}"


def url_origin(url: str) -> str:
    """URL.origin: scheme://host[:port], without credentials, path or a default port."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    try:
        port = parts.port
    except ValueError:
        port = None
    default = {"http": 80, "https": 443}.get(parts.scheme)
    return f"{parts.scheme}://{host}{'' if port in (None, default) else f':{port}'}"


async def _stream(
    http: httpx2.AsyncClient,
    url: str,
    payload: bytes,
    token: str | None,
    parser: _StreamParser,
    idle_timeout_s: float,
) -> Completion:
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        # no compression, as with Node's http.request: a compressing server may hold back stream chunks
        "Accept-Encoding": "identity",
        **auth_headers(token),
    }
    responded = False
    try:
        async with http.stream("POST", url, content=payload, headers=headers, timeout=idle_timeout_s) as res:
            responded = True
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            if res.status_code >= 400:
                raw = b"".join([chunk async for chunk in res.aiter_bytes()])
                text = raw.decode("utf-8", "replace")
                raise HttpStatusError(res.status_code, describe_lmstudio_error(res.status_code, text))
            is_json = re.search(r"application/json", res.headers.get("content-type", ""), re.I) is not None
            buffer = ""
            async for chunk in res.aiter_bytes():
                buffer += decoder.decode(chunk)
                if is_json:
                    continue
                while (idx := buffer.find("\n")) >= 0:
                    line = buffer[:idx]
                    if line.endswith("\r"):
                        line = line[:-1]
                    buffer = buffer[idx + 1 :]
                    if line.startswith("data:"):
                        parser.event(js_trim(line[5:]))
            buffer += decoder.decode(b"", final=True)
            if is_json:
                parser.json_body(buffer)
            elif buffer.startswith("data:"):
                parser.event(js_trim(buffer[5:]))
    except AgentError:
        raise
    except httpx2.TimeoutException as exc:
        raise AgentError(f"LM Studio sent nothing for {js_round(idle_timeout_s)} s") from exc
    except (httpx2.HTTPError, httpx2.InvalidURL, OSError) as exc:
        if not responded:
            raise lmstudio_unreachable(url_origin(url), exc) from exc
        # the connection broke while the response streamed
        raise AgentError(f"LM Studio closed the connection: {error_message(exc)}") from exc
    return parser.finish()


async def stream_chat_completion(
    http: httpx2.AsyncClient,
    lmstudio_url: str,
    token: str | None,
    body: dict[str, Any],
    on_reasoning: Callable[[str], None],
    signal: AbortSignal | None,
    idle_timeout_s: float,
    encoder: BodyEncoder | None = None,
) -> Completion:
    """One streamed chat completion. Aborting `signal` closes the request and raises AgentError("aborted").
    Pass the same `encoder` for every step of a conversation to reuse the JSON of what did not change."""
    url = f"{strip_slashes(lmstudio_url)}/v1/chat/completions"
    full = {**body, "stream": True, "stream_options": {"include_usage": True}}
    payload = (encoder.encode(full) if encoder else js_json(full)).encode("utf-8")
    parser = _StreamParser(on_reasoning)
    return await abortable(
        signal,
        lambda: _stream(http, url, payload, token, parser, idle_timeout_s),
        lambda: AgentError("aborted"),
    )
