"""The Python fixture website behaves like the matching parts of test/helpers/fixture-server.ts."""

from __future__ import annotations

import http.client
import urllib.parse
from pathlib import Path

import pytest

from sws_tools.fixture_site import FixtureSite, start_fixture_site


def request(site: FixtureSite, method: str, path: str, body: str | None = None) -> tuple[int, dict[str, str], str]:
    conn = http.client.HTTPConnection("127.0.0.1", site.port, timeout=10)
    try:
        headers = {"Content-Type": "application/x-www-form-urlencoded"} if body is not None else {}
        conn.request(method, path, body=body, headers=headers)
        res = conn.getresponse()
        return res.status, {k.lower(): v for k, v in res.getheaders()}, res.read().decode("utf-8")
    finally:
        conn.close()


def test_serves_the_static_pages(fixture_site: FixtureSite, site_dir: Path) -> None:
    status, headers, text = request(fixture_site, "GET", "/")
    assert status == 200
    assert headers["content-type"] == "text/html; charset=utf-8"
    assert text == (site_dir / "index.html").read_text(encoding="utf-8")
    assert "<h1>Hello Fixture</h1>" in text

    status, headers, _ = request(fixture_site, "GET", "/network-script.js")
    assert (status, headers["content-type"]) == (200, "text/javascript")


def test_echo_renders_and_records_the_form_post(fixture_site: FixtureSite) -> None:
    body = urllib.parse.urlencode({"email": "e2e@example.com", "note": "<b>&"})
    status, _, text = request(fixture_site, "POST", "/echo?x=1", body)
    assert status == 200
    assert '<p id="method">POST</p><p id="query">?x=1</p>' in text
    assert f'<pre id="body">{body.replace("&", "&amp;")}</pre>' in text

    posts = [r for r in fixture_site.requests if r.method == "POST" and r.url.startswith("/echo")]
    assert len(posts) == 1
    assert posts[0].body == body
    assert posts[0].headers["content-type"] == "application/x-www-form-urlencoded"


def test_missing_pages_and_paths_outside_the_site(fixture_site: FixtureSite) -> None:
    assert request(fixture_site, "GET", "/no-such-page.html")[0] == 404
    assert request(fixture_site, "GET", "/../package.json")[0] == 403


def test_fixture_host_sets_the_advertised_host(monkeypatch: pytest.MonkeyPatch, site_dir: Path) -> None:
    monkeypatch.setenv("FIXTURE_HOST", "host.docker.internal")
    with start_fixture_site(site_dir) as site:
        assert site.base_url == f"http://host.docker.internal:{site.port}"
