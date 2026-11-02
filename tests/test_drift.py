"""Offline suite for the drift check.

Covers the measured shape of the real failing corpus, a genuine multi-decade
historical corpus that must stay quiet, entity drift, every malformed-input
class, and determinism. No network, no LLM, no database: every assertion is a
pure function of its inputs.

Run: PYTHONPATH=$PWD .venv/bin/python tests/test_drift.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utilis.drift import detect_drift

RESULTS: list[tuple[bool, str, str]] = []


def chk(label: str, ok: bool, extra: str = "") -> None:
    RESULTS.append((bool(ok), label, extra))


_CONCEPT = "The demolition of the stadium in Rome"
_PROMPT = ("Hey Can you Write a new thieasis for me about The desimation "
           "of the stadium of Rome")
_GOOD_CONCEPT = "Demolition of Stadio dei Marmi in Rome in 1968"
_GOOD_PROMPT = ("write a thesis about the demolition of the Stadio dei Marmi "
                "in Rome in 1968")

# Exact year histograms of the two real corpora on disk, so the thresholds are
# tested against the numbers they were derived from and this suite never
# depends on output/ still existing.
_FAILING_YEARS = [
    (1030, 1), (1098, 2), (1870, 1), (1877, 1), (1880, 1), (1884, 1), (1885, 1),
    (1888, 1), (1892, 1), (1896, 1), (1905, 1), (1908, 3), (1909, 1), (1910, 2),
    (1911, 4), (1912, 1), (1913, 1), (1914, 4), (1916, 1), (1922, 2), (1923, 2),
    (1925, 1), (1926, 7), (1928, 7), (1931, 3), (1932, 7), (1934, 4), (1936, 4),
    (1937, 3), (1938, 1), (1939, 2), (1940, 4), (1942, 2), (1943, 4), (1945, 1),
    (1946, 1), (1947, 1), (1950, 2), (1952, 1), (1953, 9), (1954, 2), (1957, 3),
    (1958, 1), (1959, 2), (1960, 19), (1961, 2), (1962, 2), (1963, 1), (1965, 1),
    (1967, 1), (1969, 1), (1979, 1), (1980, 1), (1984, 3), (1986, 2), (1988, 2),
    (1989, 4), (1990, 10), (1992, 1), (1995, 1), (1997, 2), (1998, 3), (2000, 4),
    (2002, 4), (2004, 3), (2005, 1), (2006, 1), (2007, 2), (2008, 7), (2009, 9),
    (2010, 2), (2011, 7), (2012, 6), (2013, 2), (2014, 6), (2015, 3), (2016, 11),
    (2017, 8), (2018, 44), (2019, 12), (2020, 13), (2021, 22), (2022, 13),
    (2023, 11), (2024, 60), (2025, 154), (2026, 71), (2027, 9), (2028, 5),
    (2029, 5), (2030, 11), (2031, 6), (2032, 16), (2033, 1), (2034, 1),
    (2035, 1), (2036, 2), (2040, 1), (2049, 1), (2057, 1), (2081, 1), (2082, 1),
]
_GOOD_YEARS = [
    (1000, 14), (1080, 1), (1203, 1), (1283, 1), (1417, 1), (1891, 10), (1902, 2),
    (1904, 1), (1920, 2), (1927, 15), (1928, 89), (1930, 8), (1931, 2), (1932, 140),
    (1933, 30), (1934, 13), (1935, 8), (1936, 21), (1937, 1), (1938, 16), (1940, 13),
    (1941, 8), (1943, 16), (1944, 3), (1945, 3), (1949, 3), (1950, 3), (1951, 3),
    (1954, 1), (1955, 1), (1956, 10), (1959, 9), (1960, 62), (1968, 35), (1969, 3),
    (1970, 1), (1973, 9), (1974, 7), (1975, 3), (1979, 1), (1980, 9), (1981, 1),
    (1983, 7), (1984, 2), (1986, 1), (1987, 16), (1989, 1), (1990, 16), (1994, 7),
    (1995, 8), (1998, 11), (2001, 2), (2006, 1), (2007, 6), (2008, 3), (2009, 28),
    (2010, 5), (2011, 9), (2012, 24), (2013, 7), (2014, 1), (2015, 11), (2016, 13),
    (2017, 8), (2018, 17), (2019, 4), (2020, 7), (2021, 19), (2022, 10), (2023, 10),
    (2024, 20), (2025, 2), (2026, 52),
]


def _from_histogram(histogram) -> str:
    return " ".join(f"{year} " * count for year, count in histogram)


_FAILING_CORPUS = _from_histogram(_FAILING_YEARS)
_GOOD_CORPUS = (
    "Stadio dei Marmi. " * 30 + "Foro Italico. " * 20 + "Enrico Del Debbio. " * 15
) + _from_histogram(_GOOD_YEARS)

# --- A: the real failing corpus MUST fire -------------------------------------
_fail = detect_drift(_CONCEPT, _PROMPT, _FAILING_CORPUS)
chk("real failing corpus fires", _fail["drift_detected"] is True, _fail["summary"])
chk("verdict is temporal, not entity", _fail["signal"] == "temporal", str(_fail["signal"]))
chk("total year mentions measured at 700",
    _fail["temporal"]["total_year_mentions"] == 700,
    str(_fail["temporal"]["total_year_mentions"]))
chk("distinct years measured at 102",
    _fail["temporal"]["distinct_years"] == 102,
    str(_fail["temporal"]["distinct_years"]))
chk("dominant window is 2022-2026",
    (_fail["temporal"]["window_start"], _fail["temporal"]["window_end"]) == (2022, 2026),
    f"{_fail['temporal']['window_start']}-{_fail['temporal']['window_end']}")
chk("dominant window holds 309 mentions",
    _fail["temporal"]["window_mentions"] == 309,
    str(_fail["temporal"]["window_mentions"]))
chk("dominant window share is 0.441, the measured signal",
    _fail["temporal"]["window_share"] == 0.441, str(_fail["temporal"]["window_share"]))
chk("reason states the request named no year in that period",
    "the request named no year in that period" in _fail["temporal"]["reason"],
    _fail["temporal"]["reason"])
chk("healthy margin is preserved (0.263 < threshold < 0.441)",
    0.263 < 0.33 < 0.441)

# --- B: the healthy corpus MUST stay quiet -----------------------------------
_good = detect_drift(_GOOD_CONCEPT, _GOOD_PROMPT, _GOOD_CORPUS)
chk("healthy corpus stays quiet", _good["drift_detected"] is False, _good["summary"])
chk("healthy window measured at 0.263",
    _good["temporal"]["window_share"] == 0.263, str(_good["temporal"]["window_share"]))
chk("healthy window holds 239 mentions",
    _good["temporal"]["window_mentions"] == 239,
    str(_good["temporal"]["window_mentions"]))
chk("healthy corpus total measured at 908",
    _good["temporal"]["total_year_mentions"] == 908,
    str(_good["temporal"]["total_year_mentions"]))
chk("healthy entity drift also stays quiet",
    not _good["entity"]["fired"], _good["entity"]["reason"])
chk("healthy verdict is no signal at all", _good["signal"] is None, str(_good["signal"]))

_spread = " ".join(f"{year} " * 40 for year in
                   [1901, 1912, 1923, 1934, 1945, 1956, 1967, 1978, 1989, 2000])
chk("wide spread of years does not fire",
    detect_drift("A history", "a history", _spread)["drift_detected"] is False)

# --- C: naming the dominant period disarms the check --------------------------
_prompt_year = detect_drift(_CONCEPT, f"{_PROMPT}, focusing on 2025 and 2024",
                            _FAILING_CORPUS)
chk("prompt naming a dominant year disarms it",
    _prompt_year["drift_detected"] is False, _prompt_year["temporal"]["reason"])
_concept_year = detect_drift("The demolition of the stadium in Rome, rebuilt in 2025",
                             _PROMPT, _FAILING_CORPUS)
chk("concept naming a dominant year disarms it",
    _concept_year["drift_detected"] is False, _concept_year["temporal"]["reason"])
chk("disarm reason names the overlapping year",
    "2025" in _concept_year["temporal"]["reason"], _concept_year["temporal"]["reason"])
chk("request years are reported",
    _concept_year["temporal"]["request_years"] == [2025],
    str(_concept_year["temporal"]["request_years"]))
chk("a year outside the window does not disarm",
    detect_drift(_CONCEPT, "a thesis about a demolition in 1901", _FAILING_CORPUS)
    ["drift_detected"] is True)

# --- D: entity drift ---------------------------------------------------------
_ALIEN = (
    "The San Siro stadium in Milan hosted Inter against Napoli in Serie A fixtures. " * 24
    + "A ceremony was held at the Stadio Olimpico in Rome. " * 10
)
_ent = detect_drift(_CONCEPT, _PROMPT, _ALIEN)
chk("unrelated proper noun fires entity drift",
    _ent["drift_detected"] is True and _ent["signal"] == "entity",
    f"{_ent['signal']} / {_ent['summary']}")
chk("entity drift reports full alien share",
    _ent["entity"]["alien_share"] == 1.0, str(_ent["entity"]["alien_share"]))
chk("entity drift reports the request entity outranked",
    _ent["entity"]["head_advantage"] == 0.417, str(_ent["entity"]["head_advantage"]))
chk("entity drift names alien heads",
    {e["entity"] for e in _ent["entity"]["top_absent"]} >= {"san siro", "milan", "napoli"},
    str(_ent["entity"]["top_absent"][:3]))

_OWN = (
    "Inside the Foro Italico in Rome, Stadio dei Marmi was built. " * 24
    + "Inter played a friendly fixture in Rome. " * 2
)
_own = detect_drift(_GOOD_CONCEPT, _GOOD_PROMPT, _OWN)
chk("concept's own entity dominating stays quiet",
    _own["drift_detected"] is False, _own["summary"])
chk("own entity is reported as present",
    bool(_own["entity"]["top_present"]),
    str(_own["entity"]["top_present"][:2]))
chk("a multi-word request name is kept whole and counted present",
    {e["entity"] for e in _own["entity"]["top_present"]} >= {"rome", "stadio dei marmi"},
    str(_own["entity"]["top_present"][:4]))

_MEASURED = (
    "The Stadio Flaminio in Rome drew plans from Lazio. " * 57
    + "A project in Rome names Italy and Roma. " * 32
    + "Fascist-era Marmi structures are cited. " * 14
    + " " + _FAILING_CORPUS
)
_measured = detect_drift(_CONCEPT, _PROMPT, _MEASURED)
chk("failing corpus stays a temporal-only verdict",
    _measured["signal"] == "temporal" and not _measured["entity"]["fired"],
    _measured["summary"])
chk("failing corpus head_advantage is above 1.0",
    _measured["entity"]["head_advantage"] is not None
    and _measured["entity"]["head_advantage"] >= 1.0,
    str(_measured["entity"]["head_advantage"]))
chk("request naming no entity cannot fire entity drift",
    not detect_drift("It", "it", _ALIEN)["entity"]["fired"])
chk("pages argument is optional",
    detect_drift(_CONCEPT, _PROMPT, _ALIEN, None)["entity"]["fired"] is True)
chk("pages argument adds page counts",
    detect_drift(_CONCEPT, _PROMPT, _ALIEN,
                 [{"title": "San Siro", "text": "San Siro in Milan"}]
                 )["entity"].get("top_absent_pages", {}).get("san siro") == 1)

# --- E: malformed input may never raise or fire ------------------------------
_MALFORMED = [
    ("none everywhere", None, None, None, None),
    ("empty strings", "", "", "", None),
    ("whitespace only", "  ", "\n\t", " \r\n ", None),
    ("no digits at all", _CONCEPT, _PROMPT, "no years here, only words", None),
    ("malformed years", _CONCEPT, _PROMPT, "20xx and 999 and 0000 and 20 and 200", None),
    ("five digit numbers", _CONCEPT, _PROMPT, "19288 20255 100000 1234567890", None),
    ("pure punctuation", _CONCEPT, _PROMPT, "!@#$%^&*()_+-=[]{};':\",./<>?", None),
    ("unicode soup", "デモolition", "\u27f6 2025 \u27f5",
     "2025 2025 2025 ünïcödé 日本語 2025", None),
    ("year as float", _CONCEPT, _PROMPT, "2025.0 2025,0 (2025) [2025]", None),
    ("negative years", _CONCEPT, _PROMPT, "-1968 +1968 1968BC", None),
    ("corpus is a dict", _CONCEPT, _PROMPT, {"text": "2025"}, None),
    ("corpus is an int", _CONCEPT, _PROMPT, 20255, None),
    ("corpus is a list", _CONCEPT, _PROMPT, ["2025"] * 200, None),
    ("pages not a list", _CONCEPT, _PROMPT, _ALIEN, {"title": "x"}),
    ("pages full of junk", _CONCEPT, _PROMPT, _ALIEN, ["nope", 5, None, {}]),
]
for label, concept, prompt, corpus, pages in _MALFORMED:
    try:
        out = detect_drift(concept, prompt, corpus, pages)
    except Exception as exc:  # noqa: BLE001 - the assertion is that it cannot
        chk(f"malformed input survives: {label}", False, f"{type(exc).__name__}: {exc}")
        continue
    chk(f"malformed input survives: {label}",
        isinstance(out, dict) and isinstance(out.get("drift_detected"), bool)
        and isinstance(out.get("summary"), str), str(out.get("summary"))[:60])

_none = detect_drift(None, None, None, None)
chk("all-None returns a no-signal verdict",
    _none["drift_detected"] is False and _none["corpus_chars"] == 0)
chk("all-None keeps the full shape",
    {"drift_detected", "signal", "temporal", "entity", "summary"} <= set(_none))
chk("empty corpus does not fire",
    not detect_drift(_CONCEPT, _PROMPT, "")["drift_detected"])
chk("corpus with no year mentions does not fire",
    not detect_drift(_CONCEPT, _PROMPT, "Rome Rome stadium demolition")["drift_detected"])
chk("malformed years only does not fire",
    not detect_drift(_CONCEPT, _PROMPT, "20xx 999 0000 20 200 12345")["drift_detected"])
chk("pure punctuation does not fire",
    not detect_drift(_CONCEPT, _PROMPT, "!@#$%^&*()_+")["drift_detected"])

_under = detect_drift(_CONCEPT, _PROMPT, " ".join(["2025"] * 29))
chk("below MIN_WINDOW_MENTIONS cannot fire",
    not _under["drift_detected"] and "29 year mentions" in _under["temporal"]["reason"],
    _under["temporal"]["reason"])
chk("at MIN_WINDOW_MENTIONS can fire",
    detect_drift(_CONCEPT, _PROMPT, " ".join(["2025"] * 30))["drift_detected"] is True)
chk("the mention floor holds even at share 1.0",
    detect_drift(_CONCEPT, _PROMPT,
                 " ".join(["2025"] * 20 + ["1990"] * 200))["temporal"]
    ["window_mentions"] == 200)

# --- F: determinism and no stale state ---------------------------------------
_tie = " ".join(["2024"] * 50 + ["2025"] * 50 + ["1990"] * 30 + ["2000"] * 30
                 + [str(y) for y in [1900, 1910, 1920, 1930, 1940, 1950, 1960,
                                     1970, 1980, 2010, 2020] for _ in range(10)])
_runs = [detect_drift(_CONCEPT, _PROMPT, _tie) for _ in range(25)]
chk("tied years give a stable verdict", len({r["drift_detected"] for r in _runs}) == 1)
chk("tied years give stable window bounds",
    len({(r["temporal"]["window_start"], r["temporal"]["window_end"])
         for r in _runs}) == 1)
chk("tied years resolve to the lower centre year",
    _runs[0]["temporal"]["window_start"] == 2024,
    str(_runs[0]["temporal"]["window_start"]))
chk("repeat runs are byte-identical", all(r == _runs[0] for r in _runs))

_a = detect_drift(_CONCEPT, _PROMPT, _FAILING_CORPUS)
detect_drift("something else", "different prompt", " ".join(["1999"] * 400))
detect_drift(_CONCEPT, _PROMPT, _GOOD_CORPUS)
_b = detect_drift(_CONCEPT, _PROMPT, _FAILING_CORPUS)
chk("no cross-call state leaks", _a == _b)

_a["temporal"]["window_share"] = -1.0
_a["drift_detected"] = False
chk("returned dict is not shared state",
    detect_drift(_CONCEPT, _PROMPT, _FAILING_CORPUS) == _b)


# --- G: the research gate is wired to it, additively -------------------------
import inspect  # noqa: E402

from components.researchEngine import ResearchEngine as _R  # noqa: E402

_run_src = inspect.getsource(_R.run)
chk("ResearchEngine.run imports the drift check", "detect_drift" in _run_src)
chk("drift is evaluated in run()",
    "detect_drift(concept, prompt, corpus_text, pages)" in _run_src)
chk("drift fires before the payload is returned",
    _run_src.index("detect_drift(concept") < _run_src.index("payload = {"))
chk("drift result is carried on the payload", '"drift": drift' in _run_src)
chk("existing gate warning is untouched",
    "research gate: quality={} relevant_pages={} after rescue round" in _run_src)
chk("existing low_research behaviour is untouched",
    "low_research = self._needs_rescue(assessment, self.min_research_quality)"
    in _run_src)
chk("the quality gate still decides pass/fail",
    _run_src.index('if drift.get("drift_detected"):') > _run_src.index("low_research"))
chk("corpus text is reused, not rebuilt",
    _run_src.count("f\"[{p['title']}] {p['snippet']}\\n{p['text']}\"") == 1)


def main() -> int:
    passed = sum(1 for ok, _, _ in RESULTS if ok)
    for ok, label, extra in RESULTS:
        print(("PASS  " if ok else "FAIL  ") + label + (f"   [{extra}]" if extra else ""))
    print(f"\n{'ALL PASS' if passed == len(RESULTS) else 'FAILURES'}: "
          f"{passed}/{len(RESULTS)}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())