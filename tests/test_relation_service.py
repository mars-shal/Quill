"""Unit tests for relation_service (feature 8: section-vs-siblings check)."""

import pytest

from quill_engine import config, relation_service
from quill_engine.models import ContentUnit, Section, new_vector_record
from quill_engine.storage import InMemoryStore


def _section(section_id: str, title: str, *, description: str = "") -> Section:
    return Section(
        section_id=section_id,
        title=title,
        level=1,
        order=1,
        parent_id=None,
        description=description,
        word_count=40,
    )


def _seed(project_id: str, sections: list[Section]) -> InMemoryStore:
    store = InMemoryStore()
    store.save_sections(project_id, sections)
    vectors = [
        new_vector_record(
            section.section_id,
            embedding,
            model="test",
            dim=2,
            kind="header",
        )
        for section, embedding in zip(sections, _EMBEDDINGS)
    ]
    store.save_vectors(project_id, vectors)
    return store


# s1 ~ s2 (cos ≈ 0.98), s1 ⊥ s3 (cos = 0.0), s2 ~ s3 (cos ≈ 0.14)
_EMBEDDINGS = [[1.0, 0.0], [0.98, 0.2], [0.0, 1.0]]


@pytest.fixture(autouse=True)
def _restore_defaults(monkeypatch):
    monkeypatch.setattr(config, "RELATION_MIN_SIMILARITY", 0.3)
    monkeypatch.setattr(config, "RELATION_TOP_K", 3)


# -- rank_related ---------------------------------------------------------


def test_rank_related_returns_similar_siblings_only():
    store = _seed("proj", [
        _section("s1", "Week One"),
        _section("s2", "Week Two"),
        _section("s3", "Appendix"),
    ])
    related = relation_service.rank_related("proj", "s1", store)
    assert [r.section_id for r in related] == ["s2"]
    assert related[0].title == "Week Two"
    assert 0.9 < related[0].score <= 1.0


def test_rank_related_orders_by_score_descending():
    # s1 relates most to s2, then s3 — both above the 0.3 threshold
    store = _seed("proj", [
        _section("s1", "Week One"),
        _section("s2", "Week Two"),
        _section("s3", "Intro"),
    ])
    embeddings = {
        "s1": [1.0, 0.0],
        "s2": [0.98, 0.2],
        "s3": [0.5, 0.87],
    }
    vectors = [
        new_vector_record(sid, emb, model="test", dim=2, kind="header")
        for sid, emb in embeddings.items()
    ]
    store = InMemoryStore()
    store.save_sections("proj", [
        _section("s1", "Week One"),
        _section("s2", "Week Two"),
        _section("s3", "Intro"),
    ])
    store.save_vectors("proj", vectors)

    related = relation_service.rank_related("proj", "s1", store)
    assert [r.section_id for r in related] == ["s2", "s3"]
    assert related[0].score >= related[1].score


def test_rank_related_honors_top_k(monkeypatch):
    monkeypatch.setattr(config, "RELATION_TOP_K", 1)
    store = _seed("proj", [
        _section("s1", "Week One"),
        _section("s2", "Week Two"),
        _section("s3", "Intro"),
    ])
    related = relation_service.rank_related("proj", "s1", store)
    assert len(related) == 1
    assert related[0].section_id == "s2"


def test_rank_related_honors_min_similarity(monkeypatch):
    monkeypatch.setattr(config, "RELATION_MIN_SIMILARITY", 0.99)
    store = _seed("proj", [
        _section("s1", "Week One"),
        _section("s2", "Week Two"),
    ])
    assert relation_service.rank_related("proj", "s1", store) == []


def test_rank_related_never_raises_on_unknown_section():
    store = InMemoryStore()
    assert relation_service.rank_related("proj", "nope", store) == []


def test_rank_related_never_raises_without_embeddings():
    store = InMemoryStore()
    store.save_sections("proj", [_section("s1", "Week One")])
    assert relation_service.rank_related("proj", "s1", store) == []


def test_rank_related_empty_when_disabled(monkeypatch):
    monkeypatch.setattr(config, "RELATION_TOP_K", 0)
    store = _seed("proj", [
        _section("s1", "Week One"),
        _section("s2", "Week Two"),
    ])
    assert relation_service.rank_related("proj", "s1", store) == []


# -- summarize ------------------------------------------------------------


def test_summarize_joins_description_and_content():
    section = _section(
        "s1", "Week One",
        description="Field work at the observatory.",
    )
    section.content = [ContentUnit(text="Calibrated the telescope.")]
    summary = relation_service.summarize(section)
    assert "observatory" in summary
    assert "telescope" in summary


def test_summarize_truncates_to_limit():
    section = _section("s1", "Week One", description="word " * 500)
    summary = relation_service.summarize(section)
    assert len(summary) == 240
    assert summary.startswith("word word")


def test_summarize_empty_section_returns_empty():
    section = _section("s1", "Week One")
    assert relation_service.summarize(section) == ""
