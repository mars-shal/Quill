"""Unit tests for the Evidence Builder (quill_engine.evidence_builder)."""

import pytest

from quill_engine import context_builder
from quill_engine.evidence_builder import Fact, build_facts
from quill_engine.models import EvidencePacket, ScoredChunk


def _chunk(text: str, section_id: str = "sec_abc123") -> ScoredChunk:
    return ScoredChunk(
        chunk_id="c1",
        section_id=section_id,
        text=text,
        similarity=0.5,
        tokens=max(1, len(text.split())),
    )


class TestSourceTagging:
    def test_web_prefix_yields_url_source(self):
        chunk = _chunk(
            "[WEB - Nuclear Safety (https://www.iaea.org/safety) - not personal evidence]\n"
            "Regulatory frameworks govern reactor licensing. Inspections are routine."
        )
        facts = build_facts([chunk])
        assert facts[0].source == "web: https://www.iaea.org/safety"
        assert "not personal evidence" not in facts[0].text
        assert "Regulatory frameworks govern reactor licensing" in facts[0].text

    def test_research_prefix_yields_notes_source(self):
        chunk = _chunk(
            "[RESEARCH - from knowledge-graph memory - background only]\n"
            "The coolant loop operates at high pressure."
        )
        facts = build_facts([chunk])
        assert facts[0].source == "research notes"
        assert "RESEARCH" not in facts[0].text

    def test_unprefixed_chunk_is_source_report(self):
        facts = build_facts([_chunk("I used the lathe during week two.")])
        assert facts[0].source == "source report"
        assert facts[0].text == "I used the lathe during week two."


class TestSplittingAndDedupe:
    def test_multiple_sentences_grouped(self):
        chunk = _chunk(
            "First sentence about the gauge. Second sentence about the mill. "
            "Third sentence about the drill."
        )
        facts = build_facts([chunk])
        assert len(facts) == 1
        assert facts[0].text.startswith("First sentence")
        assert facts[0].text.endswith("drill.")

    def test_identical_units_deduplicated(self):
        facts = build_facts(
            [
                _chunk("Calibrated the gauge on Monday."),
                _chunk("Calibrated the gauge on Monday."),
            ]
        )
        assert len(facts) == 1

    def test_near_duplicate_whitespace_deduplicated(self):
        facts = build_facts(
            [
                _chunk("Calibrated the gauge on Monday."),
                _chunk("Calibrated   the gauge  on Monday."),
            ]
        )
        assert len(facts) == 1


class TestCaps:
    def test_max_facts_cap_respected(self):
        chunks = [_chunk(f"Fact number {i} is unique content here.") for i in range(10)]
        facts = build_facts(chunks, max_facts=3)
        assert len(facts) == 3

    def test_max_total_chars_cap_respected(self):
        chunks = [_chunk(f"Fact number {i} is unique content here.") for i in range(10)]
        facts = build_facts(chunks, max_total_chars=60)
        assert sum(len(f.text) for f in facts) <= 60

    def test_empty_input(self):
        assert build_facts([]) == []

    def test_all_boilerplate_yields_no_facts(self):
        facts = build_facts([_chunk("PRINTER-FRIENDLY\n- Summary\nISBN 978-92-64-32741-2")])
        assert facts == []


class TestHeadingStrip:
    """Foreign-document headings must never reach the writer."""

    def test_markdown_heading_line_dropped(self):
        chunk = _chunk(
            "## 6.1.2 Analogue v Digital\n"
            "The workshop compared analogue and digital instruments."
        )
        facts = build_facts([chunk])
        assert len(facts) == 1
        assert "6.1.2" not in facts[0].text
        assert "Analogue v Digital" not in facts[0].text
        assert "compared analogue and digital instruments" in facts[0].text

    def test_numbered_title_line_dropped(self):
        chunk = _chunk("6.2 Site Layout\nThe site plan was approved in March.")
        facts = build_facts([chunk])
        assert len(facts) == 1
        assert "Site Layout" not in facts[0].text
        assert "approved in March" in facts[0].text

    def test_long_numbered_prose_line_kept(self):
        chunk = _chunk(
            "1. The safety induction covered machine guards, fire exits, "
            "and first aid locations before work began on Monday."
        )
        facts = build_facts([chunk])
        assert len(facts) == 1
        assert "safety induction" in facts[0].text

    def test_sentence_with_heading_word_kept(self):
        chunk = _chunk("We discussed the project timeline during the meeting.")
        facts = build_facts([chunk])
        assert "discussed the project timeline" in facts[0].text


class TestRendering:
    def test_render_has_no_internal_leaks(self):
        packet = EvidencePacket(
            section_id="sec_abc123",
            section_title="Week One",
            target_words=50,
            style_profile={},
            chunks=[
                _chunk(
                    "[WEB - Nuclear Safety (https://www.iaea.org) - not personal evidence]\n"
                    "Regulatory frameworks govern reactor licensing.",
                    section_id="sec_abc123",
                ),
                _chunk("I observed the safety briefing.", section_id="sec_abc123"),
            ],
            query="week one activities",
        )
        rendered = context_builder.build(packet).template
        assert "sim " not in rendered
        assert "section sec_" not in rendered
        assert "(source: web: https://www.iaea.org)" in rendered
        assert "(source: source report)" in rendered

    def test_empty_chunks_render_fallback(self):
        packet = EvidencePacket(
            section_id="s1",
            section_title="T",
            target_words=50,
            style_profile={},
            chunks=[],
        )
        assert "(no evidence available)" in context_builder.build(packet).template
