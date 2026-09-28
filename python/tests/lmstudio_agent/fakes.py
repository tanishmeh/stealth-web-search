"""Scripted stand-ins for the model servers, and a TCP proxy that can cut connections.

- FakeLmStudio: LM Studio's native model list and a scripted /v1/chat/completions that streams
  given chunks, answers with an HTTP error, or holds the stream open (as test/integration/
  lmstudio-agent.test.ts had it).
- FakeLlm: the OpenAI-compatible model the server's sub-agents use (the port of
  test/helpers/fake-llm.ts): a policy looks at the request and returns the next assistant turn.
- TcpProxy: forwards to the MCP server until `cut()`, like a server that went away.

They run in threads, so they answer whether or not a test's event loop is running (the server's
sub-agents call the fake model on their own schedule).
"""

from __future__ import annotations

import contextlib
import json
import math
import random
import select
import socket
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL = "test/tool-model"


# ---------------------------------------------------------------------------
# HTTP plumbing shared by the fakes


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, handler: type[BaseHTTPRequestHandler]) -> None:
        super().__init__(("127.0.0.1", 0), handler)
        self.stopping = threading.Event()
        self.connections: set[socket.socket] = set()
        self.lock = threading.Lock()
        threading.Thread(target=self.serve_forever, name=type(handler).__name__, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"

    def close(self) -> None:
        self.stopping.set()
        self.shutdown()
        with self.lock:
            for conn in list(self.connections):
                with contextlib.suppress(OSError):
                    conn.shutdown(socket.SHUT_RDWR)
        self.server_close()


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: _Server

    def log_message(self, format: str, *args: object) -> None:
        pass

    def setup(self) -> None:
        super().setup()
        with self.server.lock:
            self.server.connections.add(self.connection)

    def finish(self) -> None:
        with self.server.lock:
            self.server.connections.discard(self.connection)
        with contextlib.suppress(OSError):
            super().finish()

    def body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def start_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def write_chunk(self, text: str) -> None:
        data = text.encode()
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def end_stream(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def wait_until_closed(self) -> None:
        """Hold the response open until the client disconnects or the fake closes."""
        while not self.server.stopping.is_set():
            readable, _, _ = select.select([self.connection], [], [], 0.02)
            if readable:
                try:
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        break  # the client closed the connection
                except OSError:
                    break
                time.sleep(0.02)
        self.close_connection = True


def _sse(chunk: Any) -> str:
    return f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n"


# ---------------------------------------------------------------------------
# LM Studio


@dataclass
class Stream:
    """A streamed reply: these chunks, then `data: [DONE]` (unless `keep_open`)."""

    chunks: list[Any]
    keep_open: bool = False


@dataclass
class Status:
    """An HTTP error reply."""

    status: int
    body: Any


@dataclass
class Hang:
    """Send these chunks, then hold the stream open."""

    chunks: list[Any] = field(default_factory=list)


Reply = Stream | Status | Hang
Script = Callable[[dict[str, Any], int], Reply]


def model_list(
    *, loaded: bool = True, vision: bool = False, reasoning: bool = True, context_length: int = 32768
) -> dict[str, Any]:
    capabilities: dict[str, Any] = {"vision": vision, "trained_for_tool_use": True}
    if reasoning:
        capabilities["reasoning"] = {"allowed_options": ["off", "low", "medium", "on"], "default": "on"}
    return {
        "models": [
            {
                "type": "llm",
                "key": MODEL,
                "loaded_instances": [{"id": MODEL, "config": {"context_length": context_length}}] if loaded else [],
                "capabilities": capabilities,
            }
        ]
    }


def choice(delta: dict[str, Any], finish_reason: str | None = None) -> dict[str, Any]:
    return {"choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}


USAGE = {
    "choices": [],
    "usage": {"prompt_tokens": 100, "completion_tokens": 10, "completion_tokens_details": {"reasoning_tokens": 4}},
}


def tool_call(name: str, args: str | dict[str, Any], call_id: str | None = None) -> Stream:
    """A streamed tool call, its arguments in a second delta (as LM Studio sends them)."""
    arg_text = args if isinstance(args, str) else json.dumps(args, separators=(",", ":"))
    call_id = call_id if call_id is not None else str(math.floor(random.random() * 1e9))
    return Stream(
        [
            choice({"role": "assistant", "reasoning_content": f"I will call {name}."}),
            choice({"content": "\n\n"}),
            choice(
                {
                    "tool_calls": [
                        {"index": 0, "id": call_id, "type": "function", "function": {"name": name, "arguments": ""}}
                    ]
                }
            ),
            choice({"tool_calls": [{"index": 0, "type": "function", "function": {"arguments": arg_text}}]}),
            choice({}, "tool_calls"),
            USAGE,
        ]
    )


def answer(text: str) -> Stream:
    return Stream([choice({"role": "assistant", "content": text}), choice({}, "stop"), USAGE])


class FakeLmStudio:
    """LM Studio's /api/v1/models and a scripted /v1/chat/completions."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.script: Script = lambda _body, _index: Status(500, {"error": "no script"})
        self.models: Any = model_list()
        self.errors: list[BaseException] = []
        """Exceptions raised by the script (a failed assertion in it): the test fails on them."""
        self._streams = 0
        self._lock = threading.Lock()
        fake = self

        class Handler(_Handler):
            def do_GET(self) -> None:
                self.body()
                if self.path == "/api/v1/models":
                    self.send_json(200, fake.models)
                else:
                    self.send_json(404, {"error": "not found"})

            def do_POST(self) -> None:
                raw = self.body()
                if self.path != "/v1/chat/completions":
                    self.send_json(404, {"error": "not found"})
                    return
                body = json.loads(raw)
                with fake._lock:
                    index = len(fake.requests)
                    fake.requests.append(body)
                try:
                    reply = fake.script(body, index)
                except Exception as exc:
                    fake.errors.append(exc)
                    self.send_json(500, {"error": f"script failed: {exc}"})
                    return
                if isinstance(reply, Status):
                    self.send_json(reply.status, reply.body)
                    return
                with fake._lock:
                    fake._streams += 1
                try:
                    self.start_stream()
                    for chunk in reply.chunks:
                        self.write_chunk(_sse(chunk))
                    if isinstance(reply, Hang) or reply.keep_open:
                        self.wait_until_closed()
                        return
                    self.write_chunk("data: [DONE]\n\n")
                    self.end_stream()
                except OSError:
                    self.close_connection = True
                finally:
                    with fake._lock:
                        fake._streams -= 1

        self._server = _Server(Handler)
        self.url = self._server.url

    def reset(self, script: Script | None = None, models: Any = None) -> None:
        self.requests = []
        if script is not None:
            self.script = script
        if models is not None:
            self.models = models

    def open_streams(self) -> int:
        with self._lock:
            return self._streams

    def close(self) -> None:
        self._server.close()


# ---------------------------------------------------------------------------
# The sub-agents' model (port of test/helpers/fake-llm.ts)


@dataclass
class FakeTurn:
    content: str | None = None
    reasoning: str | None = None
    tool_calls: list[tuple[str, dict[str, Any] | str]] = field(default_factory=list)
    """(name, arguments)"""
    delay_ms: int = 0
    status: int | None = None
    """Answer with this HTTP error instead."""
    error: str | None = None
    finish_reason: str | None = None


@dataclass
class FakeRequest:
    body: dict[str, Any]
    headers: dict[str, str]
    step: int
    """Assistant turns already in the conversation + 1."""
    messages: list[dict[str, Any]]
    tool_names: list[Any]
    last_tool_result: str | None
    """Content of the last tool message (the result of the previous call)."""


Policy = Callable[[FakeRequest], FakeTurn]


def _split(text: str, size: int) -> Iterable[str]:
    return (text[i : i + size] for i in range(0, len(text), size))


class FakeLlm:
    """A scripted OpenAI-compatible server answering like vLLM: streamed SSE with `reasoning`
    deltas and tool calls whose arguments arrive in pieces, or one JSON completion when stream is
    false. `url` ends in /v1."""

    def __init__(self, policy: Policy, *, model: str = "fake-model") -> None:
        self.policy = policy
        self.requests: list[FakeRequest] = []
        self._counter = 0
        self._lock = threading.Lock()
        fake = self

        class Handler(_Handler):
            def do_GET(self) -> None:
                self.body()
                if self.path.split("?")[0] == "/v1/models":
                    self.send_json(
                        200, {"object": "list", "data": [{"id": model, "object": "model", "owned_by": "test"}]}
                    )
                else:
                    self.send_json(404, {"error": {"message": "not found"}})

            def do_POST(self) -> None:
                raw = self.body()
                if self.path.split("?")[0] != "/v1/chat/completions":
                    self.send_json(404, {"error": {"message": "not found"}})
                    return
                try:
                    body = json.loads(raw)
                except ValueError:
                    self.send_json(400, {"error": {"message": "bad json"}})
                    return
                messages = body.get("messages") or []
                last_tool = next((m for m in reversed(messages) if m.get("role") == "tool"), None)
                request = FakeRequest(
                    body=body,
                    headers={k.lower(): v for k, v in self.headers.items()},
                    step=sum(1 for m in messages if m.get("role") == "assistant") + 1,
                    messages=messages,
                    tool_names=[(t.get("function") or {}).get("name") for t in body.get("tools") or []],
                    last_tool_result=last_tool.get("content") if last_tool else None,
                )
                fake.requests.append(request)
                try:
                    turn = fake.policy(request)
                except Exception as exc:
                    # a failed assertion in a policy: a non-retryable error so the run fails fast
                    turn = FakeTurn(status=400, error=str(exc))
                if turn.delay_ms:
                    time.sleep(turn.delay_ms / 1000)
                if turn.status and turn.status >= 400:
                    self.send_json(turn.status, {"error": {"message": turn.error or "error"}})
                    return
                with fake._lock:
                    fake._counter += 1
                    counter = fake._counter
                completion_id = f"chatcmpl-{counter}"
                calls = [
                    {
                        "id": f"call-{counter}-{i}",
                        "name": name,
                        "args": args if isinstance(args, str) else json.dumps(args, separators=(",", ":")),
                    }
                    for i, (name, args) in enumerate(turn.tool_calls)
                ]
                finish = turn.finish_reason or ("tool_calls" if calls else "stop")
                usage = {
                    "prompt_tokens": math.ceil(len(json.dumps(messages, separators=(",", ":"))) / 3.5),
                    "completion_tokens": 42,
                    "total_tokens": 0,
                    "completion_tokens_details": {"reasoning_tokens": 10},
                }
                if not body.get("stream"):
                    tool_calls = [
                        {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["args"]}}
                        for c in calls
                    ]
                    message = {
                        "role": "assistant",
                        "content": turn.content,
                        "reasoning": turn.reasoning,
                        "tool_calls": tool_calls,
                    }
                    self.send_json(
                        200,
                        {
                            "id": completion_id,
                            "object": "chat.completion",
                            "model": model,
                            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                            "usage": usage,
                        },
                    )
                    return

                def send(delta: dict[str, Any], finish_reason: str | None = None) -> None:
                    chunk = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "model": model,
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
                    }
                    self.write_chunk(_sse(chunk))

                try:
                    self.start_stream()
                    send({"role": "assistant", "content": ""})
                    for piece in _split(turn.reasoning or "", 7):
                        send({"reasoning": piece})
                    for piece in _split(turn.content or "", 9):
                        send({"content": piece})
                    for index, c in enumerate(calls):
                        send(
                            {
                                "tool_calls": [
                                    {"id": c["id"], "type": "function", "index": index, "function": {"name": c["name"]}}
                                ]
                            }
                        )
                        for piece in _split(c["args"], 11):
                            send({"tool_calls": [{"index": index, "function": {"arguments": piece}}]})
                    send({}, finish)
                    self.write_chunk(
                        _sse(
                            {
                                "id": completion_id,
                                "object": "chat.completion.chunk",
                                "model": model,
                                "choices": [],
                                "usage": usage,
                            }
                        )
                    )
                    self.write_chunk("data: [DONE]\n\n")
                    self.end_stream()
                except OSError:
                    self.close_connection = True

        self._server = _Server(Handler)
        self.url = f"{self._server.url}/v1"

    def close(self) -> None:
        self._server.close()


# ---------------------------------------------------------------------------
# TCP proxy


class TcpProxy:
    """Forwards 127.0.0.1:<port> to `target`; `cut()` closes it and every connection through it.
    `accepted` counts the TCP connections clients opened through it."""

    def __init__(self, host: str, port: int) -> None:
        self._target = (host, port)
        self.accepted = 0
        self._listener = socket.create_server(("127.0.0.1", 0))
        self._listener.settimeout(0.05)  # accept() notices cut() within this time
        self.port: int = self._listener.getsockname()[1]
        self._sockets: set[socket.socket] = set()
        self._lock = threading.Lock()
        self._cut = threading.Event()
        threading.Thread(target=self._accept, name="tcp-proxy", daemon=True).start()

    def _accept(self) -> None:
        while not self._cut.is_set():
            try:
                client, _ = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            client.settimeout(None)
            self.accepted += 1
            try:
                upstream = socket.create_connection(self._target)
            except OSError:
                client.close()
                continue
            with self._lock:
                closed = self._cut.is_set()
                if not closed:
                    self._sockets.update((client, upstream))
            if closed:
                client.close()
                upstream.close()
                return
            for src, dst in ((client, upstream), (upstream, client)):
                threading.Thread(target=self._pipe, args=(src, dst), daemon=True).start()

    def _pipe(self, src: socket.socket, dst: socket.socket) -> None:
        try:
            while data := src.recv(65536):
                dst.sendall(data)
        except OSError:
            pass
        finally:
            for s in (src, dst):
                with contextlib.suppress(OSError):
                    s.shutdown(socket.SHUT_RDWR)
                s.close()

    def cut(self) -> None:
        with self._lock:
            self._cut.set()
            sockets = list(self._sockets)
        self._listener.close()
        for s in sockets:
            with contextlib.suppress(OSError):
                s.shutdown(socket.SHUT_RDWR)
            s.close()
