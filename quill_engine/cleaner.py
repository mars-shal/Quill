"""Service — Cleaner: scrub boilerplate from retrieved text (Stage 4).

The writer must never see raw retrieved text. ``clean()`` removes
metadata (ISBN/DOI/copyright/photo credits), navigation and TOC
fragments, bare URLs, retrieval IDs, page counters, and citation
blocks, while leaving prose and markdown structure (tables, lists)
intact. Conservative by design: any line that contains sentence
punctuation is kept unless it matches an explicit metadata pattern.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Line-level metadata patterns (dropped regardless of sentence punctuation)
# ---------------------------------------------------------------------------

_ISBN_RE = re.compile(r"^\s*(?:ISBN|ISSN|E-?ISBN)[-:]?\s*[\dXx -]{10,}\s*$")
_DOI_RE = re.compile(r"^\s*DOI:?\s*\S+\s*$")
_PAGE_RE = re.compile(r"^\s*Page\s+\d+\s*(?:of\s+\d+)?\s*$")
_COPYRIGHT_RE = re.compile(
    r"^\s*(?:©|\(c\)|Copyright|All rights reserved|"
    r"Cover (?:photo|image)|Photo credit|Image credit|"
    r"Front cover (?:photo|image))",
    re.IGNORECASE,
)
# "Please cite this publication as: <full citation>" — drop the line and every
# line after it until the next blank line (the citation block).
_CITE_BLOCK_RE = re.compile(r"^\s*Please cite this (?:publication|book|report|work)", re.IGNORECASE)
# Breadcrumb/title-bar artifact, e.g. BLS "Nuclear Engineers : Occupational
# Outlook Handbook: : U.S. Bureau of Labor Statistics".
_BREADCRUMB_RE = re.compile(r":\s*:")
# Label whose content was scrubbed away (e.g. "Source: <url>"), or a bare
# heading label like "References:" with no body on the line.
_BARE_LABEL_RE = re.compile(r"^\s*[A-Za-z][A-Za-z0-9 &.'-]*:\s*$")

# ---------------------------------------------------------------------------
# Inline token scrubbing (removed anywhere inside a kept line)
# ---------------------------------------------------------------------------

_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
_WWW_RE = re.compile(r"\bwww\.\S+", re.IGNORECASE)
# Retrieval/content IDs like sec_8762b3f1a4c9 or chk_... that leak internal
# identifiers into prompts. Min length 8 so real words (web_search) survive.
_RETRIEVAL_ID_RE = re.compile(r"\b(?:sec|chk|vec|proj|doc)_[a-zA-Z0-9_-]{8,}\b")

# ---------------------------------------------------------------------------
# Navigation / TOC fragment detection (no sentence punctuation, short,
# all title-cased words or known boilerplate phrases).
# ---------------------------------------------------------------------------

_NAV_PHRASES = {
    "printer-friendly",
    "printer friendly",
    "skip to content",
    "skip navigation",
    "on this page",
    "in this article",
    "in this chapter",
    "table of contents",
    "related topics",
    "more on this topic",
    "share this page",
    "was this page helpful",
    "is this page useful",
    "back to top",
    "jump to",
    "read online",
    "download pdf",
    "view pdf",
    "print",
    "share",
    "cite",
    "feedback",
    "sign in",
    "sign up",
    "log in",
    "subscribe",
    "contents",
    "overview",
    "similar occupations",
    "more information",
    "what to know",
    "important facts",
    "key takeaways",
}

# Lowercase words allowed inside a short title-cased nav fragment.
_CONNECTOR_WORDS = {
    "of",
    "the",
    "and",
    "in",
    "on",
    "to",
    "a",
    "an",
    "for",
    "with",
    "at",
    "by",
    "from",
}
_TITLE_WORD_RE = re.compile(r"[A-Z][A-Za-z0-9'\-]*")


def _is_nav_fragment(line: str) -> bool:
    """True for short title-cased lines without sentence punctuation."""
    s = line.strip().lstrip("-*• ").strip()
    if not s or len(s) > 48:
        return False
    lowered = s.lower().strip(".,;:!?")
    if lowered in _NAV_PHRASES:
        return True
    if s.endswith((".", ",", ";", ":", "!", "?")):
        return False
    words = s.split()
    if not 1 <= len(words) <= 4:
        return False
    has_title_word = False
    for word in words:
        if word in {"&", "—", "-"}:
            continue
        if word.lower() in _CONNECTOR_WORDS:
            continue
        if not _TITLE_WORD_RE.fullmatch(word):
            return False
        has_title_word = True
    return has_title_word


def _drop_metadata(line: str) -> bool:
    """True when the whole line is metadata boilerplate."""
    if _ISBN_RE.match(line) or _DOI_RE.match(line) or _PAGE_RE.match(line):
        return True
    if _COPYRIGHT_RE.match(line):
        return True
    if _BREADCRUMB_RE.search(line):
        return True
    return False


def _scrub_tokens(line: str) -> str:
    """Remove inline URLs, www links, and retrieval IDs, then tidy spaces."""
    s = _URL_RE.sub("", line)
    s = _WWW_RE.sub("", s)
    s = _RETRIEVAL_ID_RE.sub("", s)
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


def clean(text: str) -> str:
    """Strip boilerplate from retrieved text while keeping prose intact."""
    if not text:
        return text

    lines: list[str] = []
    in_cite_block = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            in_cite_block = False
            lines.append("")
            continue
        if _CITE_BLOCK_RE.match(line):
            in_cite_block = True
            continue
        if in_cite_block:
            continue
        if _drop_metadata(line):
            continue
        scrubbed = _scrub_tokens(line)
        if not scrubbed or _BARE_LABEL_RE.match(scrubbed):
            continue
        if _is_nav_fragment(scrubbed):
            continue
        lines.append(scrubbed)

    # Collapse blank runs and trim leading/trailing blank lines.
    out: list[str] = []
    blank_run = 0
    for line in lines:
        if not line:
            blank_run += 1
            if blank_run > 1:
                continue
            out.append("")
        else:
            blank_run = 0
            out.append(line)
    return "\n".join(out).strip()
