"""What a run is given: the options of the agent loop (no heavy imports, so the CLI starts fast)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .abort import AbortSignal

DEFAULT_MCP_URL = "http://127.0.0.1:8931/mcp"
DEFAULT_LMSTUDIO_URL = "http://127.0.0.1:1234"
REASONING_MODES = ("none", "low", "medium", "high", "on")
Ask = Callable[[str], Awaitable[str | None]]


@dataclass
class AgentOptions:
    task: str
    mcp_url: str | None = None
    """Streamable HTTP endpoint of the Stealth Web Search server."""
    auth_token: str | None = None
    """Bearer token for the MCP server (its AUTH_TOKEN)."""
    lmstudio_url: str | None = None
    lm_api_token: str | None = None
    """LM Studio API token, when "Require Authentication" is enabled."""
    model: str | None = None
    """Model id; default: the first loaded LLM trained for tool use."""
    max_steps: float | None = None
    reasoning: str | None = None
    """Reasoning effort (none, low, medium, high); "on" leaves the model default."""
    tools: list[str] | None = None
    """Only offer these tools to the model."""
    toolsets: list[str] | None = None
    """Only offer tools from these groups or with these names (core, content, ..., or all)."""
    vision: bool | None = None
    """Forward screenshots to the model as images (default: when the model supports vision)."""
    temperature: float | None = None
    max_tokens: float | None = None
    """Output token limit per model response, reasoning included."""
    max_result_chars: float | None = None
    """Tool results longer than this are truncated before they reach the model."""
    tool_timeout_ms: float | None = None
    instructions: str | None = None
    """Extra instructions appended to the system prompt."""
    client_name: str | None = None
    """MCP client name (shown in server logs and on the dashboard)."""
    quiet: bool | None = None
    """Print only the final answer."""
    ask: Ask | None = None
    """Ask the user and return their reply (None or "" when there is none); makes the run interactive."""
    write: Callable[[str], None] | None = None
    """Where transcript text goes (default: stdout)."""
    color: bool | None = None
    signal: AbortSignal | None = None
