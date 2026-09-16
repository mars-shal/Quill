"""Service — EvidenceBuilder: raw chunks -> compact fact packets (Stage 5).

The writer must never see raw retrieved text. ``build_facts`` turns
``ScoredChunk``s into ``Fact(text, source)`` units — short, deduplicated
claims tagged with where they came from — so prompts carry knowledge, not
retrieval internals. Deterministic; no LLM calls.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import cleaner, config
from .models import ScoredChunk


@dataclass
class Fact:
    """One compact claim plus its provenance."""

    text: str
    source: str


_WEB_PREFIX_RE = re.compile(
    r"^\[WEB - .*? \((https?://[^)]+)\) - not personal evidence\]\s*",
    re.DOTALL,
)
_RESEARCH_PREFIX_RE = re.compile(r"^\[RESEARCH - .*?\]\s*", re.DOTALL)
_RELATED_PREFIX_RE = re.compile(r"^\[RELATED: (.*?)\]\s*", re.DOTALL)

# Split after sentence-ending punctuation followed by a capital/number/quote.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])")
_MAX_SENTENCES_PER_FACT = 3

# Whole-line headings (markdown ATX, or a short numbered title such as
# "6.1.2 Analogue v Digital") that must never reach the writer: foreign
# documents inside the source can contribute their own section headings,
# which the model then copies verbatim into the generated report.
_ATX_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+\S")
_NUMBERED_HEADING_RE = re.compile(r"^\s*\d+(?:\.\d+)*[.)]?\s+[A-Z]")


def _strip_heading_lines(text: str) -> str:
    """Drop heading lines from ``text``; prose is never touched."""
    kept: list[str] = []
    for line in text.splitlines():
        if _ATX_HEADING_RE.match(line):
            continue
        stripped = line.strip()
        if (
            _NUMBERED_HEADING_RE.match(stripped)
            and len(stripped.split()) <= 8
            and not stripped.endswith((".", "!", "?"))
        ):
            continue
        kept.append(line)
    return "\n".join(kept)


def _source_and_body(text: str) -> tuple[str, str]:
    """Split provenance tag from content; fall back to ``source report``."""
    web = _WEB_PREFIX_RE.match(text)
    if web:
        return f"web: {web.group(1)}", text[web.end():]
    research = _RESEARCH_PREFIX_RE.match(text)
    if research:
        return "research notes", text[research.end():]
    related = _RELATED_PREFIX_RE.match(text)
    if related:
        return f"related section: {related.group(1)}", text[related.end():]
    return "source report", text


def _split_sentences(body: str) -> list[str]:
    """Split into sentence groups of 1-3 sentences within the size cap."""
    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(body) if s.strip()]
    groups: list[str] = []
    current: list[str] = []
    for sentence in sentences:
        current.append(sentence)
        joined = " ".join(current)
        if len(joined) <= config.EVIDENCE_MAX_CHARS_PER_FACT:
            continue
        # Overflow: keep sentences so far (if any), start a fresh group.
        if len(current) > 1:
            groups.append(" ".join(current[:-1]))
            current = [current[-1]]
        else:
            groups.append(joined[: config.EVIDENCE_MAX_CHARS_PER_FACT])
            current = []
        if len(current) == _MAX_SENTENCES_PER_FACT:
            groups.append(" ".join(current))
            current = []
    if current:
        groups.append(" ".join(current))
    return groups


def build_facts(
    chunks: list[ScoredChunk],
    *,
    max_facts: int = config.EVIDENCE_MAX_FACTS,
    max_total_chars: int = config.EVIDENCE_MAX_TOTAL_CHARS,
) -> list[Fact]:
    """Convert chunks into capped, deduplicated facts with provenance."""
    facts: list[Fact] = []
    seen: set[str] = set()
    used = 0

    for chunk in chunks:
        source, body = _source_and_body(chunk.text)
        body = _strip_heading_lines(body)
        for group in _split_sentences(body):
            if config.CLEAN_EVIDENCE:
                group = cleaner.clean(group)
            if not group:
                continue
            key = " ".join(group.lower().split())
            if key in seen:
                continue
            if len(facts) >= max_facts or used + len(group) > max_total_chars:
                return facts
            seen.add(key)
            facts.append(Fact(text=group, source=source))
            used += len(group)
    return facts
