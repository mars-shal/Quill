"""Model tests: extractive section summaries (no LLM calls)."""

from quill_engine.models import (
    ContentUnit,
    _extractive_summary,
    new_section,
    summarize_sections,
)


def _leaf(title: str, description: str = "", text: str = ""):
    return new_section(
        title=title,
        level=2,
        order=1,
        parent_id="p",
        description=description,
        content=[ContentUnit(text=text)] if text else [],
    )


def test_leaf_summary_from_own_prose():
    leaf = _leaf("Week One", text="Calibrated the lathe on Monday. Then ran test cuts.")
    summarize_sections([leaf])
    assert leaf.summary.startswith("Calibrated the lathe on Monday.")
    assert "test cuts" in leaf.summary


def test_parent_summary_includes_child_summaries():
    child = _leaf("Week One", text="Calibrated the lathe on Monday.")
    parent = new_section(
        title="Chapter One",
        level=1,
        order=1,
        parent_id=None,
        children=[child],
    )
    summarize_sections([parent])
    assert child.summary
    assert "Calibrated the lathe" in parent.summary


def test_description_and_prose_combined():
    leaf = _leaf(
        "Safety", description="Orientation and tool safety.", text="Weapons training followed."
    )
    summarize_sections([leaf])
    assert "Orientation and tool safety" in leaf.summary
    assert "Weapons training" in leaf.summary


def test_empty_section_summary_blank():
    leaf = _leaf("Empty", description="   ", text="   ")
    summarize_sections([leaf])
    assert leaf.summary == ""


def test_extractive_summary_caps_words():
    text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence."
    assert len(_extractive_summary(text, max_words=6).split()) <= 6
