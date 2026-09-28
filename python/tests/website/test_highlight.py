"""Code highlighting: Pygments tokens written as the hljs-* classes site/assets/site.css colours, so
the code looks as it did with highlight.js."""

from __future__ import annotations

import re

import pytest

from sws_tools.website.highlight import LANGUAGES, escape, highlight, is_known


def spans(html: str) -> list[tuple[str, str]]:
    """(class, text) of every span, in order."""
    return [(cls, text) for cls, text in re.findall(r'<span class="hljs-([^"]+)">([^<]*)</span>', html)]


def test_the_languages_are_the_ones_highlight_js_knew() -> None:
    # the names hljs.getLanguage() accepted in the TypeScript builder: the registered languages, their
    # own aliases and the aliases it added
    assert set(LANGUAGES) == {
        "atom",
        "bash",
        "cjs",
        "console",
        "cts",
        "docker",
        "dockerfile",
        "dotenv",
        "env",
        "html",
        "ini",
        "javascript",
        "js",
        "json",
        "json5",
        "jsonc",
        "jsx",
        "mjs",
        "mts",
        "plaintext",
        "plist",
        "rss",
        "sh",
        "shell",
        "svg",
        "text",
        "toml",
        "ts",
        "tsx",
        "txt",
        "typescript",
        "wsf",
        "xhtml",
        "xjb",
        "xml",
        "xsd",
        "xsl",
        "yaml",
        "yml",
        "zsh",
    }
    assert is_known("jsonc")
    for name in ("nginx", "python", "mermaid", "", "JSON"):
        assert not is_known(name), name
    assert highlight("x", "nginx") is None


def test_escaping_matches_highlight_js() -> None:
    assert escape("a < b & 'c' \"d\" >") == "a &lt; b &amp; &#x27;c&#x27; &quot;d&quot; &gt;"
    assert highlight("a < b & 'c'", "text") == "a &lt; b &amp; &#x27;c&#x27;"


def test_json() -> None:
    html = highlight('{"a": [1, -2.5, true, null], "b": "x"} // note', "jsonc")
    assert html is not None
    assert spans(html) == [
        ("punctuation", "{"),
        ("attr", "&quot;a&quot;"),  # keys
        ("punctuation", ":"),
        ("punctuation", "["),
        ("number", "1"),
        ("punctuation", ","),
        ("number", "-2.5"),
        ("punctuation", ","),
        ("keyword", "true"),  # highlight.js nests keyword in literal: the keyword colour shows
        ("punctuation", ","),
        ("keyword", "null"),
        ("punctuation", "],"),
        ("attr", "&quot;b&quot;"),
        ("punctuation", ":"),
        ("string", "&quot;x&quot;"),
        ("punctuation", "}"),
        ("comment", "// note"),
    ]


def test_bash() -> None:
    assert highlight('rm -rf dist && echo "hi $USER" # done', "bash") == (
        '<span class="hljs-built_in">rm</span> -rf dist &amp;&amp; <span class="hljs-built_in">echo</span> '
        '<span class="hljs-string">&quot;hi </span><span class="hljs-variable">$USER</span>'
        '<span class="hljs-string">&quot;</span> <span class="hljs-comment"># done</span>'
    )
    # highlight.js's word lists apply anywhere outside strings and /paths; a comment on the last line
    # (no line break after it) is still a comment; a \ line continuation is plain
    assert highlight("npm test -- --grep x \\\n  src/test/a.ts # last line", "sh") == (
        'npm <span class="hljs-built_in">test</span> -- --grep x \\\n  src/test/a.ts <span class="hljs-comment"># last line</span>'
    )
    # an assignment's name is plain, like numbers
    assert highlight("export A=1; if true; then cat x; fi", "bash") == (
        '<span class="hljs-built_in">export</span> A=1; <span class="hljs-keyword">if</span> '
        '<span class="hljs-literal">true</span>; <span class="hljs-keyword">then</span> '
        '<span class="hljs-built_in">cat</span> x; <span class="hljs-keyword">fi</span>'
    )


def test_env_and_ini_values() -> None:
    html = highlight('PORT=8931   # the port\nNAME="x y"\nFLAG=true\nURL=http://127.0.0.1:1234/v1\n[section]', "ini")
    assert html == (
        '<span class="hljs-attr">PORT</span>=<span class="hljs-number">8931</span>   <span class="hljs-comment"># the port</span>\n'
        '<span class="hljs-attr">NAME</span>=<span class="hljs-string">&quot;x y&quot;</span>\n'
        '<span class="hljs-attr">FLAG</span>=<span class="hljs-literal">true</span>\n'
        # an unquoted value stays plain except for its numbers
        '<span class="hljs-attr">URL</span>=http://<span class="hljs-number">127.0</span>.<span class="hljs-number">0.1</span>'
        ':<span class="hljs-number">1234</span>/v1\n'
        '<span class="hljs-section">[section]</span>'
    )


def test_toml_and_yaml() -> None:
    assert highlight('[a.b]\nx = 1\ny = "s"', "toml") == (
        '<span class="hljs-section">[a.b]</span>\n<span class="hljs-attr">x</span> = <span class="hljs-number">1</span>\n'
        '<span class="hljs-attr">y</span> = <span class="hljs-string">&quot;s&quot;</span>'
    )
    assert highlight("name: Web Search\nversion: 0.0.1\nlist:\n  - on\n", "yaml") == (
        '<span class="hljs-attr">name:</span> <span class="hljs-string">Web Search</span>\n'
        '<span class="hljs-attr">version:</span> <span class="hljs-number">0.0.1</span>\n'
        '<span class="hljs-attr">list:</span>\n  <span class="hljs-bullet">-</span> <span class="hljs-literal">on</span>\n'
    )


def test_javascript_names() -> None:
    html = highlight('await browser.goto(url); data.texts.length; new Error("x"); log({ text: this.a });', "js")
    assert html is not None
    assert spans(html) == [
        ("keyword", "await"),
        ("title function_", "goto"),  # method calls
        ("property", "texts"),  # property access
        ("property", "length"),
        ("keyword", "new"),
        ("title class_", "Error"),  # class names
        ("string", "&quot;x&quot;"),
        ("title function_", "log"),  # function calls
        ("attr", "text"),  # keys
        ("variable language_", "this"),
        ("property", "a"),
    ]


def test_xml_and_dockerfile() -> None:
    assert highlight('<a href="x">t</a>', "html") == (
        '&lt;<span class="hljs-name">a</span> <span class="hljs-attr">href</span>=<span class="hljs-string">&quot;x&quot;</span>'
        '&gt;t&lt;/<span class="hljs-name">a</span>&gt;'
    )
    assert highlight("FROM node:24 AS build\nRUN rm -rf x", "dockerfile") == (
        '<span class="hljs-keyword">FROM</span> node:<span class="hljs-number">24</span> AS build\n'
        '<span class="hljs-keyword">RUN</span> <span class="hljs-built_in">rm</span> -rf x'
    )


@pytest.mark.parametrize("language", sorted(LANGUAGES))
def test_every_language_keeps_the_text(language: str) -> None:
    text = "line one\n  \"two\" 3 # x // y <z> & 'q'\n\nlast"
    html = highlight(text, language)
    assert html is not None
    plain = re.sub(r"</?span[^>]*>", "", html)
    assert plain == escape(text), language
    # no span runs over a line end
    assert not re.search(r'<span class="[^"]*">[^<]*\n[^<]*</span>', html), language
