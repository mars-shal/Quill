"""Unit tests for quill_engine.thinking_service (interview + template layer)."""

import pytest

from quill_engine import config, thinking_service
from quill_engine.models import new_section
from quill_engine.thinking_service import (
    FollowUpQuestion,
    TemplateSection,
    build_followups,
    extract_detail_requests,
    extract_template,
    merge_answers,
    parse_template_choice,
)

SWEP_PROMPT = (
    "I need your actual details. Here's what I'd need, grouped by section:\n"
    "\n"
    "Cover page / personal\n"
    "- Full name, matric number, department, group number\n"
    "- Session and submission date\n"
    "Dedication / Acknowledgements\n"
    "- Anyone specific you want thanked\n"
    "Chapter 1 — Introduction\n"
    "Why is SWEP done at your level?\n"
    "Chapter 2 — Core content\n"
    "What stations did you go through?\n"
    "This is the part that needs to be yours, not theirs.\n"
    "Chapter 3 — Conclusion\n"
    "Challenges you personally faced\n"
)


def test_parse_template_lines_bullets():
    raw = "- Budget Overview\n- Risk Register\n- Timeline\n"
    assert thinking_service._parse_template_lines(raw) == [
        "Budget Overview",
        "Risk Register",
        "Timeline",
    ]


def test_parse_template_lines_numbers():
    raw = "1. Budget Overview\n2. Risk Register\n"
    assert thinking_service._parse_template_lines(raw) == [
        "Budget Overview",
        "Risk Register",
    ]


def test_parse_template_lines_skips_banned_words():
    raw = "- Sections\n- Task instruction\n- Budget Overview\n- structure\n"
    assert thinking_service._parse_template_lines(raw) == ["Budget Overview"]


def test_parse_template_lines_dedupes_and_caps(monkeypatch):
    monkeypatch.setattr(config, "TEMPLATE_MAX_SECTIONS", 2)
    raw = "- Budget Overview\n- Budget Overview\n- Risk Register\n- Timeline\n"
    assert thinking_service._parse_template_lines(raw) == [
        "Budget Overview",
        "Risk Register",
    ]


def test_extract_template_json_via_complete(monkeypatch):
    monkeypatch.setattr(config, "INTERVIEW_ENABLED", True)
    monkeypatch.setattr(
        thinking_service,
        "_complete",
        lambda prompt, system="": (
            '[{"title": "Budget Overview", "description": "quarterly budget"}, '
            '{"title": "Risk Register", "description": "key risks"}]'
        ),
    )
    out = extract_template("add budget and risks sections")
    assert out == [
        TemplateSection("Budget Overview", "quarterly budget"),
        TemplateSection("Risk Register", "key risks"),
    ]


def test_extract_template_line_fallback(monkeypatch):
    monkeypatch.setattr(config, "INTERVIEW_ENABLED", True)
    monkeypatch.setattr(
        thinking_service,
        "_complete",
        lambda prompt, system="": "The new sections:\n- Budget Overview\n- Timeline",
    )
    out = extract_template("add new sections")
    assert out == [TemplateSection("Budget Overview"), TemplateSection("Timeline")]


def test_extract_template_disabled_returns_empty(monkeypatch):
    monkeypatch.setattr(config, "INTERVIEW_ENABLED", False)
    assert extract_template("add sections") == []


def test_structure_outline_walks_children():
    child = new_section(title="2.1 Orientation", level=3, order=1, parent_id="p")
    parent = new_section(
        title="Week One", level=1, order=1, parent_id=None, children=[child]
    )
    outline = thinking_service._structure_outline([parent])
    assert "Week One" in outline
    assert "2.1 Orientation" in outline
    assert outline.index("2.1 Orientation") > outline.index("Week One")


def test_extract_template_threads_structure_into_prompt(monkeypatch):
    monkeypatch.setattr(config, "INTERVIEW_ENABLED", True)
    captured: dict[str, str] = {}

    def fake_complete(prompt, system=""):
        captured["prompt"] = prompt
        captured["system"] = system
        return "[]"

    monkeypatch.setattr(thinking_service, "_complete", fake_complete)
    sections = [new_section(title="Week One", level=1, order=1, parent_id=None)]
    extract_template("add new sections", sections)
    assert "Week One" in captured["prompt"]
    assert "SOURCE DOCUMENT STRUCTURE" in captured["prompt"]
    assert "source document" in captured["system"]


def test_parse_template_choice_all():
    template = [
        TemplateSection("Budget Overview"),
        TemplateSection("Risk Register"),
    ]
    assert parse_template_choice("yes", template) == ["Budget Overview", "Risk Register"]
    assert parse_template_choice("all", template) == ["Budget Overview", "Risk Register"]
    assert parse_template_choice("", template) == ["Budget Overview", "Risk Register"]


def test_parse_template_choice_none():
    template = [TemplateSection("Budget Overview")]
    assert parse_template_choice("no", template) == []
    assert parse_template_choice("0", template) == []


def test_parse_template_choice_numbers():
    template = [
        TemplateSection("Budget Overview"),
        TemplateSection("Risk Register"),
        TemplateSection("Timeline"),
    ]
    assert parse_template_choice("1,3", template) == ["Budget Overview", "Timeline"]
    assert parse_template_choice("2", template) == ["Risk Register"]


def test_parse_template_choice_titles_case_insensitive():
    template = [TemplateSection("Budget Overview"), TemplateSection("Timeline")]
    assert parse_template_choice("timeline", template) == ["Timeline"]


def test_parse_template_choice_empty_template():
    assert parse_template_choice("yes", []) == []


def test_merge_answers_appends_constraints():
    merged = merge_answers("Rewrite the report", {"tone": "professional"})
    assert "Rewrite the report" in merged
    assert "- tone: professional" in merged


def test_merge_answers_unchanged_when_empty():
    assert merge_answers("Rewrite the report", {}) == "Rewrite the report"


def test_extract_detail_requests_swep_prompt():
    questions = extract_detail_requests(SWEP_PROMPT)
    assert [q.question for q in questions] == [
        "Full name, matric number, department, group number",
        "Session and submission date",
        "Anyone specific you want thanked",
        "Why is SWEP done at your level?",
        "What stations did you go through?",
        "Challenges you personally faced",
    ]
    assert [q.field for q in questions] == [f"detail{i}" for i in range(1, 7)]
    assert all(q.kind == "text" and q.options == [] for q in questions)


def test_extract_detail_requests_plain_prompt_returns_empty():
    prompt = "Write a 5000-word technical report on embedded systems."
    assert extract_detail_requests(prompt) == []


def test_extract_detail_requests_signal_without_list_returns_empty():
    prompt = "Please provide me with the following report by Friday."
    assert extract_detail_requests(prompt) == []


def test_extract_detail_requests_empty_and_blank_prompts():
    assert extract_detail_requests("") == []
    assert extract_detail_requests("   \n  ") == []


def test_extract_detail_requests_dedupes():
    prompt = (
        "I need your details:\n- Matric number\n- Matric number\n- Department\n"
    )
    assert [q.question for q in extract_detail_requests(prompt)] == [
        "Matric number",
        "Department",
    ]


def test_extract_detail_requests_keeps_long_detail_lines():
    prompt = (
        "I need your details:\n"
        "What stations did you actually go through (yours may differ — e.g. "
        "you're Computer Engineering, not Mechatronics, so the mix of "
        "civil/electrical/mechanical stints will likely be different)\n"
    )
    questions = extract_detail_requests(prompt)
    assert len(questions) == 1
    assert questions[0].question.startswith("What stations did you actually go")


def test_extract_detail_requests_skips_prose_intro_lines():
    prompt = (
        "I need your details:\n"
        "This is the part that actually needs to be yours, not Miji's. For each "
        "station you rotated through:\n"
        "- Station one\n"
    )
    assert [q.question for q in extract_detail_requests(prompt)] == ["Station one"]


def test_build_followups_scanner_fallback(monkeypatch):
    monkeypatch.setattr(config, "INTERVIEW_ENABLED", True)
    monkeypatch.setattr(thinking_service, "_complete", lambda prompt: "")
    questions = build_followups(SWEP_PROMPT, [])
    assert questions
    assert questions[0].field == "detail1"
    assert questions[0].question == "Full name, matric number, department, group number"


def test_build_followups_llm_proposals_win_over_scanner(monkeypatch):
    monkeypatch.setattr(config, "INTERVIEW_ENABLED", True)
    monkeypatch.setattr(
        thinking_service,
        "_complete",
        lambda prompt: '[{"field": "tone", "question": "What tone?"}]',
    )
    questions = build_followups(SWEP_PROMPT, [])
    assert [q.field for q in questions] == ["tone"]
    assert all(q.field != "detail1" for q in questions)


def test_clean_template_title_strips_annotation():
    title = "4.3 STEP-BY-STEP PRODUCTION PROCESS (0 words, 9 subsections)"
    assert thinking_service._clean_template_title(title) == (
        "4.3 STEP-BY-STEP PRODUCTION PROCESS"
    )


def test_clean_template_title_strips_trailing_em_dash():
    assert thinking_service._clean_template_title("Safe and sound —") == "Safe and sound"
    assert thinking_service._clean_template_title("Materials and mix ratios:") == (
        "Materials and mix ratios"
    )


def test_clean_template_title_dedupes_repeats():
    assert thinking_service._clean_template_title("CHAPTER TWO CHAPTER TWO CHAPTER ONE") == (
        "CHAPTER TWO CHAPTER ONE"
    )


def test_extract_template_cleans_echoed_annotations(monkeypatch):
    monkeypatch.setattr(config, "INTERVIEW_ENABLED", True)
    monkeypatch.setattr(
        thinking_service,
        "_complete",
        lambda prompt, system="": (
            '[{"title": "3.1 ORIENTATION OF MATERIALS (0 words, 0 subsections)", '
            '"description": "orientation of materials"}]'
        ),
    )
    out = extract_template("add a materials orientation section")
    assert out == [TemplateSection("3.1 ORIENTATION OF MATERIALS", "orientation of materials")]
