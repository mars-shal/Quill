"""Corpus-coverage maths for the gap-research loop.

The question this module answers is narrow and was chosen because plain token
overlap answers it WRONG. Given a section's title and claim, and the research
corpus, *which of the section's terms is the corpus unable to support?*

Why plain overlap fails (measured, not assumed)
-----------------------------------------------
Per-section coverage was measured against two real runs, placeholder sections
labelled PH and genuinely written sections WRT
(``artifacts/drift/manual-qa.txt``):

  * ``output/Desimation-of-the-Stadium-of-Rome.md``: placeholder sections
    averaged 0.717 coverage and **two scored a PERFECT 1.000** - "Physical
    Deterioration Leading to Demolition" and "Legacy and Urban
    Redevelopment" - because "deterioration", "legacy" and "redevelopment"
    occur all over a stadium corpus. The written sections averaged only 0.861.
  * ``.../Demolition-of-the-Stadio-Dei-Marmi-in-Rome.md``: placeholders
    averaged 0.644 against 0.809 for written sections (AUC 0.764).

So plain overlap rates the placeholder sections among the BEST-supported ones
in the document. Their words were present; the *facts* were not. A term whose
presence is uninformative has to be discarded before a search is designed from
it, and the only evidence that a term's presence is uninformative is that the
term is in nearly every page. Hence rarity, measured as document frequency
across pages, not frequency in one concatenated blob: "legacy" occurs 400 times
in 30 pages and 400 times in one page, and only the first number says it
supports nothing.

This is NOT the corpus-prediction gate that was measured at AUC 0.764 and
deleted (the gate that tried to *predict* which sections would fail). Nothing
here predicts anything: the caller already knows a section failed - the writer
emitted a placeholder for it. This only chooses what to search for next, and it
is free: no LLM call, no network, no clock.

What is deliberately NOT here
----------------------------
A threshold that turns "term is missing" into "section will fail". That is the
deleted gate, and the same artefact that measured it records why it must not
come back: its best operating point killed 6 of 12 written sections on the
healthy document. Absence of a term is evidence about the CORPUS, never a
verdict about the section.
"""

from __future__ import annotations

import math
import os
import re
from typing import Callable, Iterable, Sequence

__all__ = [
    "UBIQUITY_FRACTION",
    "content_tokens",
    "document_frequency",
    "gap_research_enabled",
    "gap_research_pages_budget",
    "gap_research_queries_budget",
    "gap_research_sections_budget",
    "page_blocks",
    "ranked_missing_terms",
]

# A term carried by this fraction of pages or more is treated as ubiquitous:
# it tells the loop nothing about what to search for. 0.5 rather than 0.9
# because pages in a weak corpus repeat each other's boilerplate, and a term
# in half the pages is already doing no work as a search term. Raising it makes
# the loop research more and buy less.
UBIQUITY_FRACTION = 0.5

# Shortest token that can be searched for. ``_content_tokens`` admits 3
# characters ("pre", "law", "gio"); searching those adds noise without adding a
# way to reach the missing fact.
MIN_TERM_LEN = 4

# Planner framing vocabulary. A section's *claim* is written by the LLM
# planner from a prompt full of instruction words ("Establish ...", "Identify
# ...") and none of those words are about the subject, so when they are absent
# from the corpus they look maximally distinctive while being worthless as a
# search term. "Establish what the research shows about the requested topic"
# has no missing *term*; it has no missing *fact*, and that difference is what
# this loop exists to notice. Small on purpose: a large invented stoplist would
# quietly delete real subject vocabulary.
_FRAME_TERMS = frozenset(
    {
        "about", "across", "after", "also", "among", "analysed", "analyze",
        "analyzed", "appears", "apply", "approach", "argue", "argument",
        "assessment", "assess", "beyond", "chapter", "claim", "claims",
        "clear", "compare", "compared", "consider", "considered", "context",
        "contribute", "data", "define", "defined", "definition", "describe",
        "described", "detail", "details", "determine", "develop", "discuss",
        "discussed", "document", "effect", "effects", "enough", "establish",
        "established", "evaluate", "evaluated", "evidence", "exam", "examine",
        "examined", "explain", "explained", "explain", "explore", "explored",
        "factor", "factors", "focus", "focused", "framework", "further",
        "general", "given", "highlight", "identify", "identified", "impact",
        "implication", "implications", "importance", "important", "include",
        "including", "indicate", "indicated", "individual", "influence",
        "interpret", "issue", "issues", "key", "known", "level", "main",
        "matter", "meaning", "means", "mention", "method", "multiple",
        "narrative", "necessary", "need", "objective", "obtained", "occur",
        "occurred", "outline", "outlined", "overview", "particular",
        "particularly", "part", "perspective", "point", "possible", "potential",
        "present", "presented", "preliminary", "primary", "principal",
        "problem", "process", "provide", "provided", "provides", "purpose",
        "question", "questions", "range", "record", "recorded", "record",
        "regard", "relate", "related", "relationship", "requires", "research",
        "result", "results", "review", "role", "scope", "section", "sections",
        "sense", "series", "show", "shows", "shown", "significant",
        "significance", "similar", "situation", "specific", "specifically",
        "state", "states", "stated", "structure", "study", "subject", "such",
        "support", "supported", "term", "terms", "topic", "topics", "type",
        "types", "understanding", "used", "uses", "using", "various", "view",
        "whether", "within", "work", "would",
    }
)

_TRUE_VALUES = frozenset({"1", "true", "yes", "on", "enabled"})


def _flag(name: str, default: str = "") -> str:
    """Env value read at CALL time, never at import time.

    Import-time capture is how a stale flag survives an operator turning it off
    halfway through a debugging session, so every reader of this module reads
    the environment when it is asked, not when it is imported.
    """
    value = os.environ.get(name)
    return default if value is None else value


def gap_research_enabled() -> bool:
    """Whether the writer->research feedback loop may run at all.

    Default OFF. The loop exists because a placeholder section costs a wasted
    write; turning it on costs extra LLM calls (one per re-written section,
    see artifacts/gap-research/cost-model.md), and an operator has to be able
    to see that cost before paying it.
    """
    return _flag("QUILL_GAP_RESEARCH").strip().lower() in _TRUE_VALUES


def _budget(name: str, default: int, hard_max: int) -> int:
    """An int env budget, clamped to ``1..hard_max``.

    Clamped DOWN only: a value above the hard cap is ignored rather than
    honoured, so a typo cannot turn a bounded loop into an unbounded one. A
    garbage value falls back to the default instead of raising - a budget knob
    must never be the thing that breaks a run.
    """
    try:
        value = int(_flag(name, str(default)).strip())
    except (TypeError, ValueError):
        return default
    return max(1, min(value, hard_max))


def gap_research_queries_budget(default: int = 3, hard_max: int = 3) -> int:
    """Hard cap on queries issued by one targeted research round."""
    return _budget("QUILL_GAP_RESEARCH_QUERIES", default, hard_max)


def gap_research_pages_budget(default: int = 6, hard_max: int = 6) -> int:
    """Hard cap on pages a single targeted research round may add."""
    return _budget("QUILL_GAP_RESEARCH_PAGES", default, hard_max)


def gap_research_sections_budget(default: int = 3, hard_max: int = 5) -> int:
    """Hard cap on sections a single gap round may re-write.

    This is the only part of the loop that costs LLM tokens (see
    ``cost-model.md``), so it is the one that needs the hardest ceiling.
    """
    return _budget("QUILL_GAP_RESEARCH_SECTIONS", default, hard_max)


def content_tokens(text: str) -> set[str]:
    """Lowercase alphanumeric tokens, 3+ characters.

    The default tokeniser. ``ResearchEngine._content_tokens`` is passed in
    instead wherever it is available, so the loop tokenises exactly the way
    the query filter and the planner already do rather than maintaining a
    second, subtly different word list.
    """
    return {t for t in re.findall(r"[a-z0-9]{3,}", (text or "").lower())}


def page_blocks(corpus: str) -> list[str]:
    """Split a research corpus into its per-page blocks.

    Mirrors how ``ResearchEngine.run`` assembles the corpus
    (``"\\n\\n".join(f"[{title}] {snippet}\\n{text}")``), so one block is one
    page and document frequency means "pages containing this term".

    A mis-split degrades in the safe direction only. Fetched page text is
    whitespace-collapsed by ``_fetch`` so blank lines cannot appear inside a
    block, and if some future page ever carries one, the worst outcome is that
    terms get split across blocks and a genuinely present term is reported as
    missing - which costs one wasted query. It can never invent a term the
    corpus does not contain, because absence holds for every possible split.
    """
    blocks = []
    for chunk in re.split(r"\n\s*\n", corpus or ""):
        chunk = chunk.strip()
        if chunk:
            blocks.append(chunk)
    return blocks


def document_frequency(
    blocks: Sequence[str], tokenize: Callable[[str], Iterable[str]] | None = None
) -> dict[str, int]:
    """Count how many blocks each token appears in."""
    tokenize = tokenize or content_tokens
    counts: dict[str, int] = {}
    for block in blocks:
        for token in set(tokenize(block)):
            counts[token] = counts.get(token, 0) + 1
    return counts


_STEM_SUFFIXES = ("ings", "ing", "ments", "ment", "ness", "ed", "es", "s")


def _stem_key(token: str) -> str:
    """First 6 characters of the token with one plural/gerund suffix removed.

    Singular/plural is the only inflection the measured corpora actually need:
    on the 119-page run corpus "students" is carried by 61 pages while
    "student" is carried by 46, so without this a section titled "Student
    Engagement" would report "student" as missing and send a query after a word
    the corpus is saturated with.

    Crude on purpose. A wrong merge makes a term look MORE carried than it is,
    which costs one skipped query; the opposite mistake would cost a query
    chasing a word the corpus already has everywhere.
    """
    for suffix in _STEM_SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= 4:
            token = token[: -len(suffix)]
            break
    return token[:6]


def ranked_missing_terms(
    section_text: str,
    blocks: Sequence[str],
    *,
    tokenize: Callable[[str], Iterable[str]] | None = None,
    ubiquitous_fraction: float = UBIQUITY_FRACTION,
    min_len: int = MIN_TERM_LEN,
    limit: int | None = None,
) -> list[str]:
    """Distinctive terms of ``section_text`` that ``blocks`` cannot support.

    Ordered by rarity first (fewest pages first), then longest, then
    alphabetically - every tie-break explicit so the same section and corpus
    always produce the same list, and so the list is stable enough to compare
    between runs.

    Returns ``[]`` - and therefore no research, no queries, no cost - when:
      * the corpus is empty. With no pages, document frequency carries no
        information; the right answer there is a fresh research run, not a
        term-level patch.
      * every term is ubiquitous. This is the case plain overlap gets wrong,
        and the case the tests pin with the real section titles from the run
        that motivated this ("Legacy and Urban Redevelopment", "Physical
        Deterioration Leading to Demolition"): both are placeholders, and both
        must produce nothing.
      * every distinctive term is planner framing ("establish", "analyse").
    """
    blocks = list(blocks or [])
    if not blocks:
        return []
    tokenize = tokenize or content_tokens

    # Ceiling, not rounding: "in half the pages" must include half (2 of 5 pages),
    # and banker's rounding silently excluded it.
    ubiquitous_at = max(1, math.ceil(len(blocks) * float(ubiquitous_fraction)))
    frequencies = document_frequency(blocks, tokenize)
    # A term counts as carried if ANY token sharing its stem is carried, which
    # is what keeps "student" from reading as missing next to "students".
    carried_by_stem: dict[str, int] = {}
    for token, pages in frequencies.items():
        key = _stem_key(token)
        carried_by_stem[key] = max(carried_by_stem.get(key, 0), pages)

    seen: set[str] = set()
    missing: list[tuple[int, int, str]] = []
    for token in sorted(tokenize(section_text)):
        if len(token) < min_len or token in seen:
            continue
        seen.add(token)
        if token in _FRAME_TERMS:
            continue
        pages = max(
            frequencies.get(token, 0), carried_by_stem.get(_stem_key(token), 0)
        )
        if pages >= ubiquitous_at:
            continue  # ubiquitous: present, and therefore not a way to search
        missing.append((pages, -len(token), token))

    missing.sort()
    terms = [token for _pages, _neg_len, token in missing]
    return terms[:limit] if limit else terms