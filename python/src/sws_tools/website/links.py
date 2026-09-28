"""Links on the site: where a link in a document points, and the check that every link in the built
site resolves."""

from __future__ import annotations

import os
import re
from pathlib import Path

from .jscompat import URIError, decode_uri, decode_uri_component, posix_dirname, posix_join
from .pages import PAGE_BY_SRC, REPO

ABSOLUTE_URL = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)
_LINK_ATTR = re.compile(r'\s(?:href|src)="([^"]+)"')
_ID_ATTR = re.compile(r'\sid="([^"]+)"')


def is_absolute(url: str) -> bool:
    """A URL with a scheme, or protocol-relative."""
    return bool(ABSOLUTE_URL.match(url)) or url.startswith("//")


class LinkRewriter:
    """Rewrites links in the documents: between documents they become links between pages, images in
    docs/images stay local, other repository files point to GitHub. Links to files that do not exist
    are collected in `broken`."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.broken: list[str] = []

    def __call__(self, href: str, from_src: str) -> str:
        """Where a link in `from_src` (a repo-relative Markdown path) should point on the site."""
        if is_absolute(href) or href.startswith("#"):
            return href
        path, *fragments = href.split("#")
        fragment = f"#{fragments[0]}" if fragments else ""
        try:
            target = posix_join(posix_dirname(from_src), decode_uri(path))
        except URIError:
            self.broken.append(f"{from_src}: link to {href} (malformed percent-encoding)")
            return href
        page = PAGE_BY_SRC.get(target)
        if page:
            return f"{page.slug}.html{fragment}"
        if target.startswith("docs/images/"):
            return f"images/{target[len('docs/images/') :]}{fragment}"
        absolute = Path(os.path.join(self.root, target))
        if not absolute.exists() or target.startswith(".."):
            self.broken.append(f"{from_src}: link to {href} ({target} does not exist)")
            return href
        kind = "tree" if absolute.is_dir() else "blob"
        return f"{REPO}/{kind}/main/{target}{fragment}"


def check_links(out: Path) -> list[str]:
    """Every relative href/src in the built HTML must resolve to a file, and #anchors to an id on
    that page. Returns the problems, one line each."""
    ids: dict[str, set[str]] = {}

    def ids_of(file: str) -> set[str]:
        if file not in ids:
            ids[file] = set(_ID_ATTR.findall(Path(file).read_text(encoding="utf-8")))
        return ids[file]

    problems: list[str] = []
    for page in sorted(out.rglob("*.html")):
        if not page.is_file() or page.name.endswith("404.html"):
            continue  # the 404 page uses absolute links that work at any depth
        rel = page.relative_to(out).as_posix()
        for m in _LINK_ATTR.finditer(page.read_text(encoding="utf-8")):
            raw = m.group(1).replace("&amp;", "&")
            if is_absolute(raw):
                continue
            path, *fragments = raw.split("#")
            fragment = fragments[0] if fragments else ""
            try:
                target = os.path.normpath(os.path.join(page.parent, decode_uri(path))) if path else str(page)
                if not os.path.exists(target):
                    problems.append(f"{rel}: {raw} (no such file)")
                elif fragment and target.endswith(".html") and decode_uri_component(fragment) not in ids_of(target):
                    problems.append(f"{rel}: {raw} (no #{fragment} on that page)")
            except URIError:
                problems.append(f"{rel}: {raw} (malformed percent-encoding)")
    return problems
