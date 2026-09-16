"""Tests for the ScrapeGraphAI extraction integration in search_service."""

import json
import threading

import scrapegraphai.graphs as sgg

from quill_engine import providers, search_service
from quill_engine.providers import LLMProvider


class _FakeGraph:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def run(self):
        return self.answer


class _DictGraph(_FakeGraph):
    answer = {"facts": ["quill is an AI report engine"], "count": 3}


class _StringGraph(_FakeGraph):
    answer = "  extracted notes with padding  "


def _enable(monkeypatch):
    monkeypatch.setattr(search_service.config, "SCRAPEGRAPH_ENABLED", True)
    monkeypatch.setattr(search_service.config, "SCRAPEGRAPH_PROMPT", "extract notes")


def _patch_graph(monkeypatch, cls):
    monkeypatch.setattr(sgg, "SmartScraperGraph", cls)
    monkeypatch.setattr(search_service, "_scrapegraph_llm_config", lambda: {"model_instance": "fake", "model_tokens": 8192})


def _ollama_provider(model="llama3.2:1b"):
    return LLMProvider(
        name="ollama",
        base_url="http://localhost:11434/v1",
        model=model,
        api_key=None,
    )


def test_scrapegraph_disabled_returns_empty(monkeypatch):
    monkeypatch.setattr(search_service.config, "SCRAPEGRAPH_ENABLED", False)
    assert search_service._scrapegraph_extract("https://example.com") == ""


def test_scrapegraph_no_llm_config_returns_empty(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(search_service, "_scrapegraph_llm_config", lambda: None)
    assert search_service._scrapegraph_extract("https://example.com") == ""


def test_scrapegraph_dict_result_is_json(monkeypatch):
    _enable(monkeypatch)
    _patch_graph(monkeypatch, _DictGraph)
    out = search_service._scrapegraph_extract("https://example.com")
    assert json.loads(out)["facts"] == ["quill is an AI report engine"]


def test_scrapegraph_string_result_is_stripped(monkeypatch):
    _enable(monkeypatch)
    _patch_graph(monkeypatch, _StringGraph)
    assert search_service._scrapegraph_extract("https://example.com") == "extracted notes with padding"


def test_scrapegraph_passes_url_prompt_and_config(monkeypatch):
    _enable(monkeypatch)
    captured: dict = {}

    class _RecordingGraph:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def run(self):
            return "notes"

    _patch_graph(monkeypatch, _RecordingGraph)
    search_service._scrapegraph_extract("https://target.example/page")
    assert captured["source"] == "https://target.example/page"
    assert captured["prompt"] == "extract notes"
    assert captured["config"]["llm"]["model_instance"] == "fake"
    assert captured["config"]["headless"] is True


def test_scrapegraph_timeout_returns_empty(monkeypatch):
    _enable(monkeypatch)

    class _SlowGraph(_FakeGraph):
        def run(self):
            threading.Event().wait(10)
            return "late"

    _patch_graph(monkeypatch, _SlowGraph)
    assert search_service._scrapegraph_extract("https://example.com", timeout=0.05) == ""


def test_llm_config_skips_placeholder_models(monkeypatch):
    chain = [LLMProvider(name="ollama", base_url="http://localhost:11434/v1", model="default", api_key=None)]
    monkeypatch.setattr(providers, "active_chain", lambda: chain)
    assert search_service._scrapegraph_llm_config() is None


def test_llm_config_builds_chatopenai(monkeypatch):
    monkeypatch.setattr(providers, "active_chain", lambda: [_ollama_provider()])
    cfg = search_service._scrapegraph_llm_config()
    assert cfg is not None
    assert cfg["model_tokens"] == search_service.config.SCRAPEGRAPH_MODEL_TOKENS
    llm = cfg["model_instance"]
    assert llm.model_name == "llama3.2:1b"
    assert llm.openai_api_base == "http://localhost:11434/v1"
    assert llm.extra_body == {"format": "json"}


def test_fetch_links_prefers_scrapegraph_over_markitdown(monkeypatch):
    monkeypatch.setattr(search_service, "_scrapegraph_extract", lambda url: f"notes for {url}")
    monkeypatch.setattr(search_service, "_fetch_markitdown", lambda url: (_ for _ in ()).throw(AssertionError("markitdown must not be called")))
    out = search_service.fetch_links(["https://a.example"])
    assert out == {"https://a.example": "notes for https://a.example"}


def test_fetch_links_falls_back_to_markitdown(monkeypatch):
    monkeypatch.setattr(search_service, "_scrapegraph_extract", lambda url: "")
    monkeypatch.setattr(
        search_service, "_fetch_markitdown", lambda url: "markitdown fallback"
    )
    out = search_service.fetch_links(["https://a.example"])
    assert out == {"https://a.example": "markitdown fallback"}


def test_fetch_prefers_scrapegraph(monkeypatch):
    monkeypatch.setattr(search_service, "_scrapegraph_extract", lambda url: "extracted notes")
    monkeypatch.setattr("markitdown.MarkItDown", lambda **k: (_ for _ in ()).throw(AssertionError("markitdown must not be called")))
    assert search_service.fetch("https://a.example") == "extracted notes"


def test_fetch_falls_back_to_markitdown(monkeypatch):
    monkeypatch.setattr(search_service, "_scrapegraph_extract", lambda url: "")

    class _FakeMD:
        def convert_url(self, url):
            return type("R", (), {"markdown": "markitdown md"})()

    monkeypatch.setattr("markitdown.MarkItDown", lambda **k: _FakeMD())
    assert search_service.fetch("https://a.example") == "markitdown md"