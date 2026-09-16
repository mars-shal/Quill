"""Tests for the rewrite cascade: similar-section alignment + orchestrator wiring."""

from __future__ import annotations

import quill_engine.cascade_service as cascade_service
from quill_engine import config
from quill_engine import md_rewriter
from quill_engine import orchestrator
from quill_engine.models import (
    Chunk,
    GenerationResult,
    Section,
    new_vector_record,
)
from quill_engine.storage import InMemoryStore


# -- helpers ---------------------------------------------------------------


def _section(section_id: str, title: str) -> Section:
    return Section(
        section_id=section_id,
        title=title,
        level=2,
        order=1,
        parent_id=None,
    )


def _store_with_vectors(sections: list[Section]) -> InMemoryStore:
    """Store with one chunk + one chunk-vector per section (embedding [1,0])."""
    store = InMemoryStore()
    store.save_sections("proj", sections)
    chunks = [
        Chunk(chunk_id=f"{s.section_id}-c1", section_id=s.section_id, text="content", tokens=10)
        for s in sections
    ]
    records = [
        new_vector_record(
            section_id=s.section_id,
            embedding=[1.0, 0.0],
            model="test",
            dim=2,
            chunk_id=f"{s.section_id}-c1",
            kind="chunk",
        )
        for s in sections
    ]
    store.save_chunks("proj", chunks)
    store.save_vectors("proj", records)
    return store


# -- find_similar_sections -------------------------------------------------


def test_find_similar_sections_ranks_and_skips_source(monkeypatch):
    store = _store_with_vectors([_section("s1", "Alpha"), _section("s2", "Beta")])
    monkeypatch.setattr(
        cascade_service.embedding_service, "embed_texts", lambda texts: [[1.0, 0.0]]
    )
    matches = cascade_service.find_similar_sections(
        "proj", store, "new text", exclude_section_id="s1"
    )
    assert matches == [("s2", "Beta", 1.0)]


def test_find_similar_sections_respects_threshold(monkeypatch):
    store = _store_with_vectors([_section("s1", "Alpha"), _section("s2", "Beta")])
    monkeypatch.setattr(
        cascade_service.embedding_service, "embed_texts", lambda texts: [[0.0, 1.0]]
    )
    matches = cascade_service.find_similar_sections(
        "proj", store, "new text", exclude_section_id="s1", min_similarity=0.9
    )
    assert matches == []


def test_find_similar_sections_respects_limit_and_skip(monkeypatch):
    sections = [_section("s1", "Alpha"), _section("s2", "Beta"), _section("s3", "Gamma")]
    store = _store_with_vectors(sections)
    monkeypatch.setattr(
        cascade_service.embedding_service, "embed_texts", lambda texts: [[1.0, 0.0]]
    )
    matches = cascade_service.find_similar_sections(
        "proj", store, "new text", exclude_section_id="s1", skip={"s2"}, limit=1
    )
    assert matches == [("s3", "Gamma", 1.0)]


def test_find_similar_sections_empty_text(monkeypatch):
    store = _store_with_vectors([_section("s1", "Alpha")])
    assert cascade_service.find_similar_sections(
        "proj", store, "", exclude_section_id="s1"
    ) == []


# -- cascade_rewrite -------------------------------------------------------


def test_cascade_rewrite_aligns_with_source_and_never_copies(monkeypatch):
    store = InMemoryStore()
    store.save_sections("proj", [_section("s1", "Alpha"), _section("s2", "Beta")])
    monkeypatch.setattr(
        cascade_service,
        "find_similar_sections",
        lambda project_id, store, text, exclude_section_id, skip=None, limit=None, min_similarity=None: [
            ("s2", "Beta", 0.9)
        ],
    )
    calls: dict = {}

    def fake_rewrite(project_id, section_id, store, *, instruction, cancel=None, references=()):
        calls["instruction"] = instruction
        calls["references"] = references
        return GenerationResult(section_id=section_id, text="ALIGNED", status="generated")

    monkeypatch.setattr(md_rewriter, "rewrite_section", fake_rewrite)
    results = cascade_service.cascade_rewrite(
        "proj", store, "s1", "SOURCE TEXT", source_title="Alpha"
    )
    assert "s2" in results
    assert "Do not copy the reference text" in calls["instruction"]
    assert calls["references"] == [("Alpha", "SOURCE TEXT")]


def test_cascade_rewrite_opt_out_when_disabled(monkeypatch):
    monkeypatch.setattr(config, "REWRITE_CASCADE_ENABLED", False)
    store = InMemoryStore()
    assert cascade_service.cascade_rewrite("proj", store, "s1", "text") == {}


# -- orchestrator wiring ---------------------------------------------------


def test_rewrite_cascades_after_directed_rewrite(monkeypatch):
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    store = InMemoryStore()
    store.save_sections("proj", [_section("s1", "Alpha"), _section("s2", "Beta")])
    store.save_generation("proj", "s1", GenerationResult(section_id="s1", text="old"))
    store.save_generation("proj", "s2", GenerationResult(section_id="s2", text="old"))

    def fake_rewrite(project_id, section_id, store, *, instruction="", cancel=None, references=()):
        return GenerationResult(section_id=section_id, text="NEW_" + section_id, status="generated")

    monkeypatch.setattr(md_rewriter, "rewrite_section", fake_rewrite)
    seen: dict = {}

    def fake_cascade(project_id, store, source_section_id, source_text, *, source_title="", cancel=None, skip=None):
        seen["skip"] = skip
        return {"s2": GenerationResult(section_id="s2", text="CASCADED", status="generated")}

    monkeypatch.setattr(cascade_service, "cascade_rewrite", fake_cascade)

    progress: list[tuple] = []
    results = orchestrator.rewrite(
        "proj",
        store,
        section_ids=["s1"],
        prompt="make consistent",
        progress_cb=lambda *args: progress.append(args),
    )
    assert results["s2"].text == "CASCADED"
    assert store.get_generation("proj", "s2").text == "CASCADED"
    assert seen["skip"] == {"s1", "s2"}
    assert any(entry[0] == "s2" for entry in progress)


def test_rewrite_no_cascade_without_prompt(monkeypatch):
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    store = InMemoryStore()
    store.save_sections("proj", [_section("s1", "Alpha")])
    store.save_generation("proj", "s1", GenerationResult(section_id="s1", text="old"))

    def fake_rewrite(project_id, section_id, store, *, instruction="", cancel=None, references=()):
        return GenerationResult(section_id=section_id, text="NEW", status="generated")

    monkeypatch.setattr(md_rewriter, "rewrite_section", fake_rewrite)

    def boom(*args, **kwargs):
        raise AssertionError("cascade must not run without a prompt")

    monkeypatch.setattr(cascade_service, "cascade_rewrite", boom)
    results = orchestrator.rewrite("proj", store, section_ids=["s1"], prompt="")
    assert results["s1"].text == "NEW"
