"""Layered AI-text risk estimation for assembled prose.

This is a screening tool, not a verdict. It measures the features that make
prose read as machine-written -- flat sentence rhythm, repeated openings, stock
transitions, no contractions, uniform paragraphs, few concrete numbers -- and
returns a 0-1 risk plus the paragraphs that carry the most of it. Corrections
are then aimed at those paragraphs instead of rewriting the whole document.

Detector APIs disagree with each other and with human readers. Nothing here
claims authorship; the score exists to decide *where* to spend editing effort.
"""

from __future__ import annotations

import math
import re
import statistics

_WORD = re.compile(r"[A-Za-z0-9']+")
_SENTENCE = re.compile(r"[^.!?]+[.!?]+(?:[\"'”’)\]]+)?")
_CONTRACTION = re.compile(r"\b[A-Za-z]+'(?:t|re|ve|ll|d|s|m)\b", re.IGNORECASE)
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+")
_LIST = re.compile(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+")
_FENCE = re.compile(r"^\s*```")

# Model-flavoured transitions and abstractions. Shared in spirit with
# `utilis.style`, repeated here so the detector has no import cycle and the
# list can grow without moving the public report.
_STOCK = (
    "furthermore",
    "moreover",
    "in addition",
    "additionally",
    "in conclusion",
    "it is important to note",
    "it is worth noting",
    "plays a crucial role",
    "plays a vital role",
    "in today's world",
    "in the realm of",
    "the landscape of",
    "a testament to",
    "delve into",
    "delves into",
    "multifaceted",
    "underscores the importance",
    "seamless integration",
    "robust framework",
    "pivotal role",
    "therefore",
    "thus",
    "consequently",
)

_FORMULAIC_OPENERS = (
    "this ",
    "these ",
    "it is ",
    "there is ",
    "there are ",
    "we ",
    "the ",
    "a ",
    "an ",
)

_TRIAD = re.compile(
    r"\b[\w-]+,\s+[\w-]+,\s+(?:and|or)\s+[\w-]+\b", re.IGNORECASE
)
_WE = re.compile(r"\b[Ww]e\b")


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def split_prose_blocks(markdown: str) -> list[dict]:
    """Split markdown into blocks, marking the ones prose editing may touch.

    Headings, lists, quotes, tables and fenced code are kept verbatim. Their
    index is preserved so a rewrite can be put back without reflowing the
    document.
    """
    blocks: list[str] = []
    current: list[str] = []
    fenced = False
    for line in (markdown or "").splitlines():
        if _FENCE.match(line):
            fenced = not fenced
            current.append(line)
            continue
        if fenced:
            current.append(line)
            continue
        if not line.strip():
            if current:
                blocks.append("\n".join(current))
                current = []
            continue
        current.append(line)
    if current:
        blocks.append("\n".join(current))

    result = []
    for index, block in enumerate(blocks):
        first = block.lstrip().splitlines()[0] if block.strip() else ""
        editable = not (
            _HEADING.match(first)
            or _LIST.match(first)
            or first.startswith(">")
            or first.startswith("|")
            or first.startswith("```")
        )
        result.append({"index": index, "text": block, "editable": editable})
    return result


def _sentences(text: str) -> list[str]:
    return [
        sentence.strip()
        for sentence in _SENTENCE.findall(text or "")
        if len(_WORD.findall(sentence)) >= 3
    ]


def _words(text: str) -> list[str]:
    return _WORD.findall((text or "").lower())


def _cv(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = statistics.fmean(values)
    return statistics.pstdev(values) / mean if mean else 0.0


def _share(part: int, whole: int) -> float:
    return part / whole if whole else 0.0


def _score_text(text: str) -> dict:
    words = _words(text)
    sentences = _sentences(text)
    lengths = [len(_words(sentence)) for sentence in sentences]
    word_count = len(words)
    low = (text or "").lower()

    if len(sentences) < 3 or word_count < 30:
        return {"risk": 0.0, "signals": {}, "sentences": len(sentences), "words": word_count}

    sentence_cv = _cv(lengths)
    mean_length = statistics.fmean(lengths)

    openings: dict[str, int] = {}
    for sentence in sentences:
        first = (_words(sentence) or [""])[0]
        openings[first] = openings.get(first, 0) + 1
    top_opening, top_count = max(openings.items(), key=lambda item: item[1])
    opener_share = _share(top_count, len(sentences))

    formulaic = sum(
        1 for sentence in sentences
        if any(str(sentence).lower().startswith(prefix) for prefix in _FORMULAIC_OPENERS)
    )
    stock = sum(1 for phrase in _STOCK if phrase in low)
    contractions = len(_CONTRACTION.findall(text or ""))
    triads = len(_TRIAD.findall(text or ""))
    we_share = _share(len(_WE.findall(text or "")), max(1, word_count / 100))
    digits = _share(sum(1 for word in words if any(ch.isdigit() for ch in word)), word_count)
    subordinators = sum(
        1
        for sentence in sentences
        if any(
            marker in f" {sentence.lower()} "
            for marker in (
                " because ", " although ", " while ", " whereas ", " which ",
                " who ", " when ", " if ", " unless ", " since ", " after ",
                " before ", " though ",
            )
        )
    )
    punctuation = sum((text or "").count(ch) for ch in ";:—–()?!")

    risk = 0.10
    if sentence_cv < 0.24:
        risk += 0.22
    elif sentence_cv < 0.32:
        risk += 0.12
    elif sentence_cv > 0.55:
        risk -= 0.08
    if 12 <= mean_length <= 22:
        risk += 0.06
    if opener_share >= 0.35:
        risk += 0.18
    elif opener_share >= 0.24:
        risk += 0.09
    if _share(formulaic, len(sentences)) >= 0.45:
        risk += 0.12
    risk += min(0.18, 0.03 * stock)
    if contractions == 0 and word_count >= 150:
        risk += 0.08
    elif _share(contractions, word_count) >= 0.004:
        risk -= 0.05
    if triads and word_count >= 150:
        risk += min(0.10, 0.03 * triads)
    if we_share >= 1.6:
        risk += 0.07
    if digits == 0 and word_count >= 200:
        risk += 0.05
    elif digits >= 0.015:
        risk -= 0.05
    if word_count >= 100:
        # Formal academic prose can be plain, but a whole passage with no
        # semicolon, dash, bracket, question or exclamation is a machine's
        # punctuation palette, not a writer's.
        if punctuation == 0:
            risk += 0.15
        elif _share(punctuation, word_count / 100) >= 0.3:
            risk -= 0.04
        subordinate_share = _share(subordinators, len(sentences))
        if subordinate_share < 0.25:
            risk += 0.12
        elif subordinate_share < 0.4:
            risk += 0.06

    return {
        "risk": round(_clamp(risk), 3),
        "words": word_count,
        "sentences": len(sentences),
        "signals": {
            "sentence_length_cv": round(sentence_cv, 3),
            "mean_sentence_words": round(mean_length, 1),
            "top_opening": top_opening,
            "top_opening_share": round(opener_share, 3),
            "formulaic_opening_share": round(_share(formulaic, len(sentences)), 3),
            "stock_phrases": stock,
            "contractions_per_1000": round(_share(contractions, word_count) * 1000, 2),
            "triads": triads,
            "we_per_100_words": round(we_share, 2),
            "numeric_word_share": round(digits, 3),
            "subordinate_sentence_share": round(_share(subordinators, len(sentences)), 3),
            "punctuation_marks": punctuation,
        },
    }


def detect(markdown: str) -> dict:
    """Return a document risk and a per-paragraph triage list.

    ``risk`` is 0-1. Paragraph entries carry the reasons that raised them, so a
    correction pass (or a reader) can see why a block was chosen.
    """
    document = _score_text(markdown)
    blocks = split_prose_blocks(markdown)
    paragraphs = []
    for block in blocks:
        if not block["editable"]:
            continue
        local = _score_text(block["text"])
        if local["sentences"] < 3:
            continue
        # Short paragraphs are noisy on their own; lean on the document when a
        # block is too small to judge.
        weight = min(1.0, local["words"] / 120)
        risk = _clamp(local["risk"] * (0.55 + 0.45 * weight) + document["risk"] * (0.45 - 0.45 * weight))
        reasons = []
        signals = local["signals"]
        if signals.get("sentence_length_cv", 1) < 0.28:
            reasons.append("even sentence lengths")
        if signals.get("top_opening_share", 0) >= 0.3:
            reasons.append(f"repeated opening “{signals.get('top_opening')}”")
        if signals.get("stock_phrases", 0):
            reasons.append(f"{signals['stock_phrases']} stock phrase(s)")
        if signals.get("contractions_per_1000", 0) == 0:
            reasons.append("no contractions")
        if signals.get("triads", 0):
            reasons.append(f"{signals['triads']} triad(s)")
        paragraphs.append({
            "index": block["index"],
            "text": block["text"],
            "risk": round(risk, 3),
            "words": local["words"],
            "reasons": reasons,
        })
    paragraphs.sort(key=lambda row: row["risk"], reverse=True)

    risk = document["risk"]
    if paragraphs:
        # The document average hides one or two very mechanical paragraphs;
        # weight the worst quartile so triage has something to act on.
        worst = statistics.fmean(row["risk"] for row in paragraphs[: max(1, len(paragraphs) // 4)])
        risk = round(_clamp(0.65 * risk + 0.35 * worst), 3)

    return {
        "risk": risk,
        "verdict": _verdict(risk),
        "signals": document["signals"],
        "words": document["words"],
        "sentences": document["sentences"],
        "paragraphs": paragraphs,
        "note": "A screening estimate for editing, not an authorship verdict.",
    }


def _verdict(risk: float) -> str:
    if risk >= 0.75:
        return "high"
    if risk >= 0.55:
        return "elevated"
    if risk >= 0.35:
        return "mixed"
    return "low"
