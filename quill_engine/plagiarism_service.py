"""Service — PlagiarismService: sentence-level source-overlap detection.

Complements ValidationService's aggregate 6-gram check: a section can
stay under the verbatim-copy threshold overall while still containing a
sentence lifted nearly word-for-word from the evidence. This module
splits the generated text into sentences and measures each sentence's
7-gram containment against the source evidence, flagging the passages a
paraphrase pass must rewrite.

Pure functions, no network, never raises.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

_COPY_NGRAM = 7
# Sentences shorter than this are mostly titles/fragments — skipping them
# keeps the report's own headings from flagging against source headings.
_MIN_SENTENCE_WORDS = 8
_MAX_HITS = 5


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _ngrams(text: str, n: int) -> set[tuple[str, ...]]:
    toks = _tokens(text)
    if len(toks) < n:
        return set()
    return {tuple(toks[i : i + n]) for i in range(len(toks) - n + 1)}


@dataclass
class PlagiarismHit:
    """One flagged sentence and how much of it matches a source."""

    sentence: str
    containment: float
    word_count: int


@dataclass
class PlagiarismReport:
    """Result of :func:`analyze`.

    ``score`` is the fraction of the whole text's 7-grams that appear in
    the sources (the same metric as ValidationService's verbatim check);
    ``hits`` are the individual copied sentences, worst first.
    """

    score: float = 0.0
    hits: list[PlagiarismHit] = field(default_factory=list)


def analyze(
    text: str,
    sources: list[str],
    *,
    ngram: int = _COPY_NGRAM,
    min_sentence_words: int = _MIN_SENTENCE_WORDS,
) -> PlagiarismReport:
    """Measure ``text`` against ``sources``; returns a report (never raises)."""
    if not text.strip() or not sources:
        return PlagiarismReport()

    pool: set[tuple[str, ...]] = set()
    for src in sources:
        pool |= _ngrams(src, ngram)

    text_grams = _ngrams(text, ngram)
    score = (len(text_grams & pool) / len(text_grams)) if text_grams else 0.0

    hits: list[PlagiarismHit] = []
    if pool:
        for sentence in _SENTENCE_SPLIT_RE.split(text):
            sentence = sentence.strip()
            words = _tokens(sentence)
            if len(words) < min_sentence_words:
                continue
            grams = _ngrams(sentence, ngram)
            if not grams:
                continue
            containment = len(grams & pool) / len(grams)
            if containment >= 0.5:
                hits.append(PlagiarismHit(sentence, containment, len(words)))
    hits.sort(key=lambda h: h.containment, reverse=True)
    hits = hits[:_MAX_HITS]
    return PlagiarismReport(score=score, hits=hits)
