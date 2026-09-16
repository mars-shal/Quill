"""Unit tests for ValidationService AI-tell detection.

Covers the deterministic subset of the "words to watch" lists from
https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing.
"""

from quill_engine import validation_service


def _codes(text: str) -> list[str]:
    return [w.code for w in validation_service.check("s1", text)]


def test_clean_text_has_no_ai_tell_warnings():
    text = (
        "The team completed the bridge inspection on 12 March. "
        "The deck showed minor cracking in two spans. "
        "The contractor scheduled repairs for the following month."
    )
    codes = _codes(text)
    assert "ai_tell" not in codes


def test_significance_inflation_detected():
    text = "The founding marked a pivotal moment in regional statistics."
    assert "ai_tell" in _codes(text)


def test_canned_notability_detected():
    text = "The subject received independent coverage from national media outlets."
    assert "ai_tell" in _codes(text)


def test_superficial_analysis_clause_detected():
    text = "The lab upgraded its equipment, enhancing throughput across all units."
    assert "ai_tell" in _codes(text)


def test_advertorial_tone_detected():
    text = "Nestled in the heart of the valley, the resort boasts vibrant gardens."
    assert "ai_tell" in _codes(text)


def test_weasel_wording_detected():
    text = "Experts argue that the policy will reshape the sector."
    assert "ai_tell" in _codes(text)


def test_challenges_future_formula_detected():
    text = "Despite these challenges, the program faces several challenges ahead."
    assert "ai_tell" in _codes(text)


def test_one_warning_per_category_not_per_occurrence():
    text = (
        "A pivotal moment followed another pivotal moment. "
        "Both remain key turning points."
    )
    tells = [
        w for w in validation_service.check("s1", text) if w.code == "ai_tell"
    ]
    labels = {w.message.split(":", 1)[0] for w in tells}
    assert len(tells) == len(labels)
    assert "significance inflation" in labels


def test_all_tell_categories_reported_together():
    text = (
        "The launch was a pivotal moment for the firm. "
        "It received independent coverage from regional media outlets, "
        "fostering public interest. The brand boasts a vibrant following. "
        "Industry reports say the sector faces several challenges. "
        "Despite these challenges, the future outlook remains strong."
    )
    tells = [
        w for w in validation_service.check("s1", text) if w.code == "ai_tell"
    ]
    labels = {w.message.split(":", 1)[0] for w in tells}
    assert labels == {
        "significance inflation",
        "canned notability",
        "superficial analysis",
        "advertorial tone",
        "weasel wording",
        "challenges/future formula",
    }


def test_ai_tell_warning_is_non_blocking():
    """ai_tell joins the existing warning set without raising."""
    text = "A pivotal moment. And a placeholder {TODO}."
    codes = _codes(text)
    assert "ai_tell" in codes
    assert "placeholder" in codes


def test_citation_debris_detected():
    """Citation markers like [1] (source: ...) belong in evidence list, not prose."""
    text = "The process begins. [1] (source: research notes) UNDP report covers the topic. Then continues."
    codes = _codes(text)
    assert "citation_debris" in codes


def test_clean_paraphrase_has_no_citation_debris():
    source = ["The paint production process begins with mixing calcium carbonate."]
    text = "We started by weighing the calcium carbonate and combining it with the PVA binder."
    warnings = validation_service.check("s1", text, source_chunks=source)
    assert "citation_debris" not in [w.code for w in warnings]


# -- verbatim_copy (cross-source copy detection) ---------------------------


def test_verbatim_copy_detected():
    source = [
        "The paint production process begins with mixing calcium carbonate "
        "with polyvinyl acetate. Students then add water and pigment to "
        "form a smooth slurry before application."
    ]
    text = (
        "The paint production process begins with mixing calcium carbonate "
        "with polyvinyl acetate. Students then add water and pigment to "
        "form a smooth slurry before application. The same sentences "
        "again and again to pad out the section to its full length here."
    )
    codes = [
        w.code
        for w in validation_service.check("s1", text, source_chunks=source)
    ]
    assert "verbatim_copy" in codes


def test_paraphrased_text_not_flagged_as_copy():
    source = [
        "The paint production process begins with mixing calcium carbonate "
        "with polyvinyl acetate."
    ]
    text = (
        "We weighed out the calcium carbonate and combined it with the PVA "
        "binder. Water and pigment followed, and the whole mix was stirred "
        "until it formed a smooth, even slurry ready for the next step."
    )
    codes = [
        w.code
        for w in validation_service.check("s1", text, source_chunks=source)
    ]
    assert "verbatim_copy" not in codes


def test_verbatim_copy_skipped_without_sources():
    text = "copy copy copy copy copy copy copy copy copy copy copy copy"
    codes = _codes(text)
    assert "verbatim_copy" not in codes


def test_verbatim_copy_message_reports_overlap():
    source = [
        "The paint production process begins with mixing calcium carbonate "
        "with polyvinyl acetate.",
        "Students then add water and pigment to form a smooth slurry before "
        "application.",
        "The sessions were carried out under the close supervision of "
        "facilitators.",
    ]
    text = " ".join(source) + " This filler line adds length but not much else."
    warnings = validation_service.check("s1", text, source_chunks=source)
    copy = [w for w in warnings if w.code == "verbatim_copy"]
    assert copy
    assert copy[0].message[0].isdigit()
    assert "of the text is copied verbatim" in copy[0].message


# -- cascade helpers -------------------------------------------------------


def test_has_severe_and_retry_instruction():
    from quill_engine.models import Warning

    warnings = [
        Warning(code="repeated_paragraph", message="x", location="s1"),
        Warning(code="verbatim_copy", message="y", location="s1"),
    ]
    assert validation_service.has_severe(warnings) is True
    instruction = validation_service.retry_instruction(warnings)
    assert "previous draft was rejected" in instruction
    assert "no repeated paragraphs" in instruction
    assert "your own words" in instruction


def test_ai_tell_is_not_severe():
    from quill_engine.models import Warning

    warnings = [Warning(code="ai_tell", message="x", location="s1")]
    assert validation_service.has_severe(warnings) is False
    assert validation_service.retry_instruction(warnings) == ""


def test_tui_echo_detected():
    text = "Add them? (yes / no / numbers like 1,2)"
    assert "tui_echo" in _codes(text)


def test_outline_annotation_detected():
    text = "3.1 ORIENTATION OF MATERIALS (0 words, 0 subsections)"
    assert "tui_echo" in _codes(text)


def test_task_mention_echo_detected():
    text = "Your task mentions sections not in the source document."
    assert "tui_echo" in _codes(text)


def test_clean_prose_has_no_tui_echo():
    text = "Materials are oriented along the production line. Quality control follows."
    assert "tui_echo" not in _codes(text)


def test_tui_echo_is_severe():
    from quill_engine.models import Warning

    warnings = [Warning(code="tui_echo", message="x", location="s1")]
    assert validation_service.has_severe(warnings) is True
    assert "never quote prompts" in validation_service.retry_instruction(warnings)
