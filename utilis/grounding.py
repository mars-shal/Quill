"""Claim extraction and corpus grounding.

Small models confabulate plausible, specific, checkable detail: measurements,
dates, grants, named researchers. Detecting that needs a signal that measures
*groundedness* rather than fluency - coherence scoring happily passes an
invented grant number because it is well-formed English.

Two findings shaped this module:

1. Corpus-absence does NOT imply falsehood. In a real run the Colosseum's
   published dimension ("189") and the genuine 1349 earthquake year were both
   absent from the corpus, while an invented hypogeum area ("2,500") was equally
   absent. Absence is an *unverified* signal only, never a verdict.
2. Precision is only a fabrication signal in some domains. "0.6 m displacement"
   is absurd for an ancient structure but routine in an engineering report, so
   every precision rule is profile-gated.

Strict policy: a claim may only reach the output corroborated, escalated and
confirmed, or rewritten into something the corpus supports. Unresolved claims
remove the assertion; they are never tagged and passed through.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# --- extraction patterns ---------------------------------------------------

# A number with an optional unit/currency. Deliberately requires either a unit
# or a magnitude that reads as a measurement, so ordinals and list indices are
# not treated as claims.
_NUMERIC = re.compile(
    r"(?<![\w.])"
    r"(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)"
    r"\s*(?P<unit>"
    r"m²|m2|km²|km2|cm²|mm²|m|km|cm|mm|kg|g|tonnes?|tons?|%|"
    r"€|\$|£|°C|°F|"
    r"AD|BC|BCE|CE"
    r")?"
    r"(?![\w])",
    re.IGNORECASE,
)

_YEAR = re.compile(r"(?<![\d.])(?:AD\s*)?(1[0-9]{3}|20[0-9]{2}|[1-9][0-9]{2})\s*(?:AD|CE)?(?![\d])")

_TITLE_PERSON = re.compile(
    r"\b(?:Dr|Prof|Professor|Mr|Ms|Mrs)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})"
)
_INSTITUTION = re.compile(
    r"\b([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*){0,4})\s+"
    r"(University|Institute|Polytechnic|Academy|Council|Laboratory|"
    r"Laboratories|Faculty|College|Foundation|Society|Association)\b"
)
_GRANT = re.compile(
    r"[€$£]\s?[\d,]+(?:\s?(?:million|thousand|billion|m|bn|k))?"
    r"|\b(?:grant|award|funding|budget|allocation)\b[^.;]{0,60}",
    re.IGNORECASE,
)
_PRESS = re.compile(
    r"\b([A-Z][\w&.\-]+\s+Press|Journal of [A-Z][\w\s]{2,40}|"
    r"Transactions of [A-Z][\w\s]{2,40})\b"
)

# Straight and curly double quotes. Double quotes only: apostrophes are
# contractions ("it's"), not quotations.
_QUOTED = re.compile(r"[\"“]([^\"”\n]{4,120})[\"”]")

# Decimal precision: 0.6 m, 0.3%, 1.5 km. Suspicious for historical subjects.
_DECIMAL = re.compile(r"\b\d+\.\d+\s*(?:m|km|cm|mm|%|m²|m2|kg|°C)?\b", re.IGNORECASE)

_FILLER_UNITS = {"", "ad", "bc", "ce", "bce"}


@dataclass
class Profile:
    """Domain policy. Precision rules are only meaningful per domain."""

    name: str = "general"
    decimal_precision_is_signal: bool = False
    round_specificity_is_signal: bool = False
    authority_clusters_are_signal: bool = True
    external_search_cap: int = 3
    max_rewrite_attempts: int = 2

    @classmethod
    def detect(cls, concept: str = "", prompt: str = "") -> "Profile":
        """Heuristic profile choice. Always log the decision - a wrong guess
        silently disables precision checks."""
        blob = f"{concept} {prompt}".lower()
        history = any(
            k in blob
            for k in ("colosseum", "stadium", "amphitheatre", "amphitheater",
                      "roman", "empire", "ancient", "medieval", "archaeolog",
                      "heritage", "ruins", "monument", "dynasty", "civilisation",
                      "civilization", "antiquity")
        )
        engineering = any(
            k in blob
            for k in ("circuit", "sensor", "pcb", "embedded", "firmware",
                      "algorithm", "throughput", "latency", "microcontroller",
                      "simulation", "protocol", "bandwidth", "model")
        ) and not history
        if history:
            return cls(
                name="historical",
                decimal_precision_is_signal=True,
                round_specificity_is_signal=True,
            )
        if engineering:
            return cls(
                name="engineering",
                decimal_precision_is_signal=False,
                round_specificity_is_signal=False,
            )
        return cls(name="general")

    @classmethod
    def from_env(cls, fallback: "Profile | None" = None) -> "Profile":
        import os

        forced = os.environ.get("GROUNDING_PROFILE", "").strip().lower()
        if forced == "historical":
            return cls(name="historical", decimal_precision_is_signal=True,
                       round_specificity_is_signal=True)
        if forced == "engineering":
            return cls(name="engineering", decimal_precision_is_signal=False,
                       round_specificity_is_signal=False)
        if forced == "general":
            return cls(name="general")
        return fallback or cls()


@dataclass
class Claim:
    text: str
    kind: str                     # numeric | year | person | institution | grant | press | quote
    value: str = ""
    unit: str = ""
    signal: str = "absent"        # corroborated | absent | escalated
    precision_signal: bool = False
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "text": self.text[:80],
            "kind": self.kind,
            "value": self.value,
            "unit": self.unit,
            "signal": self.signal,
            "precision_signal": self.precision_signal,
            "detail": self.detail,
        }


# --- extraction ------------------------------------------------------------

def _clean_number(raw: str) -> str:
    return raw.replace(",", "")


def extract_claims(text: str, profile: Profile | None = None) -> list[Claim]:
    """Deterministically pull checkable claims out of prose. No LLM involved."""
    profile = profile or Profile()
    claims: list[Claim] = []
    seen: set[tuple[str, str]] = set()

    def push(claim: Claim) -> None:
        key = (claim.kind, claim.text.lower())
        if key not in seen:
            seen.add(key)
            claims.append(claim)

    for match in _YEAR.finditer(text or ""):
        year = match.group(1)
        ctx = _sentence_around(text, match.start(), match.end())
        push(Claim(text=match.group(0).strip(), kind="year", value=year, detail=ctx))

    for match in _NUMERIC.finditer(text or ""):
        unit = (match.group("unit") or "").strip()
        num = _clean_number(match.group("num"))
        if not unit and len(num) < 3:
            continue  # bare small integers are ordinals, not measurements
        if unit.lower() in _FILLER_UNITS and len(num) < 4:
            continue
        ctx = _sentence_around(text, match.start(), match.end())
        claim = Claim(
            text=match.group(0).strip(), kind="numeric", value=num, unit=unit, detail=ctx
        )
        claim.precision_signal = bool(_DECIMAL.fullmatch(match.group(0).strip()))
        push(claim)

    for match in _TITLE_PERSON.finditer(text or ""):
        push(Claim(
            text=match.group(0).strip(), kind="person",
            value=match.group(1), detail=_sentence_around(text, match.start(), match.end()),
        ))

    for match in _INSTITUTION.finditer(text or ""):
        push(Claim(
            text=match.group(0).strip(), kind="institution",
            value=f"{match.group(1)} {match.group(2)}",
            detail=_sentence_around(text, match.start(), match.end()),
        ))

    for match in _GRANT.finditer(text or ""):
        push(Claim(
            text=match.group(0).strip()[:80], kind="grant", value=match.group(0).strip()[:40],
            detail=_sentence_around(text, match.start(), match.end()),
        ))

    for match in _PRESS.finditer(text or ""):
        push(Claim(
            text=match.group(0).strip(), kind="press", value=match.group(1),
            detail=_sentence_around(text, match.start(), match.end()),
        ))

    for match in _QUOTED.finditer(text or ""):
        value = match.group(1).strip(" ,.;:!?")
        # Letter guard: pure-number quotes ("2014") are already year claims.
        if len(value) < 3 or not re.search(r"[A-Za-z]", value):
            continue
        push(Claim(
            text=match.group(0).strip(), kind="quote", value=value,
            detail=_sentence_around(text, match.start(), match.end()),
        ))

    if profile.round_specificity_is_signal:
        for claim in claims:
            if claim.kind == "numeric" and not claim.precision_signal and claim.unit:
                if "." not in claim.value and len(claim.value) >= 3:
                    claim.precision_signal = True
                    claim.detail = claim.detail or "round/precise measurement"
    if profile.decimal_precision_is_signal:
        for claim in claims:
            if claim.kind in ("numeric", "year") and "." in claim.value:
                claim.precision_signal = True
    return claims


def _sentence_around(text: str, start: int, end: int, width: int = 160) -> str:
    """The sentence containing the claim.

    A fixed-width window bleeds into neighbouring sentences, and when those are
    fabricated it poisons the anchor vocabulary - which silently suppressed
    corroboration for genuine figures sitting next to invented ones.
    """
    text = text or ""
    left = text.rfind(".", 0, start)
    left = 0 if left == -1 else left + 1
    nxt = text.find(".", end)
    right = len(text) if nxt == -1 else nxt + 1
    for boundary in ("\n", ";"):
        cut = text.find(boundary, start)
        if cut != -1 and cut < right:
            right = cut + 1
    sentence = text[left:right].strip()
    if len(sentence) > width * 3:
        sentence = sentence[: width * 3]
    return sentence.replace("\n", " ").strip()


# --- corroboration ---------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")


def _norm_tokens(value: str) -> list[str]:
    return _WORD.findall((value or "").lower())


def _norm_corpus(corpus: str) -> str:
    """Aggressively normalised corpus for containment tests."""
    return " " + re.sub(r"[^a-z0-9%.\-]+", " ", (corpus or "").lower()) + " "


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class _CorpusIndex:
    """Token index over the corpus, built once and reused across claims."""

    _cache: dict = {}

    def __init__(self, corpus: str):
        self.tokens = _norm_tokens(corpus)
        self.joined = " " + " ".join(self.tokens) + " "
        self.lower_text = (corpus or "").lower()

    @classmethod
    def for_corpus(cls, corpus: str) -> "_CorpusIndex":
        key = id(corpus), len(corpus or "")
        if key not in cls._cache:
            cls._cache[key] = cls(corpus)
        return cls._cache[key]


def _value_present(value: str, index: "_CorpusIndex") -> bool:
    if not value:
        return False
    if value.lower() in index.lower_text:
        return True
    try:
        as_float = float(value)
    except ValueError:
        return False
    variants = set()
    if as_float.is_integer():
        n = int(as_float)
        variants.update({str(n), f"{n:,}"})
    variants.add(f"{as_float:g}")
    return any(v.lower() in index.lower_text for v in variants if v)


_STOP = {
    "the","and","for","that","with","from","this","which","were","was","were","are",
    "have","has","had","not","but","they","them","their","its","his","her","into",
    "over","under","during","while","after","before","between","about","also","more",
    "than","then","when","where","which","these","those","such","been","being","does",
    "did","can","could","would","should","may","might","will","shall","there","their",
}

_ANCHOR_WINDOW = 40
_MIN_ANCHORS = 1


def _anchor_tokens(tokens: list[str], value: str) -> set[str]:
    """Distinctive tokens from the claim's sentence, minus the value itself."""
    val = _norm_tokens(value)
    val_set = set(val)
    out = set()
    for tok in tokens:
        if len(tok) > 3 and tok not in _STOP and tok not in val_set:
            out.add(tok)
    return out


def _value_variants(value: str) -> list[str]:
    out = [value]
    try:
        as_float = float(value)
    except (ValueError, TypeError):
        return [v for v in out if v]
    if as_float.is_integer():
        n = int(as_float)
        out.extend({str(n), f"{n:,}"})
    out.append(f"{as_float:g}")
    return [v for v in dict.fromkeys(out) if v]


def _proximity_support(value: str, tokens: list[str], index: "_CorpusIndex") -> float:
    """Best fraction of the claim's anchor terms found near an occurrence of the
    value in the corpus.

    Requiring only that the digits appear is worthless: every 4-digit year
    collides with a date somewhere in a long article. Requiring the claim's own
    distinctive vocabulary to appear *near* that number is what separates a
    corroborated figure from a coincidence.
    """
    anchors = _anchor_tokens(tokens, value)
    if not anchors:
        return 0.0
    corpus = index.tokens
    best = 0.0
    for variant in _value_variants(value):
        # Match on the corpus tokenisation: "50,000" becomes ["50","000"], so a
        # single-token lookup would silently never fire for formatted figures.
        needle = _norm_tokens(variant)
        if not needle:
            continue
        span = len(needle)
        for i in range(len(corpus) - span + 1):
            if corpus[i : i + span] != needle:
                continue
            window = set(corpus[max(0, i - _ANCHOR_WINDOW) : i + _ANCHOR_WINDOW + span])
            frac = len(anchors & window) / len(anchors)
            if frac > best:
                best = frac
                if best >= 0.999:
                    return 1.0
    return round(best, 3)


# A claim counts as corroborated only when its sentence is substantially present
# in the corpus AND the value appears there. Bare number matching is worthless:
# every 4-digit year collides with some date in a long corpus.
_CLAIM_OVERLAP_MIN = 0.60


_PROXIMITY_MIN = 0.34


def corroborate(claim: Claim, corpus: str = "", norm_corpus: str = "") -> bool:
    """True when the claim's value appears in the corpus next to its own context."""
    index = _CorpusIndex.for_corpus(corpus) if corpus else _CorpusIndex(norm_corpus or "")
    value = (claim.value or "").strip()
    tokens = _norm_tokens(claim.detail or claim.text)

    if not _value_present(value, index):
        claim.signal = "absent"
        claim.detail = (claim.detail or "") + " [value not in corpus]"
        return False

    if claim.kind == "quote":
        # The quoted phrase itself appearing in the corpus IS the
        # corroboration; a proximity test on surrounding vocabulary would
        # reject verbatim matches in paraphrased context.
        claim.signal = "corroborated"
        claim.detail = f"{claim.detail} [quoted phrase in corpus]"
        return True

    if claim.kind in ("person", "institution", "press", "grant"):
        # A named entity is corroborated by being named; the surrounding claim
        # is still checked by proximity so "Dr. X" cannot borrow another
        # person's context.
        support = _proximity_support(value, tokens, index)
        if support >= _PROXIMITY_MIN:
            claim.signal = "corroborated"
            claim.detail = f"{claim.detail} [proximity={support:.2f}]"
            return True
        claim.signal = "absent"
        claim.detail = f"{claim.detail} [entity proximity={support:.2f}]"
        return False

    support = _proximity_support(value, tokens, index)
    if support >= _PROXIMITY_MIN:
        claim.signal = "corroborated"
        claim.detail = f"{claim.detail} [proximity={support:.2f}]"
        return True
    claim.signal = "absent"
    claim.detail = f"{claim.detail} [proximity={support:.2f}]"
    return False


def verify(claims: list[Claim], corpus: str, profile: Profile | None = None) -> dict:
    """Corroborate a section's claims and summarise the outcome."""
    profile = profile or Profile()
    norm = ""
    for claim in claims:
        corroborate(claim, corpus, norm)

    corroborated = [c for c in claims if c.signal == "corroborated"]
    absent = [c for c in claims if c.signal != "corroborated"]
    precision = [c for c in absent if c.precision_signal]
    authority = [
        c for c in absent if profile.authority_clusters_are_signal
        and c.kind in ("person", "institution", "grant", "press")
    ]
    # An authority cluster only escalates when several authority kinds co-occur,
    # which is the fabricated-dissertation-apparatus signature.
    authority_kinds = {c.kind for c in authority}
    escalate = (
        len(authority_kinds) >= 2
        or (authority and any(c.kind in ("person", "grant") for c in authority))
    )

    return {
        "total": len(claims),
        "corroborated": len(corroborated),
        "unverified": len(absent),
        "precision_suspects": len(precision),
        "authority_suspects": len(authority),
        "escalate": escalate,
        "escalate_queries": [
            c.text for c in authority[: profile.external_search_cap]
        ],
        "claims": [c.to_dict() for c in claims],
    }


def strip_unverified(text: str, claims: list[Claim]) -> tuple[str, int]:
    """Remove sentences whose claims are all unverified.

    Sentence-level so the surrounding argument survives; the claim's number or
    name never reaches the output.
    """
    if not claims:
        return text, 0
    bad = {c.detail or c.text for c in claims if c.signal != "corroborated"}
    if not bad:
        return text, 0

    kept: list[str] = []
    dropped = 0
    for sentence in re.split(r"(?<=[.!?])\s+", text or ""):
        offending = [c for c in claims if c.signal != "corroborated"
                     and (c.text in sentence or (c.detail and c.detail[:40] in sentence))]
        if offending and not any(c.signal == "corroborated" for c in claims
                                 if c.text in sentence):
            dropped += 1
            continue
        _ = bad
        kept.append(sentence)
    return " ".join(kept).strip(), dropped


GROUNDING_RULES = """
GROUNDING:
- State a figure, date, measurement, or named source ONLY if it appears in the
  research context below. Do not round, estimate, or infer numbers.
- If the context does not supply the specific value, describe the finding
  qualitatively ("substantial", "in several stages", "over many decades")
  without inventing a number, name, institution, or grant.
- Never invent a named person, institution, publication, grant, or budget.
"""
