"""Hard domain blocklist + ambiguous-entity resolution."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utilis.safety import is_blocked_url, filter_urls
from utilis.grounding import extract_claims, strip_unverified, verify
from components.orchestrator import Task
from components.researchEngine import ResearchEngine as R, _is_proper_name
from utilis.store import SqliteDatabase

ok = 0
failed = 0
def chk(l, c, extra=""):
    global ok, failed
    print(("PASS  " if c else "FAIL  ") + l + (f"   [{extra}]" if extra else ""))
    ok += bool(c)
    if not c:
        failed += 1

for url, want in [
    ("https://es.pornhub.com/pornstars", True),
    ("https://pornhub.com/x", True),
    ("https://www.pornhub.com", True),
    ("https://example.com/pornhub-news", False),
    ("https://en.wikipedia.org/wiki/Circus_Maximus", False),
    ("https://bit.ly/abc123", True),
    ("https://xvideos.com/a", True),
    ("https://bet365.com/sport", True),
    ("file:///etc/passwd", True),
    ("javascript:alert(1)", True),
    ("", True),
    ("https://sub.domain.wikipedia.org/wiki/Rome", False),
]:
    blocked, reason = is_blocked_url(url)
    chk(f"blocked={want:<5} {url[:44]}", blocked == want, reason)

kept, blk = filter_urls(["https://en.wikipedia.org/wiki/Rome", "https://pornhub.com/x"])
chk("filter_urls splits correctly", kept == ["https://en.wikipedia.org/wiki/Rome"] and len(blk) == 1)

e = R(db=SqliteDatabase(os.path.join(tempfile.mkdtemp(), "t.db")))
hits = [{"title": "Stadium of Domitian - Wikipedia", "snippet": "a stadium in Rome"},
        {"title": "Reconstructing the Stadium of Domitian", "snippet": "Campus Martius"}]
chk("attested entity extracted from titles",
    R._attested_entity(hits) == "Stadium of Domitian", R._attested_entity(hits))
chk("no title -> no attested entity", R._attested_entity([{"title": "some page", "snippet": "x"}]) == "")

class _A:
    def model(self, *_a, **_k):
        return '{"entity":"demolition of the Stadium of Rome","ambiguous":true}'
e2 = R(agent=_A(), db=SqliteDatabase(os.path.join(tempfile.mkdtemp(), "t.db")))
e2.search = lambda q: hits
resolved = e2._resolve_entity("thesis on the demolition of the Stadium of Rome")
chk("ambiguous + attested -> real monument",
    resolved == "Stadium of Domitian", resolved)

e3 = R(agent=_A(), db=SqliteDatabase(os.path.join(tempfile.mkdtemp(), "t.db")))
e3.search = lambda q: [{"title": "Some Random Page", "snippet": "unrelated"}]
r3 = e3._resolve_entity("thesis on the demolition of the Stadium of Rome")
chk("ambiguous + nothing attested -> concept unchanged (no composite)",
    r3 == "thesis on the demolition of the Stadium of Rome", r3)
chk("unresolved ambiguous result NOT cached",
    e3.db.get(f"entity:{R.ENTITY_CACHE_VERSION}:thesis on the demolition of the stadium in rome") in (None, ""))

try:
    e._http_get("https://es.pornhub.com/pornstars")
    chk("_http_get refuses blocked url", False, "no exception raised")
except ValueError as exc:
    chk("_http_get refuses blocked url", "blocked url" in str(exc), str(exc)[:70])

chk("needs_rescue on low quality",
    R._needs_rescue({"quality": 0.10, "relevant_pages": 4}, 0.35) is True)
chk("needs_rescue on zero relevant pages despite high quality",
    R._needs_rescue({"quality": 0.90, "relevant_pages": 0}, 0.35) is True)
chk("needs_rescue false when quality and pages are both present",
    R._needs_rescue({"quality": 0.72, "relevant_pages": 3}, 0.35) is False)
chk("needs_rescue true on empty assessment",
    R._needs_rescue({}, 0.35) is True)

class _AnyEmb:
    """Per-text scores so the two gates can be exercised independently.

    floor probe -> 0.5 (span 0.5): hard threshold 0.575, confident 0.80.
    """
    def embed_one(self, t):
        return t

    def similarity(self, a, b):
        b = str(b)
        if "comedy-drama" in b:
            return 0.62
        if "ancient city" in b or "athletic events" in b:
            return 0.95
        return 0.5


e4 = R(db=SqliteDatabase(os.path.join(tempfile.mkdtemp(), "t.db")))
e4.embedder = _AnyEmb()
generic = [{"title": "Demolition (2015 film) - Wikipedia",
            "snippet": "Demolition is a 2015 American comedy-drama film directed by Jean-Marc Vallée."},
           {"title": "Stadio dei Marmi - Wikipedia",
            "snippet": "The Stadio dei Marmi is a stadium in Rome used for athletic events."}]
kept4 = e4._filter_hits("Demolition of Stadio dei Marmi Rome", generic)
chk("_filter_hits drops generic single-word hit",
    [h["title"] for h in kept4] == ["Stadio dei Marmi - Wikipedia"],
    [h["title"] for h in kept4])
chk("_filter_hits keeps corroborated hit",
    any("Stadio dei Marmi" in h["title"] for h in kept4))

fidenae = [{"title": "Fidenae - Wikipedia",
            "snippet": "Fidenae is an ancient city near Rome."}]
kept5 = e4._filter_hits("Failure at Fidenae 434 BC Roman Republic", fidenae)
chk("_filter_hits keeps confident hit with thin token overlap",
    kept5 == fidenae, kept5)


class _ScaleEmb:
    """Deterministic scores: floor 0.5, span 0.5.

    bar = floor + 0.35*span = 0.675 -> raw 0.9 and 0.7 count, 0.6 does not.
    Old factor 0.5 (bar 0.75) would have counted only 0.9 - this guards
    against silently reverting the calibration.
    """
    def embed_one(self, t):
        return t

    def similarity(self, a, b):
        b = str(b)
        if "general reference sentence" in b:
            return 0.5
        if "on topic page" in b:
            return 0.9
        if "marginal page" in b:
            return 0.7
        return 0.6


e5 = R(db=SqliteDatabase(os.path.join(tempfile.mkdtemp(), "t.db")))
e5.embedder = _ScaleEmb()
mixed_pages = [
    {"title": "on topic page", "text": "on topic page content"},
    {"title": "marginal page", "text": "marginal page content"},
    {"title": "other page", "text": "other page content"},
]
a5 = e5.assess("test concept about stadiums", mixed_pages)
chk("assess relevant_pages uses quality bar not 0.5 midpoint",
    a5["relevant_pages"] == 2, a5)
chk("assess quality passes 0.35 on mixed corpus",
    a5["quality"] >= 0.35, a5["quality"])

chk("_anchor appends missing entity",
    e._anchor("Demolition of Stadio dei Marmi Rome", "Stadio della Roma")
    == "Demolition of Stadio dei Marmi Rome Stadio della Roma")
chk("_anchor leaves query that already names the entity",
    e._anchor("Stadio della Roma history construction", "Stadio della Roma")
    == "Stadio della Roma history construction")

# When entity resolution falls back it returns the concept itself. Pasting that
# clause onto every query is what produced "reason for demolition of Rome
# stadium The demolition of the stadium in Rome" and the 2024-2026 corpus that
# came back for a 1968 subject.
chk("_anchor drops a fallback concept instead of appending it",
    e._anchor("reason for demolition of Rome stadium",
              "The demolition of the stadium in Rome")
    == "reason for demolition of Rome stadium")
chk("_anchor still appends a genuine multi-word name",
    e._anchor("Rome stadium demolition", "Stadio dei Marmi")
    == "Rome stadium demolition Stadio dei Marmi")
chk("_is_proper_name accepts names, rejects clauses",
    all(_is_proper_name(n) for n in ("Stadio dei Marmi", "Foro Italico",
                                     "Stadium of Domitian", "Colosseum"))
    and not any(_is_proper_name(c) for c in (
        "The demolition of the stadium in Rome",
        "Thesis on the demolition of a stadium in Rome")))

# The prompt/document gate. An unrelated prompt against this document once
# produced a thesis on project-based learning, because reference mode blends
# the prompt with the document and every downstream gate then scored the
# confidently-wrong concept 0.699.
_doc = {"title": "MOTION DETECTOR ALARM SYSTEM",
        "sections": [{"text": ("PIR motion sensor alarm system with arduino, infrared "
                               "detection, home security circuit, intruder detection "
                               "sensor module and microcontroller triggering a siren.") * 6}]}
_ok = Task._prompt_document_mismatch(_doc, "Write a thesis on Arduino motion sensors", "reference")
chk("prompt/document gate allows an on-topic prompt", _ok == "", _ok[:90])
_blocked = Task._prompt_document_mismatch(_doc, "Write a thesis on the demolition of the Stadio dei Marmi in Rome in 1968", "reference")
chk("prompt/document gate blocks an unrelated prompt", bool(_blocked), _blocked[:90])
chk("blocked message names both subjects",
    "MOTION DETECTOR ALARM SYSTEM" in _blocked and "Refusing" in _blocked)
chk("a formatting request is not a topic mismatch",
    Task._prompt_document_mismatch(
        _doc, "can u format this and use latex", "reference") == "")
chk("a new-subject request that mentions formatting is still checked",
    bool(Task._prompt_document_mismatch(
        _doc, "write a thesis about the Stadio dei Marmi in LaTeX", "reference")))
os.environ["QUILL_ALLOW_UNRELATED_PROMPT"] = "1"
chk("prompt/document gate has an explicit escape hatch",
    Task._prompt_document_mismatch(_doc, "Write a thesis on the Nigerian Civil War", "reference") == "")
os.environ.pop("QUILL_ALLOW_UNRELATED_PROMPT", None)
chk("prompt/document gate never blocks on an empty prompt",
    Task._prompt_document_mismatch(_doc, "", "reference") == "")
chk("prompt/document gate never blocks on a tiny document",
    Task._prompt_document_mismatch({"title": "X", "sections": []}, "anything", "reference") == "")

quote_body = ('A plaque reads "Laboratorium ferrum" above the forge. '
              "The stadium stood near the forum.")
quote_claims = extract_claims(quote_body)
quotes = [c for c in quote_claims if c.kind == "quote"]
chk("extract_claims finds quoted phrase",
    len(quotes) == 1 and quotes[0].value == "Laboratorium ferrum",
    [(c.kind, c.value) for c in quote_claims])

verify(quotes, "the forge above the stadium with a plaque")
chk("quote absent from corpus stays unverified",
    quotes and quotes[0].signal != "corroborated",
    quotes[0].signal if quotes else "no quote claim")

kept_q, dropped_q = strip_unverified(quote_body, quotes)
chk("strip_unverified removes absent-quote sentence",
    "Laboratorium ferrum" not in kept_q and dropped_q == 1,
    (kept_q, dropped_q))

present_claims = extract_claims('The sign reads "Laboratorium ferrum" above the forge.')
present_quotes = [c for c in present_claims if c.kind == "quote"]
verify(present_quotes, "records mention Laboratorium ferrum in the workshop")
chk("quote present in corpus corroborated",
    present_quotes and present_quotes[0].signal == "corroborated",
    present_quotes[0].signal if present_quotes else "no quote claim")

print(f"\n{'ALL PASS' if not failed else 'FAILURES'}: {ok} checks, {failed} failed")
raise SystemExit(0 if not failed else 1)
