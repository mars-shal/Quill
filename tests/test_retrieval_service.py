"""RetrievalService tests: web-supplement routing + user-notes threading.

Structure-only mode must still give personal sections (week logs,
logbooks) background to write against: when
``config.STRUCTURE_ONLY_WEB_ALL`` is on, the web supplement runs for
them and scopes the search to the section's own title + missing fields
(never the raw task prompt). User answers must thread into the packet
(``user_notes``) and satisfy their requirement fields.
"""

import pytest

from quill_engine import config, retrieval_service
from quill_engine.models import new_section
from quill_engine.storage import InMemoryStore


def _section(title: str):
    return new_section(title=title, level=2, order=1, parent_id=None)


class _FakeResult:
    def __init__(self, url="https://example.com/swep", title="SWEP Guide", markdown="Training schedule with supervision duties."):
        self.url = url
        self.title = title
        self.markdown = markdown


# -- web supplement routing -----------------------------------------------


def test_personal_section_not_supplemented_by_default(monkeypatch):
    monkeypatch.setattr(config, "STRUCTURE_ONLY_WEB_ALL", False)
    monkeypatch.setattr(config, "WEB_SUPPLEMENT_ALL", True)
    result = retrieval_service._web_supplement(
        _section("2.1 WEEK ONE ORIENTATION"), ["dates"], []
    )
    assert result == []


def test_personal_section_supplemented_with_title_scope_when_structure_only(monkeypatch):
    monkeypatch.setattr(config, "STRUCTURE_ONLY_WEB_ALL", True)
    monkeypatch.setattr(config, "WEB_SUPPLEMENT_ALL", True)
    monkeypatch.setattr(config, "CLEAN_EVIDENCE", False)
    calls: dict[str, str] = {}

    def fake_search(query_text):
        calls["query"] = query_text
        return [_FakeResult()]

    monkeypatch.setattr(retrieval_service.search_service, "search", fake_search)
    result = retrieval_service._web_supplement(
        _section("2.1 WEEK ONE ORIENTATION"), ["dates"], []
    )
    assert len(result) == 1
    assert result[0].source_type == "web"
    assert "WEEK ONE ORIENTATION" in calls["query"]
    assert "LAUTECH" not in calls["query"]  # scoped to section title, not the raw prompt
    assert "background only" in result[0].text


def test_non_personal_section_uses_section_title_not_topic(monkeypatch):
    monkeypatch.setattr(config, "STRUCTURE_ONLY_WEB_ALL", True)
    monkeypatch.setattr(config, "WEB_SUPPLEMENT_ALL", True)
    monkeypatch.setattr(config, "CLEAN_EVIDENCE", False)
    calls: dict[str, str] = {}

    def fake_search(query_text):
        calls["query"] = query_text
        return [_FakeResult(url="https://example.com/tools", title="Tools", markdown="Machining tools overview.")]

    monkeypatch.setattr(retrieval_service.search_service, "search", fake_search)
    retrieval_service._web_supplement(
        _section("2.5.2 MATERIALS AND MIX RATIOS"), ["materials"], []
    )
    assert "MATERIALS AND MIX RATIOS" in calls["query"]
    assert "LAUTECH" not in calls["query"]


# -- user-notes threading -------------------------------------------------


def test_user_notes_renders_only_answered_fields():
    notes = retrieval_service._user_notes({"dates": "12/08/2026", "activities": ""})
    assert "12/08/2026" in notes
    assert "Which activities were performed?" not in notes  # empty answer skipped


def test_retrieve_threads_answers_into_requirements_and_notes(monkeypatch):
    store = InMemoryStore()
    section = _section("2.1 WEEK ONE ORIENTATION")
    store.save_sections("proj", [section])
    store.save_evidence("proj", {"dates": "12/08/2026"})

    monkeypatch.setattr(
        retrieval_service.embedding_service,
        "embed_texts",
        lambda texts: [[0.0] * 8 for _ in texts],
    )
    monkeypatch.setattr(store, "search_vectors", lambda *a, **k: [])
    monkeypatch.setattr(retrieval_service.search_service, "search", lambda q: [])
    monkeypatch.setattr(config, "RELATION_ENABLED", False)
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    monkeypatch.setattr(config, "WEB_SUPPLEMENT_ALL", False)
    monkeypatch.setattr(config, "STYLE_ANALYSIS_ENABLED", False)

    packet = retrieval_service.retrieve("proj", "SWEP", store, section_id=section.section_id)

    assert "dates" not in packet.missing_fields  # answered -> satisfied
    assert "12/08/2026" in packet.user_notes
    assert packet.style_profile["tone"] == "formal academic"  # default, no body text


# -- @-reference threading ---------------------------------------------


def test_retrieve_attaches_references_and_section_summaries(monkeypatch):
    store = InMemoryStore()
    section = _section("2.1 WEEK ONE ORIENTATION")
    section.summary = "Orientation week activities and supervision."
    store.save_sections("proj", [section])

    monkeypatch.setattr(
        retrieval_service.embedding_service,
        "embed_texts",
        lambda texts: [[0.0] * 8 for _ in texts],
    )
    monkeypatch.setattr(store, "search_vectors", lambda *a, **k: [])
    monkeypatch.setattr(retrieval_service.search_service, "search", lambda q: [])
    monkeypatch.setattr(config, "RELATION_ENABLED", False)
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    monkeypatch.setattr(config, "WEB_SUPPLEMENT_ALL", False)
    monkeypatch.setattr(config, "STYLE_ANALYSIS_ENABLED", False)

    packet = retrieval_service.retrieve(
        "proj",
        "SWEP",
        store,
        section_id=section.section_id,
        references=[("annex.md", "Full calibration data for the lathe.")],
    )

    ref_chunks = [c for c in packet.chunks if c.source_type == "reference"]
    assert len(ref_chunks) == 1
    assert ref_chunks[0].source_title == "annex.md"
    assert "calibration data" in ref_chunks[0].text
    assert ("2.1 WEEK ONE ORIENTATION", "Orientation week activities and supervision.") in (
        packet.section_summaries
    )


def test_retrieve_skips_blank_references(monkeypatch):
    store = InMemoryStore()
    section = _section("2.1 WEEK ONE ORIENTATION")
    store.save_sections("proj", [section])

    monkeypatch.setattr(
        retrieval_service.embedding_service,
        "embed_texts",
        lambda texts: [[0.0] * 8 for _ in texts],
    )
    monkeypatch.setattr(store, "search_vectors", lambda *a, **k: [])
    monkeypatch.setattr(retrieval_service.search_service, "search", lambda q: [])
    monkeypatch.setattr(config, "RELATION_ENABLED", False)
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    monkeypatch.setattr(config, "WEB_SUPPLEMENT_ALL", False)
    monkeypatch.setattr(config, "STYLE_ANALYSIS_ENABLED", False)

    packet = retrieval_service.retrieve(
        "proj",
        "SWEP",
        store,
        section_id=section.section_id,
        references=[("blank.md", "   ")],
    )
    assert all(c.source_type != "reference" for c in packet.chunks)


# -- query cleaning -------------------------------------------------------


def test_dedupe_tokens_collapses_repeated_phrases():
    assert retrieval_service._dedupe_tokens(
        "CHAPTER TWO CHAPTER TWO CHAPTER TWO CHAPTER ONE"
    ) == "CHAPTER TWO CHAPTER ONE"


def test_web_supplement_query_dedupes_and_includes_topic(monkeypatch):
    monkeypatch.setattr(config, "STRUCTURE_ONLY_WEB_ALL", True)
    monkeypatch.setattr(config, "WEB_SUPPLEMENT_ALL", True)
    monkeypatch.setattr(config, "CLEAN_EVIDENCE", False)
    calls: dict[str, str] = {}

    def fake_search(query_text):
        calls["query"] = query_text
        return [_FakeResult(url="https://example.com/mix", title="Mix", markdown="Mix ratios overview.")]

    monkeypatch.setattr(retrieval_service.search_service, "search", fake_search)
    retrieval_service._web_supplement(
        _section("CHAPTER TWO CHAPTER TWO CHAPTER ONE"),
        ["materials"],
        ["CHAPTER THREE"],
        report_topic="SWEP interlocking tiles",
    )
    assert "CHAPTER TWO CHAPTER ONE" in calls["query"]
    assert "CHAPTER TWO CHAPTER TWO" not in calls["query"]
    assert "SWEP interlocking tiles" in calls["query"]
    assert "definition background" not in calls["query"]
