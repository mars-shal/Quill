"""Unit tests for structural rewrite: tree helpers + restructure cascade."""

import pytest

from quill_engine import md_rewriter
from quill_engine.models import (
    AddOp,
    GenerationResult,
    RenameOp,
    RestructurePlan,
    RewriteOp,
    Section,
    find_section,
    insert_section,
    new_section,
    remove_section,
    walk_sections,
)
from quill_engine.storage import InMemoryStore


def _tree() -> list[Section]:
    return [
        Section(
            section_id="c1",
            title="Chapter One",
            level=1,
            order=1,
            parent_id=None,
            children=[
                Section(
                    section_id="s1",
                    title="Week One",
                    level=2,
                    order=1,
                    parent_id="c1",
                ),
                Section(
                    section_id="s2",
                    title="Week Two",
                    level=2,
                    order=2,
                    parent_id="c1",
                ),
            ],
        ),
        Section(
            section_id="c2",
            title="Chapter Two",
            level=1,
            order=2,
            parent_id=None,
        ),
    ]


def _result(section_id: str, text: str) -> GenerationResult:
    return GenerationResult(section_id=section_id, text=text, status="generated")


# -- tree helpers ----------------------------------------------------------


def test_remove_section_removes_subtree_and_renumbers():
    sections = _tree()
    assert remove_section(sections, "s1") is True
    ids = [s.section_id for s in walk_sections(sections)]
    assert ids == ["c1", "s2", "c2"]
    assert sections[0].children[0].order == 1
    assert sections[1].order == 2


def test_remove_section_missing_returns_false():
    sections = _tree()
    assert remove_section(sections, "nope") is False
    assert len(walk_sections(sections)) == 4


def test_insert_section_top_level_after_anchor():
    sections = _tree()
    new = new_section("Chapter Three", level=1, order=0, parent_id=None)
    assert insert_section(sections, new, after_section_id="c2") is True
    assert [s.section_id for s in sections] == ["c1", "c2", new.section_id]
    assert sections[2].order == 3


def test_insert_section_as_child_after_anchor():
    sections = _tree()
    new = new_section("Week Three", level=2, order=0, parent_id="c1")
    assert insert_section(sections, new, parent_id="c1", after_section_id="s2") is True
    assert [s.section_id for s in sections[0].children] == ["s1", "s2", new.section_id]


def test_insert_section_unknown_anchor_returns_false():
    sections = _tree()
    new = new_section("X", level=1, order=0, parent_id=None)
    assert insert_section(sections, new, parent_id="missing") is False
    assert insert_section(sections, new, after_section_id="missing") is False
    assert len(walk_sections(sections)) == 4


# -- plan parsing / validation ---------------------------------------------


def test_parse_plan_tolerates_fences_and_prose():
    raw = '```json\n{"rewrite": [{"section_id": "s1", "instruction": "tighten"}], "add": [{"title": "Intro", "parent_id": null}], "remove": ["c2"]}\n```'
    plan = md_rewriter._parse_plan(raw)
    assert plan.rewrite == [RewriteOp(section_id="s1", instruction="tighten")]
    assert plan.add == [AddOp(title="Intro", parent_id=None)]
    assert plan.remove == ["c2"]


def test_parse_plan_empty_and_garbage():
    assert md_rewriter._parse_plan("") == RestructurePlan()
    assert md_rewriter._parse_plan("no json here") == RestructurePlan()


def test_validate_plan_drops_unknown_and_conflicting_ops():
    plan = RestructurePlan(
        rewrite=[RewriteOp(section_id="s1"), RewriteOp(section_id="ghost")],
        add=[AddOp(title="Ok", parent_id="c1"), AddOp(title="Bad", parent_id="ghost")],
        remove=["c2", "ghost"],
    )
    valid = md_rewriter._validate_plan(plan, _tree())
    assert [op.section_id for op in valid.rewrite] == ["s1"]
    assert [op.title for op in valid.add] == ["Ok"]
    assert valid.remove == ["c2"]


def test_parse_plan_parses_rename_ops():
    raw = (
        '{"rewrite": [], "add": [], "remove": [],'
        ' "rename": [{"section_id": "s1", "title": "Orientation Week"}]}'
    )
    plan = md_rewriter._parse_plan(raw)
    assert plan.rename == [RenameOp(section_id="s1", title="Orientation Week")]


def test_validate_plan_drops_unknown_blank_and_conflicting_rename_ops():
    plan = RestructurePlan(
        rewrite=[RewriteOp(section_id="s1")],
        remove=["s2"],
        rename=[
            RenameOp(section_id="c1", title="Chapter One Revised"),
            RenameOp(section_id="ghost", title="Bad"),
            RenameOp(section_id="s1", title="Conflict"),
            RenameOp(section_id="s2", title="Removed"),
            RenameOp(section_id="c1", title="   "),
        ],
    )
    valid = md_rewriter._validate_plan(plan, _tree())
    assert [(op.section_id, op.title) for op in valid.rename] == [
        ("c1", "Chapter One Revised")
    ]


def test_restructure_applies_rename_and_persists(monkeypatch):
    store = InMemoryStore()
    store.save_sections("proj", _tree())
    store.save_generation("proj", "s1", _result("s1", "old s1"))

    plan = RestructurePlan(rename=[RenameOp(section_id="s1", title="Orientation Week")])
    monkeypatch.setattr(md_rewriter, "plan_restructure", lambda *a, **k: plan)

    def fake_rewrite_section(project_id, section_id, store, *, instruction, cancel=None, references=(), on_delta=None):
        return _result(section_id, f"new {section_id}")

    monkeypatch.setattr(md_rewriter, "rewrite_section", fake_rewrite_section)

    outcome = md_rewriter.restructure("proj", store, instruction="rename")

    assert outcome.renamed == ["s1"]
    assert outcome.removed == []
    assert outcome.added == []
    assert outcome.rewritten == {}

    sections = store.get_sections("proj")
    assert find_section(sections, "s1").title == "Orientation Week"
    assert store.get_generation("proj", "s1").text == "old s1"  # rename never regenerates


# -- restructure cascade ---------------------------------------------------


def test_restructure_applies_removes_adds_and_rewrites(monkeypatch):
    store = InMemoryStore()
    store.save_sections("proj", _tree())
    store.save_generation("proj", "s1", _result("s1", "old s1"))

    plan = RestructurePlan(
        rewrite=[RewriteOp(section_id="s1", instruction="tighten")],
        add=[AddOp(title="Chapter Three", parent_id=None)],
        remove=["c2"],
    )
    monkeypatch.setattr(md_rewriter, "plan_restructure", lambda *a, **k: plan)

    def fake_rewrite_section(project_id, section_id, store, *, instruction, cancel=None, references=(), on_delta=None):
        return _result(section_id, f"new {section_id}")

    monkeypatch.setattr(md_rewriter, "rewrite_section", fake_rewrite_section)

    outcome = md_rewriter.restructure("proj", store, instruction="restructure")

    assert outcome.removed == ["c2"]
    assert len(outcome.added) == 1
    added_id = outcome.added[0]
    assert outcome.rewritten["s1"].text == "new s1"
    assert outcome.rewritten[added_id].text == f"new {added_id}"

    # tree edits are persisted (added section must resolve for retrieval)
    sections = store.get_sections("proj")
    ids = [s.section_id for s in walk_sections(sections)]
    assert "c2" not in ids
    assert added_id in ids
    assert store.get_generation("proj", added_id) is None  # orchestrator persists


def test_restructure_empty_plan_rewrites_nothing(monkeypatch):
    store = InMemoryStore()
    store.save_sections("proj", _tree())
    store.save_generation("proj", "s1", _result("s1", "old s1"))

    monkeypatch.setattr(md_rewriter, "plan_restructure", lambda *a, **k: RestructurePlan())
    calls: list[str] = []
    monkeypatch.setattr(
        md_rewriter,
        "rewrite_section",
        lambda project_id, section_id, store, *, instruction, on_delta=None: calls.append(section_id)
        or _result(section_id, "x"),
    )

    outcome = md_rewriter.restructure("proj", store, instruction="nothing")

    assert outcome.rewritten == {}
    assert calls == []


def test_restructure_threads_progress_and_delta(monkeypatch):
    store = InMemoryStore()
    store.save_sections("proj", _tree())
    store.save_generation("proj", "s1", _result("s1", "old s1"))

    plan = RestructurePlan(
        rewrite=[RewriteOp(section_id="s1", instruction="tighten")],
        add=[AddOp(title="Chapter Three", parent_id=None)],
        remove=["c2"],
    )
    monkeypatch.setattr(md_rewriter, "plan_restructure", lambda *a, **k: plan)

    progress: list[tuple[str, str, int]] = []
    deltas: list[tuple[str, str]] = []

    def fake_rewrite_section(project_id, section_id, store, *, instruction, cancel=None, references=(), on_delta=None):
        if on_delta is not None:
            on_delta("chunk-a ")
            on_delta("chunk-b ")
        return _result(section_id, f"new {section_id}")

    monkeypatch.setattr(md_rewriter, "rewrite_section", fake_rewrite_section)

    def on_progress(section_id, status, ratio):
        progress.append((section_id, status, round(ratio, 1)))

    outcome = md_rewriter.restructure(
        "proj",
        store,
        instruction="restructure",
        progress_cb=on_progress,
        on_delta=lambda section_id, text: deltas.append((section_id, text)),
    )

    added_id = outcome.added[0]
    assert outcome.renamed == []
    assert progress == [
        ("s1", "generating", 0.0),
        (added_id, "generating", 0.5),
    ]
    assert deltas == [
        ("s1", "chunk-a "),
        ("s1", "chunk-b "),
        (added_id, "chunk-a "),
        (added_id, "chunk-b "),
    ]
    assert outcome.rewritten["s1"].text == "new s1"
    assert outcome.rewritten[added_id].text == f"new {added_id}"
