"""ContextBuilder tests: personal-evidence block + evidence-authority note.

The user's answered evidence fields become an authoritative block in the
prompt only under structure-only mode, where the template's body is never
used as evidence. Outside that mode the block is omitted so the template's
own prose remains the primary personal record.
"""

from quill_engine import config
from quill_engine.context_builder import build
from quill_engine.models import EvidencePacket


def _packet(user_notes: str = "") -> EvidencePacket:
    return EvidencePacket(
        section_id="s1",
        section_title="Week One",
        target_words=100,
        style_profile={"tone": "formal"},
        chunks=[],
        user_notes=user_notes,
    )


def test_user_notes_block_rendered_in_structure_only_mode(monkeypatch):
    monkeypatch.setattr(config, "STRUCTURE_ONLY", True)
    package = build(_packet(user_notes="- When: 12/08/2026\n- Where: the depot"))
    assert "Personal evidence provided by the author" in package.template
    assert "- When: 12/08/2026" in package.template
    assert "- Where: the depot" in package.template


def test_user_notes_block_omitted_outside_structure_only(monkeypatch):
    monkeypatch.setattr(config, "STRUCTURE_ONLY", False)
    package = build(_packet(user_notes="- When: 12/08/2026"))
    assert "Personal evidence provided by the author" not in package.template


def test_evidence_authority_note_only_in_structure_only(monkeypatch):
    monkeypatch.setattr(config, "STRUCTURE_ONLY", True)
    package = build(_packet())
    assert "EVIDENCE AUTHORITY" in package.system_instructions

    monkeypatch.setattr(config, "STRUCTURE_ONLY", False)
    package = build(_packet())
    assert "EVIDENCE AUTHORITY" not in package.system_instructions


def test_build_rewrite_also_renders_user_notes_block(monkeypatch):
    monkeypatch.setattr(config, "STRUCTURE_ONLY", True)
    from quill_engine.context_builder import build_rewrite

    package = build_rewrite(
        _packet(user_notes="- Supervised by: Engr. Okafor"),
        existing_text="old body",
    )
    assert "Personal evidence provided by the author" in package.template
    assert "- Supervised by: Engr. Okafor" in package.template


# -- style profile: rendered as prose, never as a raw dict -------------


def test_style_profile_rendered_as_prose_not_dict():
    package = build(
        _packet_with_style(
            {
                "tone": "formal academic",
                "tense": "past",
                "avg_sentence_words": 20,
            }
        )
    )
    assert "Tone: formal academic" in package.template
    assert "Tenor" not in package.template
    assert "formal academic" in package.template
    assert "{'tone'" not in package.template
    assert "'formal academic'" not in package.template


def test_style_profile_empty_renders_default():
    packet = _packet()
    packet.style_profile = {}
    package = build(packet)
    assert "Style profile:" in package.template
    assert "default professional style" in package.template


def test_system_instructions_ban_filler_and_heading_copies():
    package = build(_packet())
    assert "generic filler" in package.system_instructions
    assert "Never copy headings" in package.system_instructions
    assert "Never mention the style profile" in package.system_instructions


# -- section summaries block -------------------------------------------


def test_section_summaries_block_rendered():
    packet = _packet()
    packet.section_summaries = [
        ("Week One", "Orientation and tool safety."),
        ("Week Two", "Lathe calibration runs."),
    ]
    package = build(packet)
    assert "Other sections in this report" in package.template
    assert "- Week One: Orientation and tool safety." in package.template
    assert "- Week Two: Lathe calibration runs." in package.template


def test_section_summaries_block_omitted_when_empty():
    package = build(_packet())
    assert "Other sections in this report" not in package.template


def _packet_with_style(style_profile: dict) -> EvidencePacket:
    return EvidencePacket(
        section_id="s1",
        section_title="Week One",
        target_words=100,
        style_profile=style_profile,
        chunks=[],
    )
