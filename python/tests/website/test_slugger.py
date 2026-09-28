"""Heading ids: GitHub's slugs, so links such as CONFIGURATION.md#sub-agents work on the site."""

from __future__ import annotations

import pytest

from sws_tools.website.slugger import Slugger


@pytest.mark.parametrize(
    ("heading", "slug"),
    [
        ("Getting started", "getting-started"),
        ("What's new? (v2.0)", "whats-new-v20"),
        ("9b. Sub-agents in LM Studio", "9b-sub-agents-in-lm-studio"),
        ("TOOLSETS=core,content", "toolsetscorecontent"),
        ("browser_click", "browser_click"),  # connector punctuation (_) stays
        ("  Leading and trailing  ", "leading-and-trailing"),
        ("Two  spaces", "two--spaces"),  # every space becomes a dash, as on GitHub
        ("A -- B", "a----b"),
        ("Émoji 🚀 and Ümlauts", "émoji--and-ümlauts"),  # letters of any script stay, symbols go
        ("日本語の見出し", "日本語の見出し"),
        ("Café, naïve: résumé", "café-naïve-résumé"),
        ("x² and ½", "x²-and-½"),  # numbers of any kind stay
        ("<select> & <form>", "select--form"),
        ("", ""),
    ],
)
def test_slug(heading: str, slug: str) -> None:
    assert Slugger()(heading) == slug


def test_repeats_get_a_counter_per_page() -> None:
    slug = Slugger()
    assert [slug("Usage"), slug("Usage"), slug("usage"), slug("Other"), slug("Usage")] == [
        "usage",
        "usage-1",
        "usage-2",
        "other",
        "usage-3",
    ]
    # a new page starts again
    assert Slugger()("Usage") == "usage"


def test_a_repeat_can_collide_with_a_real_heading_like_on_github() -> None:
    slug = Slugger()
    assert [slug("Step"), slug("Step"), slug("Step 1")] == ["step", "step-1", "step-1"]
