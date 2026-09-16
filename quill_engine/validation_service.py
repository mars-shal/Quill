"""Service 8 — ValidationService: generated text -> structured warnings.

Checks (``.agent/agent.md`` §8): minimum length, heading presence,
placeholder detection, repeated paragraph detection. Never raises —
always returns warnings.
"""

from __future__ import annotations

import re

from . import config, plagiarism_service
from .models import Warning

_PLACEHOLDER_RE = re.compile(
    r"TODO|FIXME|\{\{|\}\}|\*\*\*PARAPHRASE\*\*\*|lorem\s+ipsum",
    re.IGNORECASE,
)
_MISSING_RE = re.compile(r"\[MISSING:\s*([^\]]+)\]", re.IGNORECASE)

# Detects citation markers like "[1] (source: research notes) some text" in output —
# these belong in the evidence list before the body, never in the generated prose.
_CITATION_MARKER_RE = re.compile(r"\[\d+\]\s*\(source:", re.IGNORECASE)

# Paragraph = 2+ sentences ending with .!? or a standalone line break.
_PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n")

# Cross-source copy detection: a generated section whose 6-gram overlap with
# the evidence exceeds config.VERBATIM_COPY_THRESHOLD is a paste, not a write.
_COPY_NGRAM = 6

# TUI / interactive prompt text the model must never reproduce inside a
# report body (e.g. the "Add them? (yes / no...)" template-confirm prompt).
_TUI_ECHO_RE = re.compile(
    r"Add them\?\s*\(yes|Your task mentions sections not in the source|"
    r"\(\d+\s+words?,?\s*\d+\s+subsections?\)",
    re.IGNORECASE,
)

# Warnings severe enough to trigger the rewrite cascade. ai_tell is excluded:
# it is stylistic noise and would retry almost every section forever.
SEVERE_CODES = frozenset(
    {
        "repeated_paragraph",
        "verbatim_copy",
        "plagiarized_passage",
        "too_short",
        "placeholder",
        "citation_debris",
        "tui_echo",
    }
)

_RETRY_INSTRUCTIONS = {
    "repeated_paragraph": (
        "The draft repeats the same paragraph verbatim. Rewrite it from "
        "scratch with no repeated paragraphs."
    ),
    "verbatim_copy": (
        "The draft copies the source evidence nearly word-for-word. Rewrite "
        "it entirely in your own words — paraphrase the evidence, never paste it."
    ),
    "plagiarized_passage": (
        "The draft contains a sentence lifted almost verbatim from the "
        "source evidence. Rewrite that passage in your own words — keep the "
        "fact, change the wording and sentence structure completely."
    ),
    "too_short": (
        "The draft is far too short for the target length. Expand it "
        "substantially using every fact the evidence supports."
    ),
    "placeholder": (
        "The draft contains placeholder text (TODO, FIXME, lorem ipsum). "
        "Replace each placeholder with real content the evidence supports."
    ),
    "citation_debris": (
        "The draft pasted citation markers like [1] (source:) into the prose. "
        "Rewrite in clean prose — paraphrase the facts into your own sentences "
        "without any citation markers in the body text."
    ),
    "tui_echo": (
        "The draft reproduces interactive UI prompt text (like 'Add them? "
        "(yes / no ...)') or outline annotations inside the report body. "
        "Rewrite as clean report prose — never quote prompts, menus, or "
        "(N words, N subsections) annotations."
    ),
}

# ---------------------------------------------------------------------------
# AI-tell detection (deterministic subset of the "words to watch" lists from
# https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing). One warning
# per matched category, not per occurrence, so the output stays readable.
# ---------------------------------------------------------------------------

_AI_TELL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "significance inflation",
        re.compile(
            r"\b(pivotal|crucial|vital)\s+(role|moment|part|figure|step)\b"
            r"|\b(key\s+turning\s+point|setting\s+the\s+stage|"
            r"evolving\s+landscape|focal\s+point|indelible\s+mark|"
            r"deeply\s+rooted)\b"
            r"|\b(is|stands?)\s+a\s+testament\b"
            r"|\b(underscores?|highlights?)\s+(its|the)\s+"
            r"(importance|significance|legacy)\b"
            r"|\b(symboliz\w+|embod\w+)\s+(its|the|a)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "canned notability",
        re.compile(
            r"\bindependent\s+coverage\b"
            r"|\b(local|regional|national|country)\s+media\s+outlets?\b"
            r"|\bprofiled\s+in\b"
            r"|\bactive\s+social\s+media\s+presence\b",
            re.IGNORECASE,
        ),
    ),
    (
        "superficial analysis",
        re.compile(
            r",\s*(highlighting|underscoring|emphasizing|ensuring|"
            r"reflecting|symbolizing|contributing\s+to|cultivating|"
            r"fostering|showcasing|enhancing)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "advertorial tone",
        re.compile(
            r"\b(boasts?|vibrant|renowned|groundbreaking|nestled|"
            r"seamless(?:ly)?)\b"
            r"|\b(in\s+the\s+heart\s+of|natural\s+beauty|"
            r"rich\s+(?:cultural\s+)?heritage|diverse\s+array)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "weasel wording",
        re.compile(
            r"\b(experts?\s+(?:argue|say|believe)|"
            r"observers\s+(?:have\s+)?(?:cited|noted|say)|"
            r"industry\s+reports?|some\s+critics?\s+argue|"
            r"several\s+(?:sources|publications))\b",
            re.IGNORECASE,
        ),
    ),
    (
        "challenges/future formula",
        re.compile(
            r"\bdespite\s+(?:these|the|its)\s+challenges?\b"
            r"|\bfaces?\s+several\s+challenges?\b"
            r"|\b(future\s+outlook|future\s+prospects?|"
            r"challenges\s+and\s+(?:future\s+)?(?:directions?|prospects?|"
            r"legacy))\b",
            re.IGNORECASE,
        ),
    ),
]


def _word_count(text: str) -> int:
    return len(text.split())


def _ngrams(text: str, n: int) -> set[tuple[str, ...]]:
    """Lowercased token n-grams of ``text``; empty when it has fewer than n."""
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    if len(tokens) < n:
        return set()
    return {tuple(tokens[i : i + n]) for i in range(len(tokens) - n + 1)}


def _verbatim_overlap(text: str, sources: list[str]) -> float:
    """Fraction of ``text``'s n-grams that also appear in any ``sources``."""
    text_grams = _ngrams(text, _COPY_NGRAM)
    if not text_grams:
        return 0.0
    pool: set[tuple[str, ...]] = set()
    for src in sources:
        pool |= _ngrams(src, _COPY_NGRAM)
    if not pool:
        return 0.0
    return len(text_grams & pool) / len(text_grams)


def _extract_paragraphs(text: str) -> list[str]:
    parts = _PARAGRAPH_SPLIT_RE.split(text)
    return [p.strip() for p in parts if p.strip()]


def check(
    section_id: str,
    text: str,
    *,
    min_words: int = config.MIN_SECTION_WORDS,
    source_chunks: list[str] | None = None,
    **kwargs,
) -> list[Warning]:
    """Validate generated ``text``; returns zero or more warnings.

    ``source_chunks`` (the evidence the model was given) enables the
    ``verbatim_copy`` and ``citation_debris`` checks — a section that
    mostly pastes its evidence or leaks citation markers into the
    prose is flagged.
    """
    warnings: list[Warning] = []

    words = _word_count(text)
    if words < min_words:
        warnings.append(
            Warning(
                code="too_short",
                message=f"only {words} words (min {min_words})",
                location=section_id,
            )
        )

    if source_chunks:
        overlap = _verbatim_overlap(text, source_chunks)
        if overlap > config.VERBATIM_COPY_THRESHOLD:
            warnings.append(
                Warning(
                    code="verbatim_copy",
                    message=(
                        f"{overlap:.0%} of the text is copied verbatim from the "
                        f"source evidence (max {config.VERBATIM_COPY_THRESHOLD:.0%})"
                    ),
                    location=section_id,
                )
            )
        if config.PLAGIARISM_SENTENCE_THRESHOLD > 0:
            report = plagiarism_service.analyze(text, source_chunks)
            for hit in report.hits:
                if hit.containment < config.PLAGIARISM_SENTENCE_THRESHOLD:
                    continue
                excerpt = hit.sentence[:70] + ("…" if len(hit.sentence) > 70 else "")
                warnings.append(
                    Warning(
                        code="plagiarized_passage",
                        message=(
                            f"{hit.containment:.0%} of a sentence matches the "
                            f"source evidence: {excerpt!r}"
                        ),
                        location=section_id,
                    )
                )

    # Detect citation markers like "[1] (source: research notes) some text" in
    # the output. These belong in the evidence list, not in the prose.
    if _CITATION_MARKER_RE.search(text):
        warnings.append(
            Warning(
                code="citation_debris",
                message="output contains citation markers — evidence was pasted verbatim into the prose",
                location=section_id,
            )
        )

    for match in _MISSING_RE.finditer(text):
        warnings.append(
            Warning(
                code="missing_evidence",
                message=f"unsupported content marker: {match.group(0)!r}",
                location=section_id,
            )
        )

    for match in _PLACEHOLDER_RE.finditer(text):
        warnings.append(
            Warning(
                code="placeholder",
                message=f"placeholder-like text: {match.group(0)!r}",
                location=section_id,
            )
        )

    for label, pattern in _AI_TELL_PATTERNS:
        match = pattern.search(text)
        if match is not None:
            warnings.append(
                Warning(
                    code="ai_tell",
                    message=f"{label}: {match.group(0)!r}",
                    location=section_id,
                )
            )

    seen: set[str] = set()
    for paragraph in _extract_paragraphs(text):
        key = " ".join(paragraph.split()).lower()
        if key in seen:
            warnings.append(
                Warning(
                    code="repeated_paragraph",
                    message="paragraph repeated verbatim in section",
                    location=section_id,
                )
            )
        seen.add(key)

    for match in _TUI_ECHO_RE.finditer(text):
        warnings.append(
            Warning(
                code="tui_echo",
                message=f"output echoes interactive UI prompt text: {match.group(0)!r}",
                location=section_id,
            )
        )

    return warnings


def has_severe(warnings: list[Warning]) -> bool:
    """True when any warning is severe enough to trigger a rewrite pass."""
    return any(w.code in SEVERE_CODES for w in warnings)


def retry_instruction(warnings: list[Warning]) -> str:
    """Rewrite instruction naming the severe failures (one per code)."""
    parts: list[str] = []
    seen: set[str] = set()
    for w in warnings:
        if w.code in _RETRY_INSTRUCTIONS and w.code not in seen:
            seen.add(w.code)
            parts.append(_RETRY_INSTRUCTIONS[w.code])
    if not parts:
        return ""
    return (
        "Your previous draft was rejected by automated checks for the "
        "following reasons. " + " ".join(parts)
    )
