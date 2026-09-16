"""Shared fixtures: keep LLM-backed interview/template/extraction paths hermetic in tests."""

import pytest

from quill_engine import config


@pytest.fixture(autouse=True)
def _disable_interview_llm(monkeypatch):
    """Force the interview + template-extraction LLM paths off by default.

    config.INTERVIEW_ENABLED is read from the environment at import time, so
    the env var alone cannot flip it mid-session; monkeypatching the module
    attribute (and the env var for subprocesses) guarantees existing pipeline
    tests never wait on a real model call. Tests for the interview feature
    re-enable the attribute and stub ``thinking_service._complete``.
    """
    monkeypatch.delenv("QUILL_INTERVIEW", raising=False)
    monkeypatch.delenv("QUILL_TEMPLATE_SECTIONS", raising=False)
    monkeypatch.setattr(config, "INTERVIEW_ENABLED", False)
    monkeypatch.setattr(config, "TEMPLATE_MAX_SECTIONS", 10)
    monkeypatch.setattr(config, "SCRAPEGRAPH_ENABLED", False)
