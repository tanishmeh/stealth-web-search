"""Fixtures of the agent host tests."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from tests.lmstudio_agent.fakes import FakeLmStudio


@pytest.fixture
def lms() -> Iterator[FakeLmStudio]:
    """The scripted LM Studio. A script that raised (a failed assertion inside it) fails the test."""
    fake = FakeLmStudio()
    try:
        yield fake
    finally:
        fake.close()
    if fake.errors:
        raise fake.errors[0]
