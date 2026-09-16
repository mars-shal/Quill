"""Tests for PlagiarismService: sentence-level source-overlap detection."""

from quill_engine import plagiarism_service


SOURCE = (
    "Interlocking blocks are produced by mixing laterite soil with a small "
    "percentage of cement. The mixture is compacted in a hydraulic press to "
    "form stable masonry units. Curing takes fourteen days before the blocks "
    "are suitable for load-bearing walls."
)


def _copy_sentence() -> str:
    """A sentence lifted almost verbatim from SOURCE (8+ words, 7-grams match)."""
    return (
        "The site preparation phase was straightforward. "
        "The mixture is compacted in a hydraulic press to form stable "
        "masonry units. "
        "Work continued the following week."
    )


def test_paraphrased_text_has_low_score_and_no_hits():
    paraphrase = (
        "Workers blended the laterite with cement before pressing it into "
        "units. The press gave each block enough density for structural use. "
        "After two weeks of curing, the units carried loads without cracking."
    )
    report = plagiarism_service.analyze(paraphrase, [SOURCE])
    assert report.score < 0.3
    assert report.hits == []


def test_copied_sentence_is_flagged():
    report = plagiarism_service.analyze(_copy_sentence(), [SOURCE])
    assert report.hits, "a verbatim sentence must be flagged"
    top = report.hits[0]
    assert top.containment >= 0.5
    assert "hydraulic press" in top.sentence


def test_hits_sorted_worst_first_and_capped():
    long_copy = " ".join(_copy_sentence() for _ in range(8))
    report = plagiarism_service.analyze(long_copy, [SOURCE])
    containments = [h.containment for h in report.hits]
    assert containments == sorted(containments, reverse=True)
    assert len(report.hits) <= plagiarism_service._MAX_HITS


def test_empty_inputs_are_safe():
    assert plagiarism_service.analyze("", [SOURCE]).hits == []
    assert plagiarism_service.analyze(_copy_sentence(), []).hits == []
    assert plagiarism_service.analyze("", []).score == 0.0


def test_short_sentences_skipped():
    # Under min_sentence_words (8): the section's own heading-like fragments
    # must not be flagged against source headings.
    report = plagiarism_service.analyze(
        "The mixture is compacted in presses.", [SOURCE]
    )
    assert report.hits == []


def test_no_sources_returns_zero_score():
    report = plagiarism_service.analyze(_copy_sentence(), [])
    assert report.score == 0.0
    assert report.hits == []
