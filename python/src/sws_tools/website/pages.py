"""What the website is made of: the site constants and the documents, in navigation order."""

from __future__ import annotations

from dataclasses import dataclass

NAME = "Stealth Web Search"
REPO = "https://github.com/tanishmeh/stealth-web-search"
SITE = "https://tanishmeh.github.io/stealth-web-search/"
MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.esm.min.mjs"
LM_STUDIO_INSTALL = (
    "https://lmstudio.ai/install-mcp?name=stealth-web-search"
    "&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg5MzEvbWNwIiwidGltZW91dCI6MTgwMDAwfQ%3D%3D"
)


@dataclass(frozen=True)
class Page:
    src: str
    """The Markdown file, relative to the repository root."""
    slug: str
    """The page is docs/<slug>.html."""
    nav: str
    """Its name in the sidebar and the pager."""


@dataclass(frozen=True)
class Group:
    title: str
    pages: tuple[Page, ...]


# Add a new document here; links to it from other documents then become links between pages.
GROUPS: tuple[Group, ...] = (
    Group(
        "Start here",
        (
            Page("docs/GETTING_STARTED.md", "getting-started", "Getting started"),
            Page("docs/CLIENTS.md", "clients", "Connect MCP clients"),
            Page("docs/LM_STUDIO.md", "lm-studio", "LM Studio"),
        ),
    ),
    Group(
        "Configure",
        (
            Page("docs/CONFIGURATION.md", "configuration", "Configuration"),
            Page("docs/MODELS.md", "models", "Model config (models.json)"),
        ),
    ),
    Group(
        "Use",
        (
            Page("docs/AGENTS.md", "agents", "Sub-agents and scripts"),
            Page("docs/SNAPSHOTS.md", "snapshots", "Snapshots (saved sign-ins)"),
            Page("docs/TOOLS.md", "tools", "Tool reference"),
        ),
    ),
    Group(
        "Operate",
        (
            Page("docs/LOGGING.md", "logging", "Logging"),
            Page("docs/TROUBLESHOOTING.md", "troubleshooting", "Troubleshooting"),
            Page("docs/ARCHITECTURE.md", "architecture", "Architecture"),
        ),
    ),
    Group(
        "Project",
        (
            Page("CONTRIBUTING.md", "contributing", "Contributing"),
            Page("SECURITY.md", "security", "Security policy"),
            Page("CHANGELOG.md", "changelog", "Changelog"),
        ),
    ),
)
PAGES: tuple[Page, ...] = tuple(page for group in GROUPS for page in group.pages)
PAGE_BY_SRC: dict[str, Page] = {page.src: page for page in PAGES}
