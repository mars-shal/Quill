"""Natural-voice review for assembled prose.

This is a readability and craft check, not an authorship detector. It measures
the things a reader notices as "templated" -- flat sentence rhythm, repeated
openings, stock transitions, uniform paragraphs -- and reports them with a
concrete next step. It deliberately does not score perplexity or try to predict
an AI detector: detector output is unstable and is not evidence about authorship.
"""

from __future__ import annotations

import re
import statistics

# Stock transitions and model-flavoured phrases. The list is deliberately short
# and editorial: a phrase is only flagged when it is doing no work in the
# sentence, so the report has a fix the writer can apply.
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
    "navigate the",
    "multifaceted",
    "underscores the importance",
    "seamless integration",
    "robust framework",
    "pivotal role",
)

_SENTENCE = re.compile(r"[^.!?]+[.!?]+(?:[\"'”’)\]]+)?")
_WORD = re.compile(r"[A-Za-z0-9']+")


def _sentences(text: str) -> list[str]:
    cleaned = re.sub(r"```.*?```", " ", text or "", flags=re.S)
    cleaned = re.sub(r"`[^`]*`", " ", cleaned)
    cleaned = re.sub(r"^#{1,6}\s+.*$", "", cleaned, flags=re.M)
    return [s.strip() for s in _SENTENCE.findall(cleaned) if len(_WORD.findall(s)) >= 3]


def _paragraphs(text: str) -> list[str]:
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text or "") if b.strip()]
    return [b for b in blocks if not re.match(r"^#{1,6}\s+", b) and not b.startswith(">")]


def _words(text: str) -> list[str]:
    return _WORD.findall((text or "").lower())


def _coefficient_of_variation(values: list[float]) -> float:
    if len(values) < 2 or not values:
        return 0.0
    mean = statistics.fmean(values)
    if mean <= 0:
        return 0.0
    return statistics.pstdev(values) / mean


def _opening(sentence: str) -> str:
    words = _words(sentence)
    return words[0] if words else ""


def analyse(text: str) -> dict:
    """Return a natural-voice report for ``text``.

    The score is 0-100 and rises with variation, specificity and a lower
    dependency on stock transitions. It is not a probability and should never be
    presented as one.
    """
    sentences = _sentences(text)
    paragraphs = _paragraphs(text)
    words = _words(text)
    lengths = [len(_words(s)) for s in sentences]
    para_lengths = [len(_words(p)) for p in paragraphs]

    openings: dict[str, int] = {}
    for sentence in sentences:
        first = _opening(sentence)
        if first:
            openings[first] = openings.get(first, 0) + 1

    total_sentences = len(sentences) or 1
    repeated = sorted(
        ({"opening": word, "count": count, "share": round(count / total_sentences, 3)}
         for word, count in openings.items() if count >= 3 and count / total_sentences >= 0.2),
        key=lambda row: (-row["count"], row["opening"]),
    )[:5]

    low = (text or "").lower()
    stock = [phrase for phrase in _STOCK if phrase in low]
    short = sum(1 for n in lengths if n <= 10)
    long = sum(1 for n in lengths if n >= 35)
    word_count = len(words)
    stock_share = round(len(stock) * 100 / max(1, word_count / 100), 2)

    findings: list[dict] = []
    score = 100

    sentence_cv = _coefficient_of_variation(lengths)
    if sentence_cv < 0.25 and len(lengths) >= 8:
        score -= 20
        findings.append({
            "key": "sentence_rhythm",
            "label": "Sentence rhythm is flat",
            "detail": f"Length varies by only {sentence_cv:.0%} around the mean "
                      f"({statistics.fmean(lengths):.0f} words).",
            "advice": "Mix one short sentence into a run of longer ones, and let a "
                      "paragraph end on a shorter claim.",
        })
    elif sentence_cv < 0.38 and len(lengths) >= 8:
        score -= 8
        findings.append({
            "key": "sentence_rhythm",
            "label": "Sentence rhythm is a little even",
            "detail": f"Length variation is {sentence_cv:.0%}.",
            "advice": "Vary sentence length where the argument changes direction.",
        })

    paragraph_cv = _coefficient_of_variation(para_lengths)
    if paragraph_cv < 0.22 and len(para_lengths) >= 4:
        score -= 10
        findings.append({
            "key": "paragraph_shape",
            "label": "Paragraphs are uniformly sized",
            "detail": "Paragraph lengths are nearly identical.",
            "advice": "Let one paragraph carry a single sharp point; let another "
                      "develop an example.",
        })

    if repeated:
        top = repeated[0]
        penalty = 20 if top["share"] >= 0.35 else 10
        score -= penalty
        findings.append({
            "key": "repeated_openings",
            "label": "Repeated sentence openings",
            "detail": f"\"{top['opening']}\" opens {top['count']} of {len(sentences)} "
                      f"sentences ({top['share']:.0%}).",
            "advice": "Reorder the sentence or lead with the subject, date or "
                      "evidence instead of the same connective.",
        })

    if stock:
        penalty = min(30, 5 * len(stock))
        score -= penalty
        findings.append({
            "key": "stock_phrases",
            "label": "Stock transitions and model phrases",
            "detail": ", ".join(stock[:8]),
            "advice": "Cut the phrase and let the next sentence do the linking; "
                      "replace abstractions with the concrete subject.",
        })

    if word_count and long / total_sentences >= 0.55:
        score -= 8
        findings.append({
            "key": "long_sentences",
            "label": "Most sentences are long",
            "detail": f"{len(long)} of {len(sentences)} sentences run 35+ words.",
            "advice": "Split the sentence at its second idea; keep the evidence in "
                      "the shorter half.",
        })

    # A few stock phrases can survive in otherwise varied prose; a cluster of
    # them is the pattern a reader hears as templated, so cap the verdict even
    # when the rhythm metrics are healthy.
    if len(stock) >= 4:
        score = min(score, 55)
    elif len(stock) >= 2:
        score = min(score, 75)
    if repeated and repeated[0]["share"] >= 0.35:
        score = min(score, 70)

    score = max(0, min(100, score))
    if score >= 80:
        verdict = "natural"
    elif score >= 60:
        verdict = "mixed"
    else:
        verdict = "robotic"

    issues = [finding["label"] for finding in findings]
    return {
        "score": score,
        "verdict": verdict,
        "metrics": {
            "words": word_count,
            "sentences": len(sentences),
            "paragraphs": len(paragraphs),
            "mean_sentence_words": round(statistics.fmean(lengths), 1) if lengths else 0,
            "sentence_length_cv": round(sentence_cv, 3),
            "short_sentence_share": round(short / total_sentences, 3),
            "long_sentence_share": round(long / total_sentences, 3),
            "paragraph_length_cv": round(paragraph_cv, 3),
            "stock_phrase_count": len(stock),
            "stock_phrase_share_per_100_words": stock_share,
        },
        "repeated_openings": repeated,
        "stock_phrases": stock,
        "findings": findings,
        "issues": issues,
        "note": "A craft signal, not an authorship probability. Detector scores "
                "are not evidence of who wrote a text and are not optimised here.",
    }


def to_markdown(report: dict) -> str:
    """Render the natural-voice report for the review artifact."""
    lines = [
        "# Natural voice review",
        "",
        f"**{report.get('score', 0)}/100 · {report.get('verdict', 'unknown')}**",
        "",
        report.get("note", ""),
        "",
        "## Signals",
    ]
    metrics = report.get("metrics") or {}
    for label, key in (
        ("Words", "words"),
        ("Sentences", "sentences"),
        ("Paragraphs", "paragraphs"),
        ("Mean sentence length", "mean_sentence_words"),
        ("Sentence length variation", "sentence_length_cv"),
        ("Stock phrase count", "stock_phrase_count"),
    ):
        lines.append(f"- **{label}:** {metrics.get(key, 0)}")
    findings = report.get("findings") or []
    if findings:
        lines += ["", "## Findings"]
        for finding in findings:
            lines += [
                f"### {finding.get('label', 'Finding')}",
                finding.get("detail", ""),
                "",
                f"**Fix:** {finding.get('advice', '')}",
                "",
            ]
    else:
        lines += ["", "No rhythm, repetition or stock-phrase findings."]
    return "\n".join(lines).rstrip() + "\n"
