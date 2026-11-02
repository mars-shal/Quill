"""Coherence scoring for generated prose.

Small models fail in recognisable ways even when handed real, on-topic
research: they refuse outright, repeat a single token, or echo the writing
prompt back as if it were content. These signals are structural rather than
tied to any one phrasing, so they generalise when the model refuses in
different words.

Dictionary coverage is deliberately NOT used. Measured on a real bad
document it scored 89.9% against 94.1% for clean prose, because UI chrome
words like "confirm" and "save" are valid dictionary entries.
"""

from __future__ import annotations

import re
from collections import Counter

# Structural refusal markers: first person combined with an apology or a
# statement of incapability. Kept loose on purpose.
_REFUSAL = re.compile(
    r"\b(?:i|we)\s*(?:'m|'re|\s+am|\s+are)?\s*"
    r"(?:so\s+|very\s+)?"
    r"(?:sorry|afraid|unable|incapable)\b"
    r"|\bi\s+(?:cannot|can't|can\s+not|am\s+unable\s+to|am\s+not\s+able\s+to)\b"
    r"|\bas\s+an?\s+(?:ai|llm|language\s+model|assistant|chatbot)\b"
    r"|\bi\s+(?:do\s+not|don't)\s+have\s+(?:the\s+)?(?:ability|access)\b"
    r"|\bit'?s\s+(?:not\s+possible|outside\s+my|not\s+within\s+my|"
    r"beyond\s+my)\b"
    r"|\bi\s+was\s+(?:trained|designed|programmed)\s+to\b"
    # Meta-commentary about the assistant's own process or its inability to
    # proceed. Without these, "I tried my hardest to synthesize..." scores as
    # clean prose despite being a non-answer.
    r"|\bi\s+(?:tried|attempted|struggled|will\s+try)\b"
    r"|\bi\s+(?:hope|think|believe|guess)\s+(?:this|that|it)\s+"
    r"(?:helps|is\s+helpful|works|makes\s+sense)\b"
    r"|\b(?:please\s+)?(?:provide|clarify|specify|supply|share)\s+"
    r"(?:more|additional|the|a)\s+(?:information|context|details|"
    r"insight|perspective)\b",
    re.IGNORECASE,
)

# Web/UI chrome vocabulary. Density-based, not presence-based, so ordinary
# prose that happens to mention "save" once is unaffected.
_CHROME = re.compile(
    r"\b(?:confirm|cancel|save|accept|reject|agree|delete|remove|submit|"
    r"permission|permissions|unsubscribe|sign\s?in|log\s?in|sign\s?out|"
    r"click|tap|button|dropdown|checkbox|username|password|email\s+address|"
    r"kindle|preview|download\s+items|requesting|verifying|unconfirmed|"
    r"bookmark|toolbar|browser|cookie|privacy\s+policy|terms\s+of\s+use|"
    r"subscribe|subscription|inbox|draft)\b",
    re.IGNORECASE,
)

_SYMBOL_NOISE = re.compile(r"[×✕✖✔☑]")

_WORD = re.compile(r"[A-Za-z']+")
_SENTENCE = re.compile(r"[.!?]+(?:\s|$)")

# Thresholds calibrated against clean control prose (TTR 0.83, top share
# 0.09, no refusal/chrome hits) versus observed bad output (TTR down to
# 0.20, top share up to 0.70, four refusals, one block at 131 chrome hits).
TTR_FLOOR = 0.55
TOP_SHARE_CEILING = 0.25
CHROME_DENSITY_CEILING = 0.05
ECHO_OVERLAP_CEILING = 0.60
MIN_WORDS = 12
NGRAM = 8

SEVERITY = {"coherent": 0, "degraded": 1, "incoherent": 2}


def _ngrams(words: list[str], size: int = NGRAM) -> set[tuple[str, ...]]:
    if len(words) < size:
        return set()
    return {tuple(words[i : i + size]) for i in range(len(words) - size + 1)}


def echo_overlap(text: str, template: str) -> float:
    """Fraction of the text's n-grams that appear in the writing template.

    Catches the model regurgitating the prompt back as content. Generalises
    because the template lives in this codebase, not in observed output.
    """
    if not template:
        return 0.0
    body = _WORD.findall(text.lower())
    reference = _WORD.findall(template.lower())
    if not body or not reference:
        return 0.0
    grams, reference_grams = _ngrams(body), _ngrams(reference)
    if not grams:
        return 0.0
    return round(len(grams & reference_grams) / len(grams), 3)


def chrome_density(text: str) -> float:
    words = _WORD.findall(text)
    if not words:
        return 0.0
    hits = len(_CHROME.findall(text))
    return round(hits / len(words), 4)


def score_text(text: str, template: str = "") -> dict:
    """Score one block of prose. Returns signals plus a verdict."""
    body = (text or "").strip()
    words = _WORD.findall(body.lower())
    n = len(words)

    if n < MIN_WORDS:
        return {
            "words": n,
            "verdict": "incoherent",
            "reasons": ["too short to assess" if n else "empty"],
            "ttr": 0.0,
            "top_share": 0.0,
            "refusal": False,
            "echo": 0.0,
            "chrome": 0.0,
            "symbol_noise": 0,
        }

    counts = Counter(words)
    ttr = round(len(counts) / n, 3)
    top_word, top_count = counts.most_common(1)[0]
    top_share = round(top_count / n, 3)

    refusal = bool(_REFUSAL.search(body))
    echo = echo_overlap(body, template)
    chrome = chrome_density(body)
    symbol_noise = len(_SYMBOL_NOISE.findall(body))

    sentences = [s for s in _SENTENCE.split(body) if s.strip()]
    mean_sentence = round(n / len(sentences), 1) if sentences else float(n)

    reasons: list[str] = []
    if refusal:
        reasons.append("refusal or apology language")
    if ttr < TTR_FLOOR:
        reasons.append(f"low lexical diversity (ttr {ttr})")
    if top_share > TOP_SHARE_CEILING:
        reasons.append(f"single token dominates ({top_word!r} {int(top_share * 100)}%)")
    if chrome > CHROME_DENSITY_CEILING:
        reasons.append(f"web/UI vocabulary density {chrome:.1%}")
    if echo > ECHO_OVERLAP_CEILING:
        reasons.append(f"echoes the writing prompt ({int(echo * 100)}% overlap)")
    if symbol_noise >= 3:
        reasons.append(f"symbol noise ({symbol_noise} glyphs)")

    severe = refusal or len(reasons) >= 2
    if severe:
        verdict = "incoherent"
    elif reasons:
        verdict = "degraded"
    else:
        verdict = "coherent"

    return {
        "words": n,
        "verdict": verdict,
        "reasons": reasons,
        "ttr": ttr,
        "top_share": top_share,
        "top_word": top_word,
        "refusal": refusal,
        "echo": echo,
        "chrome": chrome,
        "symbol_noise": symbol_noise,
        "mean_sentence_words": mean_sentence,
    }


def worst(verdicts: list[str]) -> str:
    if not verdicts:
        return "coherent"
    return max(verdicts, key=lambda v: SEVERITY.get(v, 0))
