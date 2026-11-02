"""Drift check: has the corpus drifted onto a different period or subject than
the request asked for?

A run on 2026-10-10 asked for "the demolition of the stadium in Rome" and
shipped 10 of 19 sections as INSUFFICIENT EVIDENCE placeholders, while the
research gate reported quality=0.699 relevant_pages=50 and passed. The cause was
upstream - entity resolution fell back to the concept, the planner invented a
year, and the queries became "Rome stadium demolition 2024". What came back was
700 year mentions of modern Italian football stadium news. The subject was
demolished in 1968; "1968" appears zero times in the corpus.

``assess()`` cannot see this. Embedding similarity between "the demolition of
the stadium in Rome" and a page about the AS Roma stadium project is genuinely
high - same city, same sport, same noun - so the gate did exactly what it was
built to do. What it cannot see is that the corpus is about 2024-2026 when the
request named no year at all.

This module is that missing check. It is deterministic, offline, and reads only
the corpus it is handed - no database, no cache, no LLM call.

It is a WARNING LAYER, never a block. ``detect_drift`` returns a verdict and
the caller decides what to do with it; ``ResearchEngine.run`` only logs. A
healthy run that trips this must not be silently suppressed, and an unhealthy
run that misses it must still be caught by ``assess()``.

Thresholds live in the constants below and every one of them is justified by a
measured number from the two real runs quoted in ``artifacts/drift/``.
"""
from __future__ import annotations

import re
from typing import Any

# --- thresholds -------------------------------------------------------------

#: Half-width, in years, of the window used to measure year concentration.
#: Five years wide because the failure was a *recent-news* cluster: the failing
#: corpus holds 154 mentions of 2025 alone and 309 mentions inside 2022-2026.
#: Widening the window only makes concentration easier to hit, and a
#: construction-and-redevelopment story is not confined to one year.
WINDOW_YEARS = 2

#: Share of ALL year mentions that must fall inside one WINDOW_YEARS window.
#:
#: Measured: the failing corpus concentrates 0.441 of its 700 year mentions in
#: 2022-2026 (309 mentions). The healthy corpus - a genuine 1928/1932/1968
#: history that legitimately spans four decades - concentrates only 0.263 of
#: its 908 mentions in 1928-1932 (239 mentions), and its next-widest decade
#: band is far behind. 0.33 sits above the healthy 0.263 and below the failing
#: 0.441: a spread of years NEVER fires, only a genuinely dominant period.
#: Raising it towards 0.441 would shrink the healthy margin to nothing;
#: lowering it towards 0.263 would fire on healthy historical corpora.
MIN_WINDOW_SHARE = 0.33

#: Floor on raw mentions inside the window, independent of the share. 0.33 of
#: six mentions is two mentions. The failing corpus has 309, so 30 costs
#: nothing there while keeping a short corpus out of the verdict.
MIN_WINDOW_MENTIONS = 30

#: A named entity must be seen at least this many times before it counts as
#: corpus-dominant. Below it the census is dominated by one-off proper nouns
#: and the "alien share" becomes noise.
MIN_ENTITY_MENTIONS = 8

#: How many of the most frequent entities decide the entity verdict.
TOP_ENTITIES = 5

#: Longest phrase the census will treat as one name. Without a cap a run of
#: capitalised words ("Rome Rome Rome ...") is consumed as a single entity and
#: the whole census collapses to one useless key.
MAX_ENTITY_WORDS = 4

#: Share of those top-entities' mentions that must name something the request
#: never named.
#:
#: Measured: the healthy corpus sits at 0.487 - "Foro Italico", "Enrico Del
#: Debbio" and "Carrara" are all off-request, and a well-researched subject
#: always drags in named things the request never mentioned. The failing corpus
#: sits at 0.699. 0.60 keeps a 0.11 margin below the healthy value while still
#: catching a corpus whose headline names are overwhelmingly foreign; 0.5 gave
#: the healthy run a 0.013 margin, which is noise.
MIN_ALIEN_SHARE = 0.60

# --- extraction -------------------------------------------------------------

#: A four-digit year with word boundaries on both sides. Boundaries matter:
#: they reject "999", "20xx" and "0000", and they reject the "1960" inside
#: "1960s" rather than guessing at a clipped decade label.
_YEAR = re.compile(r"\b(1[0-9]{3}|20[0-9]{2})\b")

#: A capitalised word. Latin-1 letters are included so an accented name such as
#: "Del Debbio" is not split into fragments.
_WORD = re.compile(r"[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'\u2019-]*")

#: Lowercase connectors that may sit inside a multi-word name ("Foro Italico",
#: "Stadio dei Marmi", "Parc des Princes").
_CONNECTORS = frozenset(
    {"of", "di", "de", "del", "della", "dei", "la", "le", "and", "für", "du"}
)

#: A token counts as sentence-initial if one of the two characters before it is
#: one of these. Proper nouns are detected by requiring a capital NOT in this
#: position, which removes the single largest source of junk ("The stadium",
#: "Construction began") without needing a lexicon.
_SENTENCE_END = re.compile(r"[.!?\n\r:;)\]\"“”]\s*$")

#: Sentence-initial openers. A capitalised word that is only ever capitalised
#: because a sentence began there is not an entity; these are excluded when the
#: first token of a candidate phrase is one of them.
_OPENERS = frozenset(
    {
        "the", "a", "an", "this", "that", "these", "those", "it", "its", "in",
        "on", "at", "of", "for", "and", "but", "or", "if", "as", "by", "from",
        "with", "they", "their", "there", "we", "our", "you", "your", "he",
        "his", "she", "her", "was", "were", "is", "are", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "not", "no", "yes", "when",
        "while", "after", "before", "during", "since", "until", "about",
        "also", "more", "most", "some", "such", "however", "although",
        "meanwhile", "furthermore", "additionally", "many", "much", "both",
        "each", "other", "another", "over", "under", "between", "within",
        "without", "toward", "towards", "upon", "across", "through",
        "following", "despite", "besides", "however", "all", "any", "can",
        "could", "would", "should", "may", "might", "will", "shall", "must",
        "than", "then", "thus", "so", "because", "one", "two", "three",
        "several", "various", "different", "new", "old", "first", "second",
        "third", "next", "last", "main", "major", "minor", "including",
        "include", "includes", "based", "according", "mean", "used", "using",
        "i", "my", "me", "him", "them", "per", "via", "etc",
    }
)

#: Artifacts of the crawl/report pipeline, not of the subject: these appear
#: capitalised inside every research report and would otherwise rank as the
#: corpus's most frequent "entity" on every single run.
_CHROME = frozenset(
    {
        "url", "urls", "chars", "char", "snippet", "http", "https", "www",
        "com", "org", "net", "html", "htm", "pdf", "index", "page", "pages",
        "source", "sources", "read", "more", "home", "search", "news",
        "wikipedia", "co", "uk", "it", "de", "fr", "es", "md",
    }
)


def _text(value: Any) -> str:
    """Coerce anything at all - including None - into a string."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return str(value)
    except Exception:
        return ""


def _years(text: str) -> list[int]:
    return [int(y) for y in _YEAR.findall(text)]


def _entity_census(corpus: str) -> dict[str, int]:
    """Count mid-sentence capitalised phrases, longest match wins.

    Deterministic: phrases are consumed left to right and a phrase is never
    counted again inside a longer one, so "Stadio Olimpico" is counted once
    and not also as "Stadio".
    """
    tokens = [(m.group(0), m.start(), m.end()) for m in _WORD.finditer(corpus)]
    counts: dict[str, int] = {}
    index = 0
    while index < len(tokens):
        word, start, end = tokens[index]
        if not word[0].isupper() or len(word) < 3:
            index += 1
            continue
        if start == 0 or _SENTENCE_END.search(corpus[max(0, start - 2):start]):
            index += 1
            continue
        if word.lower() in _OPENERS or word.lower() in _CHROME:
            index += 1
            continue

        phrase = [word]
        cursor = index + 1
        while cursor < len(tokens) and len(phrase) < MAX_ENTITY_WORDS:
            nxt, nxt_start, nxt_end = tokens[cursor]
            # A phrase cannot span a gap: "Rome.In 1928" is two tokens, not one.
            if nxt_start != tokens[cursor - 1][2] and nxt_start - tokens[cursor - 1][2] > 1:
                break
            lowered = nxt.lower()
            if nxt[0].isupper() and len(nxt) >= 3 and lowered not in _CONNECTORS:
                # "of The" would make an opener the tail of a name.
                if cursor == index + 1 and lowered in _OPENERS:
                    break
                phrase.append(nxt)
                cursor += 1
            elif lowered in _CONNECTORS and cursor < len(tokens) - 1:
                follower = tokens[cursor + 1][0]
                if follower[0].isupper() and len(follower) >= 3:
                    phrase.append(nxt)
                    cursor += 1
                else:
                    break
            else:
                break
        # "Lazio's" is "Lazio"; unstripped the possessive form files itself
        # as a separate near-duplicate that can outrank the real name.
        phrase[-1] = re.sub(r"['\u2019]s$", "", phrase[-1])
        key = " ".join(phrase).lower()
        if key not in _CHROME:
            counts[key] = counts.get(key, 0) + 1
        index = max(cursor, index + 1)
    return counts


def _named_by_request(entity: str, request: str) -> bool:
    """True when the request names this entity.

    Matched on the whole phrase or on any of its words of four characters or
    more. The census keeps the maximal capitalised run, so "in Rome, Stadio dei
    Marmi" is filed as "rome stadio dei marmi"; a whole-phrase-only test would
    call that phrase foreign when the request plainly names its head noun.
    """
    if entity in request:
        return True
    return any(
        re.search(rf"(?<!\w){re.escape(word)}(?!\w)", request)
        for word in entity.split()
        if len(word) >= 4
    )


def _page_coverage(pages: Any, names: list[str]) -> dict[str, int]:
    """How many of ``pages`` mention each name. Report-only, never gates."""
    if not isinstance(pages, (list, tuple)) or not names:
        return {}
    lowered = [n.lower() for n in names]
    hits = {n: 0 for n in names}
    for page in pages:
        if not isinstance(page, dict):
            continue
        blob = f"{_text(page.get('title'))} {_text(page.get('text'))} {_text(page.get('snippet'))}".lower()
        if not blob.strip():
            continue
        for name in lowered:
            if name in blob:
                hits[name] += 1
    return hits


def _temporal(concept: str, prompt: str, corpus: str) -> dict:
    """Dominant-period check. See MIN_WINDOW_SHARE for the measured numbers."""
    report: dict[str, Any] = {
        "checked": False,
        "fired": False,
        "reason": "",
        "total_year_mentions": 0,
        "distinct_years": 0,
        "request_years": sorted(set(_years(f"{concept} {prompt}"))),
        "window_years": [],
        "window_start": 0,
        "window_end": 0,
        "window_mentions": 0,
        "window_share": 0.0,
        "thresholds": {
            "window_years": WINDOW_YEARS,
            "min_window_share": MIN_WINDOW_SHARE,
            "min_window_mentions": MIN_WINDOW_MENTIONS,
        },
    }

    mentions = _years(corpus)
    total = len(mentions)
    if total == 0:
        report["reason"] = "no year mentions in corpus"
        return report

    tally: dict[int, int] = {}
    for year in mentions:
        tally[year] = tally.get(year, 0) + 1
    report["checked"] = True
    report["total_year_mentions"] = total
    report["distinct_years"] = len(tally)

    # Best five-year window. Sorted by (-share, centre) so two years with an
    # identical mention count can never flip the verdict between runs.
    best: tuple[tuple[int, int], int, int, int] | None = None
    for centre in sorted(tally):
        members = [y for y in tally if abs(y - centre) <= WINDOW_YEARS]
        count = sum(tally[y] for y in members)
        key = (-count, centre)
        if best is None or key < best[0]:
            best = (key, centre, count, members)
    assert best is not None  # total > 0 guarantees at least one year
    _, centre, count, members = best
    share = count / total

    report["window_start"] = min(members)
    report["window_end"] = max(members)
    report["window_years"] = sorted(members)
    report["window_mentions"] = count
    report["window_share"] = round(share, 3)

    if count < MIN_WINDOW_MENTIONS:
        report["reason"] = f"only {count} year mentions in the dominant window"
        return report
    if share < MIN_WINDOW_SHARE:
        report["reason"] = (
            f"no dominant period: best window {report['window_start']}-"
            f"{report['window_end']} holds only {share:.1%} of year mentions"
        )
        return report

    overlap = sorted(set(members) & set(report["request_years"]))
    if overlap:
        report["reason"] = (
            f"dominant window {report['window_start']}-{report['window_end']} "
            f"includes year(s) {overlap} named by the request"
        )
        return report

    report["fired"] = True
    report["reason"] = (
        f"{share:.1%} of {total} year mentions fall in {report['window_start']}-"
        f"{report['window_end']} ({count} mentions), and the request named no "
        f"year in that period"
    )
    return report


def _entity(concept: str, prompt: str, corpus: str, pages: Any) -> dict:
    """Unrelated-subject check. Deliberately quiet: false positives here would
    train the reader to ignore the drift warning.

    Measured on both real runs: the failing corpus is 92.8% off-request entity
    mass and the healthy corpus 82.0%, so aggregate "alien" mass does NOT
    separate them. What separates nothing but rank does is whether the corpus's
    own most frequent names outrank the request's - hence both conditions.
    """
    report: dict[str, Any] = {
        "checked": False,
        "fired": False,
        "reason": "",
        "top_present": [],
        "top_absent": [],
        "alien_share": 0.0,
        "head_advantage": None,
        "thresholds": {
            "min_entity_mentions": MIN_ENTITY_MENTIONS,
            "top_entities": TOP_ENTITIES,
            "min_alien_share": MIN_ALIEN_SHARE,
        },
    }

    counts = _entity_census(corpus)
    eligible = sorted(
        ((n, c) for n, c in counts.items() if c >= MIN_ENTITY_MENTIONS),
        key=lambda item: (-item[1], item[0]),
    )
    if not eligible:
        report["reason"] = "no named entity repeated often enough to judge"
        return report
    report["checked"] = True

    request = f"{concept} {prompt}".lower()
    ranked = eligible[:TOP_ENTITIES]
    # The alien SHARE is a question about the corpus headline, so it is taken
    # over the top entities. The head of each side is a question about the
    # request, so it is taken over the whole census: a request entity that
    # ranks sixth is still the request's entity.
    absent = [(n, c) for n, c in eligible if not _named_by_request(n, request)]
    present = [(n, c) for n, c in eligible if _named_by_request(n, request)]
    report["top_absent"] = [{"entity": n, "mentions": c}
                            for n, c in absent if n in dict(ranked)]
    report["top_present"] = [{"entity": n, "mentions": c} for n, c in present[:TOP_ENTITIES]]
    if report["top_absent"]:
        report["top_absent_pages"] = _page_coverage(
            pages, [entry["entity"] for entry in report["top_absent"]]
        )

    considered = sum(c for _, c in ranked)
    if not considered:
        report["reason"] = "no entity mass to judge"
        return report
    head_absent = max((c for _, c in absent), default=0)
    alien_mass = sum(c for name, c in ranked if not _named_by_request(name, request))
    report["alien_share"] = round(alien_mass / considered, 3)

    if not present:
        # The request named no entity at all. That is exactly the failing run's
        # situation - it is a weak-anchor problem, not proven entity drift, and
        # claiming drift here would fire on every vague request ever made.
        report["reason"] = "request names no entity, so no alien subject can be shown"
        return report

    head_present = max(c for _, c in present)
    report["head_advantage"] = round(head_present / head_absent, 3) if head_absent else None

    if head_absent <= 0:
        report["reason"] = "every frequent entity is named by the request"
        return report
    if report["alien_share"] < MIN_ALIEN_SHARE:
        report["reason"] = (
            f"off-request entity share {report['alien_share']:.1%} is below "
            f"{MIN_ALIEN_SHARE:.0%}"
        )
        return report
    if head_present >= head_absent:
        report["reason"] = (
            f"the request's own entity is not outranked "
            f"({head_present} vs {head_absent} mentions)"
        )
        return report

    report["fired"] = True
    report["reason"] = (
        f"{report['alien_share']:.1%} of headline entity mass names something "
        f"the request never mentioned, and {absent[0][0]!r} ({head_absent}) "
        f"outranks the request's own entity ({head_present})"
    )
    return report


def _blank() -> dict:
    return {
        "drift_detected": False,
        "signal": None,
        "summary": "no signal",
        "corpus_chars": 0,
        "temporal": {
            "checked": False,
            "fired": False,
            "reason": "not evaluated",
            "total_year_mentions": 0,
            "request_years": [],
            "window_years": [],
            "window_mentions": 0,
            "window_share": 0.0,
        },
        "entity": {
            "checked": False,
            "fired": False,
            "reason": "not evaluated",
            "top_present": [],
            "top_absent": [],
            "alien_share": 0.0,
            "head_advantage": None,
        },
    }


def detect_drift(
    concept: str,
    prompt: str,
    corpus: str,
    pages: list[dict] | None = None,
) -> dict:
    """Report whether ``corpus`` has drifted off the request's period or subject.

    ``concept`` and ``prompt`` together are "what the user asked for"; any year
    or entity named in either is treated as user-specified. ``corpus`` is the
    research text handed to the writer. ``pages`` is optional and only adds
    per-entity page counts to the report for a human to judge.

    Returns a dict with ``drift_detected``, ``signal`` ("temporal", "entity" or
    None) and the full reasoning under ``temporal`` and ``entity`` so a caller
    can log exactly which years and names caused the verdict rather than
    logging a bare boolean.

    Never raises. Malformed input - None, empty strings, a corpus with no
    digits, "20xx", "999", "0000", pure punctuation, mojibake - returns a
    no-signal verdict. This runs inside a research gate whose failure would
    abort an otherwise healthy run, so an exception here is strictly worse than
    silence.

    Reads only what it is passed: no database, no cache, no network, no LLM.
    """
    try:
        concept_text = _text(concept)
        prompt_text = _text(prompt)
        corpus_text = _text(corpus)

        result = _blank()
        result["corpus_chars"] = len(corpus_text)
        if not corpus_text.strip():
            result["summary"] = "empty corpus"
            return result

        temporal = _temporal(concept_text, prompt_text, corpus_text)
        entity = _entity(concept_text, prompt_text, corpus_text, pages)
        result["temporal"] = temporal
        result["entity"] = entity

        if temporal["fired"]:
            result["drift_detected"] = True
            result["signal"] = "temporal"
            result["summary"] = temporal["reason"]
        elif entity["fired"]:
            result["drift_detected"] = True
            result["signal"] = "entity"
            result["summary"] = entity["reason"]
        else:
            result["summary"] = (
                temporal["reason"] or entity["reason"] or "no signal"
            )
        return result
    except Exception as exc:  # pragma: no cover - the guard is the point
        blank = _blank()
        blank["summary"] = f"drift check failed: {type(exc).__name__}"
        return blank