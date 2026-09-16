"""Unit tests for orchestrator.merge_similar_sections (the /merge command)."""

import pytest

from quill_engine import config, orchestrator
from quill_engine.models import ContentUnit, Section, new_vector_record, walk_sections
from quill_engine.storage import InMemoryStore


def _section(
    section_id: str,
    title: str,
    *,
    parent_id: str | None = None,
    level: int = 1,
    order: int = 1,
    description: str = "",
    content: list[str] | None = None,
    children: list[Section] | None = None,
) -> Section:
    return Section(
        section_id=section_id,
        title=title,
        level=level,
        order=order,
        parent_id=parent_id,
        description=description,
        content=[ContentUnit(text=t) for t in (content or [])],
        children=children or [],
        word_count=40,
    )


def _seed(
    sections: list[Section], embeddings: dict[str, list[float]]
) -> InMemoryStore:
    store = InMemoryStore()
    store.save_sections("proj", sections)
    vectors = [
        new_vector_record(sid, emb, model="test", dim=len(emb), kind="header")
        for sid, emb in embeddings.items()
    ]
    store.save_vectors("proj", vectors)
    return store


@pytest.fixture(autouse=True)
def _restore_defaults(monkeypatch):
    monkeypatch.setattr(config, "MERGE_MIN_SIMILARITY", 0.85)


def _embeddings(sections: list[Section], table: dict[str, list[float]]) -> dict[str, list[float]]:
    return {s.section_id: table[s.section_id] for s in walk_sections(sections)}


# -- merging behavior ------------------------------------------------------


def test_merge_absorbs_similar_sibling():
    kept = _section(
        "s1",
        "Week One",
        content=["kept content", "extra kept"],
    )
    dup = _section(
        "s2",
        "Week One",
        parent_id="chapter",
        content=["dup content"],
    )
    chapter = _section("chapter", "Chapter", children=[kept, dup])
    kept.parent_id = "chapter"
    dup.parent_id = "chapter"
    store = _seed(
        [chapter],
        _embeddings([chapter], {"s1": [1.0, 0.0], "s2": [0.98, 0.2], "chapter": [0.0, 1.0]}),
    )

    results = orchestrator.merge_similar_sections("proj", store)

    assert len(results) == 1
    assert results[0].kept_section_id == "s1"
    assert results[0].removed_section_id == "s2"
    assert results[0].score >= config.MERGE_MIN_SIMILARITY
    tree = store.get_sections("proj")
    assert [c.section_id for c in tree[0].children] == ["s1"]
    texts = [u.text for u in tree[0].children[0].content]
    assert "kept content" in texts and "dup content" in texts


def test_merge_keeps_distinct_siblings():
    a = _section("a1", "Introduction")
    b = _section("b2", "Methodology")
    store = _seed(
        [a, b],
        {"a1": [1.0, 0.0], "b2": [0.0, 1.0]},
    )

    results = orchestrator.merge_similar_sections("proj", store)

    assert results == []
    assert [s.section_id for s in store.get_sections("proj")] == ["a1", "b2"]


def test_merge_top_level_siblings():
    a = _section("t1", "Appendix A")
    b = _section("t2", "Appendix A")
    store = _seed(
        [a, b],
        {"t1": [1.0, 0.0], "t2": [0.98, 0.2]},
    )

    results = orchestrator.merge_similar_sections("proj", store)

    assert [r.kept_section_id for r in results] == ["t1"]
    assert [r.removed_section_id for r in results] == ["t2"]
    assert [s.section_id for s in store.get_sections("proj")] == ["t1"]


def test_merge_does_not_cross_parents():
    parent1 = _section("p1", "Chapter One")
    parent2 = _section("p2", "Chapter Two")
    child1 = _section("c1", "Same Title", parent_id="p1")
    child2 = _section("c2", "Same Title", parent_id="p2")
    parent1.children = [child1]
    parent2.children = [child2]
    store = _seed(
        [parent1, parent2],
        _embeddings(
            [parent1, parent2],
            {"p1": [0.0, 1.0], "p2": [1.0, 0.0], "c1": [1.0, 0.0], "c2": [0.98, 0.2]},
        ),
    )

    results = orchestrator.merge_similar_sections("proj", store)

    assert results == []
    assert [c.section_id for c in store.get_sections("proj")[0].children] == ["c1"]
    assert [c.section_id for c in store.get_sections("proj")[1].children] == ["c2"]


def test_merge_threshold_override():
    a = _section("o1", "Overview")
    b = _section("o2", "Overview")
    store = _seed(
        [a, b],
        {"o1": [1.0, 0.0], "o2": [0.98, 0.2]},
    )

    assert orchestrator.merge_similar_sections("proj", store, threshold=0.99) == []
    assert [s.section_id for s in store.get_sections("proj")] == ["o1", "o2"]

    results = orchestrator.merge_similar_sections("proj", store, threshold=0.9)
    assert len(results) == 1


def test_merge_persists_tree():
    a = _section("k1", "Keep Me")
    b = _section("k2", "Keep Me")
    store = _seed(
        [a, b],
        {"k1": [1.0, 0.0], "k2": [1.0, 0.0]},
    )

    orchestrator.merge_similar_sections("proj", store)

    tree = store.get_sections("proj")
    assert [s.section_id for s in tree] == ["k1"]
    assert tree[0].order == 1


def test_merge_cancel_stops_early():
    a = _section("x1", "Cancel Me")
    b = _section("x2", "Cancel Me", parent_id="x1")
    store = _seed(
        [a, b],
        {"x1": [1.0, 0.0], "x2": [1.0, 0.0]},
    )

    results = orchestrator.merge_similar_sections("proj", store, cancel=lambda: True)

    assert results == []
    assert [s.section_id for s in store.get_sections("proj")] == ["x1", "x2"]


def test_merge_reparents_absorbed_children():
    kept = _section("m1", "Parent A")
    removed = _section("m2", "Parent A")
    grandchild = _section("m3", "Grandchild", parent_id="m2")
    removed.children = [grandchild]
    kept.children = [_section("m4", "Existing Child", parent_id="m1")]
    store = _seed(
        [kept, removed],
        _embeddings(
            [kept, removed],
            {"m1": [1.0, 0.0], "m2": [0.98, 0.2], "m3": [0.0, 1.0], "m4": [0.0, 1.0]},
        ),
    )

    results = orchestrator.merge_similar_sections("proj", store)

    assert len(results) == 1
    tree = store.get_sections("proj")
    assert [c.section_id for c in tree[0].children] == ["m4", "m3"]
    assert all(c.parent_id == "m1" for c in tree[0].children)


def test_merge_recomputes_summary_and_order():
    a = _section("r1", "Resume", description="first half.")
    b = _section("r2", "Resume", description="second half.", order=2)
    c = _section("r3", "Unrelated", order=3)
    store = _seed(
        [a, b, c],
        {"r1": [1.0, 0.0], "r2": [0.98, 0.2], "r3": [0.0, 1.0]},
    )

    orchestrator.merge_similar_sections("proj", store)

    tree = store.get_sections("proj")
    assert [s.order for s in tree] == [1, 2]
    assert "first half." in tree[0].summary and "second half." in tree[0].summary


def test_merge_missing_embedding_fallback(monkeypatch):
    a = _section("f1", "Fallback")
    b = _section("f2", "Fallback")
    store = _seed([a, b], {"f1": [1.0, 0.0]})

    def fake_embed_headers(sections):
        return [
            new_vector_record(
                s.section_id,
                [0.99, 0.1],
                model="test",
                dim=2,
                kind="header",
            )
            for s in walk_sections(sections)
        ]

    monkeypatch.setattr(
        "quill_engine.orchestrator.embedding_service.embed_section_headers",
        fake_embed_headers,
    )

    results = orchestrator.merge_similar_sections("proj", store)

    assert len(results) == 1
    assert results[0].removed_section_id == "f2"


def test_merge_empty_project_returns_empty():
    store = InMemoryStore()
    assert orchestrator.merge_similar_sections("proj", store) == []
