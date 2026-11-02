"""Research engine: planner -> crawler -> validate loop.

- planner(concept): LLM produces a nested research plan of search queries
  (level 1 main -> level 2 sub-search -> level 3 second sub-search).
- crawl(plan): lightweight HTTP crawler (Bing RSS with DuckDuckGo HTML
  fallback, BeautifulSoup text extraction, dedupe + depth/count bounds).
  ScrapeGraphAI can be added later as a pluggable backend behind a key check.
- validate(concept, pages): embedding coverage + the Scout agent decides
  done vs needs_user_input vs keep going; the Oracle agent reasons between
  iterations and proposes the next queries.
- Questionary freezes and asks the user when input is required.
"""

import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from typing import Iterable
from xml.etree import ElementTree

from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
from loguru import logger

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

from utilis.store import SqliteDatabase
from utilis.coverage import (
    gap_research_enabled,
    gap_research_pages_budget,
    gap_research_queries_budget,
    page_blocks,
    ranked_missing_terms,
)
from utilis.embeddings import Embedder
from utilis.drift import detect_drift
from utilis.model import Agent
from utilis.pydanticModels import OracleDecision, ResearchPlan, ResearchStrategy, ScoutReport
from utilis.timing import timed

try:
    import json_repair
except ImportError:  # pragma: no cover
    json_repair = None

_NON_INFORMATIVE = {
    "idk", "i dont know", "idont know", "dont know", "no idea", "not sure",
    "n/a", "na", "none", "nothing", "-", "--", "no", "nope", "skip", "?",
    "unknown", "unclear", "not known", "no comment", "tbd",
}


def _is_informative(value: str) -> bool:
    """False for blanks and placeholder refusals like 'idk'."""
    text = re.sub(r"[^a-z0-9/ ]+", "", str(value or "").lower()).strip()
    if not text or len(text) < 2:
        return False
    return text not in _NON_INFORMATIVE


_QUERY_STOP = {
    "the", "of", "and", "for", "with", "from", "into", "that", "this", "their",
    "was", "were", "are", "not", "but", "its", "his", "her", "how", "why",
    "what", "when", "who", "can", "may", "did", "does", "new", "old", "top",
    "di", "dei", "della", "delle", "del", "degli", "un", "una", "che", "per",
}


def _content_tokens(text: str) -> set[str]:
    return {
        t for t in re.findall(r"[a-z0-9]{3,}", (text or "").lower())
        if t not in _QUERY_STOP
    }


def _entity_tokens(entity: str) -> list[str]:
    stop = {"the","of","and","stadium","amphitheatre","amphitheater","arena",
            "park","national","site","official","rome","roma","di","dei","della","delle"}
    toks = [t.lower() for t in re.findall(r"[A-Za-z][A-Za-z\-']{2,}", entity or "")]
    return [t for t in toks if t not in stop]


def _entity_confirmed(entity: str, hits: list[dict]) -> bool:
    """True only when results actually name the entity.

    Mere non-emptiness is worthless: searching "Stadio delle Alpi" returned
    TeamViewer Windows download pages, and a substring test then "confirmed"
    "Stadio del Sole" against an AS Roma page because "stadio" appeared inside
    "Stadio Olimpico". Matching is word-bounded and requires the full name or
    several *distinctive* tokens - never a generic one.
    """
    toks = _entity_tokens(entity)
    if not toks:
        return False
    full = re.sub(r"[^a-z0-9 ]+", "", (entity or "").lower())
    full = re.sub(r"\s+", " ", full).strip()
    for hit in hits:
        blob = f"{hit.get('title','')} {hit.get('snippet','')}".lower()
        blob_n = re.sub(r"[^a-z0-9 ]+", "", blob)
        blob_n = re.sub(r"\s+", " ", blob_n).strip()
        if full and full in blob_n:
            return True
        present = [
            t for t in toks
            if re.search(rf"\b{re.escape(t)}\b", blob)
        ]
        # A single-token name must match as that token; multi-token names need
        # at least half their distinctive tokens present.
        if len(toks) == 1 and present:
            return True
        if len(toks) > 1 and len(present) >= max(2, (len(toks) + 1) // 2):
            return True
    return False


# Cap on the query echoed into the searxng audit log line. 200 chars is long
# enough to show which entity a query anchored on (the thing you actually audit)
# and short enough that ~30 planner queries per run cannot bloat the log file.
# The untruncated query is still recorded by @timed's CALL line.
_SEARXNG_QUERY_LOG_CAP = 200

# Conventional local SearXNG address, used when QUILL_SEARXNG_URL is unset.
# Matches the published port in docs/searxng.md and the compose sidecar.
_SEARXNG_DEFAULT_URL = "http://localhost:8080"


# --- questionnaire guard -----------------------------------------------------
# 2026-10-10 15:23 incident (logs/quill-20261010-152259.log): Scout asked the
# user "When was it demolished?" and "What was the primary reason for its
# demolition?" during a run that had already retrieved 42 pages. The generator
# is openai/gpt-oss-20b and it is told not to do this (utilis/model.py, Scout),
# but a prompt is not a control: asking that same small model to also classify
# its own questions would add cost and a second failure mode to the component
# that is already failing. So the rule is a table of patterns, evaluated here,
# before any question reaches the user.
#
# _USER_ONLY_RULES is checked FIRST and wins. Only the user knows which of
# several candidates they meant, how deep they want it, or who it is for, so
# those survive even though they contain a fact word - "What is the name of the
# stadium?" is a naming request and the most valuable question in the incident
# set. _RESEARCH_FACT_RULES are the shapes a search settles by itself. A
# question matching neither is KEPT: silently losing a good question costs a
# round trip, while keeping a bad one costs the user one "I don't know".
#
# Every rule stores the question it exists to reject (or, for _USER_ONLY_RULES,
# the question it exists to protect) so the table is readable on its own and
# self-checking: tests assert each stored example against the real helper, so a
# pattern and its comment cannot drift apart. A banned-pattern list nobody can
# interpret gets deleted by the next reader.

_QuestionRule = tuple[str, "re.Pattern[str]", str]

_USER_ONLY_RULES: tuple[_QuestionRule, ...] = (
    ("disambiguation",
     re.compile(r"\b(?:referring to|do you mean|which one|or should i)\b", re.I),
     "Which specific stadium in Rome are you referring to?"),
    ("naming",
     re.compile(r"\b(?:the name of|what (?:do you|should i|would you) call)\b", re.I),
     "What is the name of the stadium?"),
    ("audience",
     re.compile(r"\b(?:audience|reader|readers|readership|intended for|writing for)\b", re.I),
     "Who is the intended audience for this thesis?"),
    ("depth",
     re.compile(r"\b(?:detail|granular|granularity|depth)\b", re.I),
     "How much detail do you want on the demolition?"),
    ("length",
     re.compile(r"\b(?:word count|page count|essay length|paper length|thesis length)\b"
                r"|\bhow (?:long|many words|many pages)\b[^?]{0,30}\b(?:should|want|need|prefer)\b",
                re.I),
     "How long should the essay be?"),
    ("scope",
     re.compile(r"\b(?:scope|angle|focus|focused|emphasi\w*|prioriti\w*|"
                r"which period|what period)\b", re.I),
     "Should the essay focus on the demolition or the aftermath?"),
    ("avoid",
     re.compile(r"\b(?:avoid|excluding|exclude|omit|omitting|leave out|keep out|skip|"
                r"do not include|don't include)\b", re.I),
     "Is there anything I should avoid including?"),
    ("stance",
     re.compile(r"\b(?:purpose|goal|argument|thesis statement|tone|perspective|opinion)\b", re.I),
     "What should the thesis argue about the demolition?"),
    # Catch-all for "how/who/where ... should you want me to", which is the shape
    # of every remaining preference question ("How should I structure this?").
    # "care about / matters" are here because the Scout prompt explicitly invites
    # "which period matters", and date/year must not swallow that.
    ("preference",
     re.compile(r"\b(?:how|what|which|who|where)\b[^?]{0,60}"
                r"\b(?:should|would you like|do you want|do you need|do you prefer|do you expect|"
                r"do you care|care about|matters? most|is important|are important)\b",
                re.I),
     "How should I structure the demolition chapter?"),
)

_RESEARCH_FACT_RULES: tuple[_QuestionRule, ...] = (
    ("date/year",
     re.compile(r"\b(?:what|which|in what|in which)\s+year\b"
                r"|\bwhen\b[^?]{0,40}\b(?:was|were|did|had|has|have|built|founded|opened|"
                r"closed|demolished|destroyed|constructed|completed|created|established|"
                r"released|published|occurred|happened|take place|date)\b", re.I),
     "In what year was it demolished?"),
    ("reason/cause",
     re.compile(r"\b(?:reasons?|causes?|rationale|motivation)\b"
                r"|\bwhy\b[^?]{0,40}\b(?:was|were|did|had|has|have|built|founded|"
                r"demolished|occurred|happened|constructed)\b", re.I),
     "What was the primary reason for its demolition?"),
    ("mechanism/process",
     re.compile(r"\b(?:mechanism\w*|methodolog\w*)\b"
                r"|\bhow\b[^?]{0,40}\b(?:work|worked|works|happen|happened|occurred|"
                r"take place|carried out|conducted|undertook|executed)\b", re.I),
     "What mechanism was used to demolish it?"),
    ("quantity/figure",
     re.compile(r"\bhow (?:many|much|long|old|tall|big|large|far|deep|wide|heavy|fast|often)\b"
                r"|\bwhat (?:percentage|proportion|number|amount)\b", re.I),
     "How many seats did it have?"),
    ("builder/author/owner",
     re.compile(r"\bwho\b[^?]{0,40}\b(?:designed|design|architect|built|constructed|"
                r"commissioned|funded|owner|owned|authored|author|wrote|written by|"
                r"developed|engineered|purchased|paid for)\b", re.I),
     "Who designed the stadium?"),
    ("location",
     re.compile(r"\bwhere\s+(?:is|are|was|were)\s+(?:it|they|this|that)\b"
                r"|\bwhere\b[^?]{0,40}\b(?:located|situated|built|stands?)\b"
                # "which <place>" needs a research verb, like every other branch
                # here: bare "Which city ..." is far more often a scope question
                # ("Which city should the essay cover?") than a lookup.
                r"|\bwhich (?:city|country|region|town|street)\b[^?]{0,40}"
                r"\b(?:was|were|did|does|is the|are the|hosted|affected|demolished|"
                r"located|built|stands?)\b", re.I),
     "Where is it located?"),
)


def _is_research_fact_question(question: str) -> str | None:
    """Name of the rule that makes ``question`` a fact only search can answer.

    ``None`` means the question is the user's to answer and must be kept. The
    rule NAME (not a bool) is returned so the caller can log why a question was
    dropped and so tests can pin the specific rule rather than "a filter ran".
    """
    text = (question or "").lower()
    for _name, pattern, _example in _USER_ONLY_RULES:
        if pattern.search(text):
            return None
    for name, pattern, _example in _RESEARCH_FACT_RULES:
        if pattern.search(text):
            return name
    return None


def _flat(value: str) -> str:
    """Single-line form of untrusted text: every whitespace run collapses to one
    space. A pasted passage (or a scraped title) carrying newlines must not be
    able to split one audit record into several - or forge one."""
    return " ".join(str(value or "").split())


def _audit_text(value: str, cap: int) -> str:
    """Flattened and length-capped text for a log line.

    Truncation carries an explicit "...(+N chars)" marker so a reader can tell
    a shortened value from a complete one; silently cutting would make a 4k
    query look like the whole story.
    """
    flat = _flat(value)
    if len(flat) <= cap:
        return flat
    return f"{flat[:cap]}...(+{len(flat) - cap} chars)"


# A resolved entity is a proper name, not a restated sentence. Entity resolution
# returns the concept itself when it falls back, and that clause must never be
# pasted onto a query - see _anchor. Multi-word proper names are common
# ("Stadio dei Marmi", "Foro Italico"), so the bound is on words, not on shape.
_MAX_ANCHOR_WORDS = 5


def _is_proper_name(entity: str) -> bool:
    """True when ``entity`` reads as a name rather than a clause of prose.

    Measures word count only. Trying to detect "sentence-ness" by punctuation or
    capitalisation was rejected: real names carry both ("Stadium of Domitian"),
    and a fallback concept is usually lowercase-led prose with no distinguishing
    mark. Word count is the one signal that separates the two reliably.
    """
    return 0 < len((entity or "").split()) <= _MAX_ANCHOR_WORDS


def _entity_in_text(entity: str, text: str) -> bool:
    """True when ``entity`` occurs in ``text`` as a standalone phrase.

    Casefolded, whitespace-flattened, and word-bounded at both ends: a bare
    substring test would report "Stadio dei Mar" as named by a concept that says
    "Stadio dei Marmi", and the whole point of the provenance line is that it
    can be trusted at a glance.
    """
    needle = _flat(entity).casefold()
    hay = _flat(text).casefold()
    if not needle or not hay:
        return False
    start = hay.find(needle)
    while start != -1:
        end = start + len(needle)
        left = hay[start - 1] if start else " "
        right = hay[end] if end < len(hay) else " "
        if not left.isalnum() and not right.isalnum():
            return True
        start = hay.find(needle, start + 1)
    return False


def _prompt_comparison(entity: str, concept: str, prompt: str) -> dict:
    """Compare a resolved anchor against BOTH texts it could have come from.

    The provenance line can only see ``concept``, the LLM's distillation of the
    user's prompt: absence from a distillation does not prove absence from the
    prompt. Threading the raw prompt in makes the two questions separable - did
    the user type this name, or did the distiller keep it, or did neither?

    Returns ``{"in_prompt": str, "in_concept": str, "verdict": str}``. The
    prompt verdict is a pure word-bounded match against attacker-controlled
    text, so instruction-like words inside the prompt cannot change it; the
    untrusted string is only ever a haystack, never a rule.
    """
    in_prompt = _entity_in_text(entity, prompt)
    in_concept = _entity_in_text(entity, concept)
    if not prompt.strip():
        # Explicitly NOT a pass: an empty prompt means no comparison ran, and a
        # silent blank would read like "checked, nothing found".
        verdict = ("no-prompt (no user prompt supplied - the prompt comparison was "
                   "NOT performed, which is not the same as a match)")
    elif in_prompt:
        verdict = "in-prompt (entity occurs in the user's own prompt words)"
    elif in_concept:
        verdict = ("in-concept-only (entity is NOT in the user's prompt; it "
                   "survived only in the distilled concept)")
    else:
        verdict = ("model-invented (entity occurs in NEITHER the user's prompt "
                   "NOR the distilled concept - the resolver made this name up)")
    return {
        "in_prompt": "not-checked" if not prompt.strip() else str(in_prompt).lower(),
        "in_concept": str(in_concept).lower(),
        "verdict": verdict,
    }


_PLAN_SYSTEM = """You are a research planner. Build a nested search-query plan for researching a concept.
Return ONLY valid JSON in this exact shape:
{
  "strategies": [
    {
      "level": 1,
      "query": "<main search query>",
      "goal": "<what this query should establish>",
      "sub_queries": [
        {
          "level": 2,
          "query": "<first sub-search query>",
          "goal": "<what to go deeper on>",
          "sub_queries": [
            {"level": 3, "query": "<second sub-search query>", "goal": "<deepest detail>"}
          ]
        }
      ]
    }
  ]
}
Rules:
- 2-4 strategies. Each level drills one level deeper toward concrete facts.
- Queries must be specific, searchable strings. No prose, no fences."""


class ResearchEngine:
    # Bump to invalidate every cached entity anchor when confirmation changes.
    ENTITY_CACHE_VERSION = "v2"

    def __init__(
        self,
        agent: Agent | None = None,
        embedder: Embedder | None = None,
        db: SqliteDatabase | None = None,
        use_questionary: bool = True,
        max_iterations: int = 3,
        pages_per_query: int = 3,
        max_pages_total: int = 24,
        relevance_threshold: float = 0.7,
        min_research_quality: float = 0.35,
        min_hit_relevance: float = 0.15,
        max_question_rounds: int = 1,
    ):
        self.agent = agent if agent is not None else Agent()
        self.embedder = embedder if embedder is not None else Embedder.get()
        self.db = db if db is not None else SqliteDatabase()
        self.use_questionary = use_questionary
        self.max_iterations = max_iterations
        self.pages_per_query = pages_per_query
        self.max_pages_total = max_pages_total
        self.relevance_threshold = relevance_threshold
        self.min_research_quality = min_research_quality
        self.min_hit_relevance = min_hit_relevance
        # Prompting is bounded independently of the research loop: the loop
        # re-validates each iteration and regenerates the same questions.
        self.max_question_rounds = max_question_rounds
        self.QUESTION_DUP_THRESHOLD = 0.6
        self._asked_question_tokens: list[set[str]] = []
        self._question_rounds = 0
        # The crawled pages WITH their text, which the returned payload drops.
        # A gap round has to merge into these and re-assess, and a page without
        # its text cannot be re-scored; the corpus string cannot be parsed back
        # into pages without guessing.
        self.last_pages: list[dict] = []

    @staticmethod
    def corpus_from_pages(pages: Iterable[dict]) -> str:
        """Build a corpus from pages, in the format ``run`` builds one in.

        The block format is repeated here rather than shared with ``run`` on
        purpose: tests/test_drift.py asserts that ``run`` assembles the corpus
        inline, exactly once, so that the drift check cannot score a corpus
        different from the one the writer receives. That pin is worth more than
        the duplication, and this method exists so the gap round's merged
        corpus is assembled by the same shape.
        """
        return "\n\n".join(
            f"[{p['title']}] {p['snippet']}\n{p['text']}" for p in pages
        )

    # --- run -----------------------------------------------------------------
    # --- quality gate ---------------------------------------------------------
    _NEUTRAL_REFERENCE = (
        "This is a general reference sentence used to estimate the similarity floor "
        "between two unrelated English passages written about any subject."
    )

    @timed("ResearchEngine.assess")
    def assess(self, concept: str, pages: list[dict]) -> dict:
        """Score how relevant the gathered pages are, relative to the embedder floor.

        Similarity between two English passages is never zero, so an absolute
        threshold would be tied to one model. Instead the score is normalised
        against this embedder's own off-topic baseline, giving 0.0 for pages that
        look no more related than random text and approaching 1.0 for pages that
        are squarely on topic.
        """
        result = {"quality": 0.0, "mean": 0.0, "top": 0.0, "floor": 0.0,
                  "relevant_pages": 0, "scored": 0}
        if not concept.strip():
            return result

        concept_vec = self.embedder.embed_one(concept)
        try:
            floor = self.embedder.similarity(
                concept_vec, self.embedder.embed_one(self._NEUTRAL_REFERENCE)
            )
        except Exception:
            floor = 0.0
        floor = max(0.0, min(floor, 0.95))
        result["floor"] = round(floor, 3)

        scores: list[float] = []
        for page in pages:
            text = f"{page.get('title', '')} {page.get('text', '')}".strip()
            if not text:
                continue
            try:
                scores.append(self.embedder.similarity(concept_vec, self.embedder.embed_one(text)))
            except Exception:
                continue
        if not scores:
            return result

        span = max(1e-6, 1.0 - floor)
        top = sorted(scores, reverse=True)[:5]
        top_mean = sum(top) / len(top)
        mean = sum(scores) / len(scores)
        # A page counts as relevant only if it clears the SAME bar the
        # whole corpus must clear (min_research_quality). The old factor
        # was 0.5 - stricter than the corpus bar itself, so quality passed
        # (0.383 >= 0.35) while relevant_pages stayed 0 and every live run
        # was blocked by a threshold its own quality metric contradicted.
        result.update(
            {
                "quality": round(max(0.0, min(1.0, (top_mean - floor) / span)), 3),
                "mean": round(max(0.0, min(1.0, (mean - floor) / span)), 3),
                "top": round(top[0], 3),
                "relevant_pages": sum(
                    1 for s in scores if s > floor + self.min_research_quality * span
                ),
                "scored": len(scores),
            }
        )
        return result

    @staticmethod
    def _needs_rescue(assessment: dict, min_quality: float) -> bool:
        """Whether gathered research is too thin to write from.

        Both conditions are required: WritingEngine._evidence_ok blocks on
        ``relevant_pages >= 1`` regardless of quality, so a high-quality run
        with zero relevant pages still yields an all-placeholder document.
        """
        if int(assessment.get("relevant_pages") or 0) < 1:
            return True
        return float(assessment.get("quality") or 0.0) < min_quality

    @timed("ResearchEngine.run")
    def run(self, concept: str, unique_id: str = "", prompt: str = "") -> dict:
        plan = self.planner(concept, prompt=prompt)
        pages = self.crawl_plan(plan)

        status, summary, coverage, answers = "continue", "", 0.0, {}
        used_iterations = 0
        for i in range(self.max_iterations):
            used_iterations = i + 1
            verdict = self.validate(concept, pages)
            status, summary, coverage = verdict["status"], verdict["summary"], verdict["coverage"]
            if status == "done":
                break
            if status == "needs_user_input":
                raw = self._clean_questions(verdict.get("questionnaire") or [])
                # A2: never re-ask. The loop re-validates every iteration and
                # Scout regenerates near-identical questions each time, so
                # filter against everything already put to the user.
                novel = [q for q in raw if not self._already_asked(q)]
                for q in raw:
                    self._remember_asked(q)

                suppressed = len(raw) - len(novel)
                rounds_left = self.max_question_rounds - self._question_rounds
                if not novel:
                    logger.info(
                        "questionnaire suppressed={} newly_asked=0 previously_asked={} "
                        "(nothing new; driving research forward instead)",
                        suppressed, len(raw),
                    )
                elif rounds_left <= 0:
                    logger.info(
                        "questionnaire suppressed={} newly_asked=0 previously_asked={} "
                        "(round limit {} reached)",
                        suppressed, len(raw), self.max_question_rounds,
                    )
                else:
                    self._question_rounds += 1
                    logger.info(
                        "questionnaire suppressed={} newly_asked={} previously_asked={} "
                        "(round {}/{})",
                        suppressed, len(novel), len(raw) - len(novel),
                        self._question_rounds, self.max_question_rounds,
                    )
                    # A4: merge, never overwrite - round 1 answers must survive.
                    answers.update(self._ask_user(novel))

                if answers:
                    extra = self._crawl_queries(self._refined_queries(concept, answers))
                    pages.extend(extra)
                    # Answers are consumed; clear so they are not re-applied.
                    answers = {}
                else:
                    # Nobody answered: drive research forward instead of re-asking.
                    decision = self._think(concept, pages)
                    if not decision.next_queries:
                        break
                    pages.extend(self._crawl_queries(decision.next_queries))
            else:  # continue_research
                decision = self._think(concept, pages)
                next_queries = decision.next_queries
                if not next_queries:
                    break
                pages.extend(self._crawl_queries(next_queries))

        assessment = self.assess(concept, pages)
        low_research = self._needs_rescue(assessment, self.min_research_quality)
        if low_research and len(pages) < self.max_pages_total:
            # One reformulated round before giving up: the first pass is often
            # keyword-matched to the wrong subject.
            decision = self._think(
                concept,
                pages,
                extra_instruction=(
                    "The research gathered so far is off-topic or too thin. Propose"
                    " different search phrasings, using the subject's own terminology"
                    " rather than words from the original request."
                ),
            )
            queries = [q for q in (decision.next_queries or []) if q.strip()][:3]
            if queries:
                pages.extend(self._crawl_queries(queries))
                assessment = self.assess(concept, pages)
                low_research = self._needs_rescue(assessment, self.min_research_quality)
            if low_research:
                logger.warning(
                    "research gate: quality={} relevant_pages={} after rescue round "
                    "for {!r}; writer will emit placeholders for unsupported sections",
                    assessment["quality"], assessment["relevant_pages"], concept[:80],
                )

        corpus_text = "\n\n".join(
            f"[{p['title']}] {p['snippet']}\n{p['text']}" for p in pages
        )
        self.last_pages = pages

        # Additive to the gate above, never a replacement: assess() cannot see
        # that a corpus is about the wrong decade. On 2026-10-10 the run for
        # "the demolition of the stadium in Rome" passed at quality=0.699 with
        # 50 relevant pages and still produced 10 of 19 sections as
        # placeholders, because every page was 2024-2026 Italian football
        # stadium news and the subject was demolished in 1968.
        drift = detect_drift(concept, prompt, corpus_text, pages)
        if drift.get("drift_detected"):
            logger.warning(
                "research gate: DRIFT ({}) for {!r}; the corpus may describe a "
                "different subject or period than the request and the writer "
                "will ground sections in it. {}",
                drift.get("signal"),
                concept[:80],
                drift.get("summary"),
            )
            if drift.get("signal") == "temporal":
                logger.warning(
                    "research gate: drift detail prompt={} request_years={} "
                    "corpus_years={} dominant_window={}-{} window_mentions={} "
                    "of {} year_mentions",
                    _audit_text(prompt, 120),
                    drift["temporal"].get("request_years"),
                    drift["temporal"].get("distinct_years"),
                    drift["temporal"].get("window_start"),
                    drift["temporal"].get("window_end"),
                    drift["temporal"].get("window_mentions"),
                    drift["temporal"].get("total_year_mentions"),
                )
            else:
                names = ", ".join(
                    f"{entry['entity']}x{entry['mentions']}"
                    for entry in drift["entity"].get("top_absent", [])[:3]
                )
                logger.warning(
                    "research gate: drift detail alien_entities=[{}] "
                    "alien_share={} head_advantage={}",
                    names,
                    drift["entity"].get("alien_share"),
                    drift["entity"].get("head_advantage"),
                )

        payload = {
            "concept": concept,
            "plan": plan.model_dump(mode="json"),
            "pages": [
                {
                    "level": p["level"],
                    "query": p["query"],
                    "title": p["title"],
                    "url": p["url"],
                    "snippet": p["snippet"],
                    "chars": len(p["text"]),
                }
                for p in pages
            ],
            "summary": summary,
            "coverage": round(coverage, 3),
            "status": status,
            "answers": answers,
            "quality": assessment["quality"],
            "relevant_pages": assessment["relevant_pages"],
            "low_research": low_research,
            "iterations": used_iterations,
            "drift": drift,
            "corpus": corpus_text,
        }
        if unique_id:
            self.db.set(f"research:{unique_id}", payload)
        return payload

    # --- planner -------------------------------------------------------------
    @timed("ResearchEngine._resolve_entity")
    def _resolve_entity(self, concept: str, prompt: str = "") -> str:
        """Resolve a vague concept to a canonical named entity.

        A run asking about "the stadium of Rome" produced the plan query
        "history Stadium of Rome" - no monument named at all - and the corpus
        came back with stadium demolitions, windmill paintings and a sales
        platform called Seismic. Every downstream fabrication followed from that
        one unresolved anchor.

        ``prompt`` is the user's raw text, optional and additive: callers that
        predate it keep working, but the prompt-vs-anchor comparison it enables
        is the only check that can tell an invention apart from a distillation
        that merely dropped the name.
        """
        # Cache is versioned: v1 entries were written under substring matching
        # and hold three phantoms ("Stadio dei Marmi", "Stadio delle Alpi",
        # "Stadio del Sole"). A cache hit short-circuits BEFORE confirmation, so
        # leaving them would silently defeat the word-boundary check below.
        cached = self.db.get(f"entity:{ResearchEngine.ENTITY_CACHE_VERSION}:{concept.strip().lower()}")
        if isinstance(cached, str) and cached.strip():
            # Audited too: a cache hit short-circuits every confirmation below,
            # so without this line a re-run of the same concept emits no
            # provenance at all and the anchor looks unexamined.
            logger.info(
                "entity provenance: origin=cache-hit (not re-verified this run) "
                "entity='{}' concept='{}'",
                cached.strip()[:120], _audit_text(concept, 80),
            )
            return cached.strip()

        # Incident-driven rewrite (2026-10-10, logs/quill-20261008-171831.log).
        # The removed line was: "- Prefer the most famous specific referent."
        # It ordered invention above accuracy, so "the demolition of the stadium
        # of Rome" - which names no stadium at all - resolved to "Stadio dei
        # Marmi": 30 downstream queries and a 260k-char corpus anchored on a
        # different stadium in Carrara. A class description is now an explicit
        # branch whose correct answer is "return the class phrase, do not
        # guess", which the previous prompt never offered.
        system_prompt = """You are an entity resolver. Name the one entity a researcher should search for.

Rules:
- If the text NAMES a specific place, structure, work, person or thing, give its
  standard proper name only. No qualifiers.
- If the text DESCRIBES a class or role, or several distinct entities plausibly
  fit, do NOT invent a proper name: return the class phrase from the text with
  ambiguous=true. That is correct and safe - never guess.

Respond with JSON only:
{"entity": "<NAME OR CLASS PHRASE>", "ambiguous": <true|false>}
"""
        try:
            parsed = self._parse_json_like(self.agent.model(concept, system_prompt=system_prompt))
        except Exception:
            parsed = None
        entity = ""
        if isinstance(parsed, dict):
            entity = str(parsed.get("entity") or "").strip()
        if not entity:
            entity = concept.strip()
        entity = entity[:120]

        # Confirm before anchoring. The LLM alone resolved "demolition of a
        # stadium in Rome" to "Stadio dei Marmi", a marble stadium by the
        # Olympic Stadium - not the Colosseum. One confirming search catches
        # exactly this class of confident misidentification, and a wrong anchor
        # poisons every subsequent query.
        ambiguous = bool(parsed.get("ambiguous")) if isinstance(parsed, dict) else False
        hits = self.search(f"{entity} {concept}") if entity else []
        if not hits:
            logger.info(
                "entity resolution: {} -> FALLBACK (no search results; keeping concept)",
                concept[:80],
            )
            return concept.strip()

        attested = self._attested_entity(hits)
        confirmed = _entity_confirmed(entity, hits)

        # Prompt-vs-anchor comparison. The provenance line can only test
        # `concept`, which is the distiller's output: absence there does not
        # prove absence from what the user typed. This record puts both texts
        # and the anchor on one line, so "the user never said this" is
        # answerable from the log alone instead of reconstructed later. It sits
        # above the fallback branches on purpose - an anchor the run refuses
        # below is exactly the one a reviewer needs to see judged - and an
        # empty prompt reports itself as not-checked rather than as a match.
        # Compared against the punctuation-stripped name, the same string the
        # provenance line and every query will use, so a trailing "." cannot
        # manufacture a false INVENTED verdict.
        _cmp_entity = entity.strip().rstrip(".,:;|").strip()
        _cmp = _prompt_comparison(_cmp_entity, concept, prompt)
        logger.info(
            "entity prompt comparison: prompt='{}' concept='{}' entity='{}' "
            "in_prompt={} in_concept={} verdict={}",
            _audit_text(prompt, 240) or "<none supplied>", _audit_text(concept, 120),
            _audit_text(_cmp_entity, 120),
            _cmp["in_prompt"], _cmp["in_concept"], _cmp["verdict"],
        )

        # Ambiguity fused several distinct monuments into one invented subject.
        # With no name in the titles there is nothing to anchor to, so keep the
        # concept instead of trusting a model paraphrase.
        if ambiguous and not attested:
            logger.info(
                "entity resolution: {} -> FALLBACK (ambiguous, no attested entity "
                "in titles; keeping concept unchanged)",
                concept[:80],
            )
            return concept.strip()

        # `from_titles` is provenance only: the reassignment below is unchanged,
        # the flag just records that the surviving name came from hit titles
        # rather than from the model or from the concept.
        from_titles = False
        if attested and (ambiguous or not confirmed):
            entity = attested
            from_titles = True
        elif not confirmed:
            logger.info(
                "entity resolution: {} -> FALLBACK (no result names it; top was '{}')",
                concept[:80], (hits[0].get("title", "") or "nothing")[:80],
            )
            return concept.strip()
        elif (prompt.strip()
              and not _entity_in_text(entity, prompt)
              and not _entity_in_text(entity, concept)):
            # Reaching FALLBACK for an invention. Confirmation cannot catch this
            # case - the invented name has its own Wikipedia page, so the search
            # "confirms" it and the anchor was accepted. Gated on a non-empty
            # prompt: with no prompt there is no evidence of an invention, and
            # the pre-existing behaviour (which callers and the suites pin)
            # stands. Fails safe: the concept survives as the subject.
            logger.info(
                "entity resolution: {} -> FALLBACK (anchor '{}' occurs in NEITHER the "
                "user prompt NOR the concept; keeping concept unchanged)",
                concept[:80], _audit_text(entity, 80),
            )
            return concept.strip()

        titles = " | ".join(h.get("title", "") for h in hits[:4])
        # Model answers and title-attested names inherit punctuation from
        # headlines ("Failure at Fidenae:") - harmless-looking, but the entity
        # is pasted verbatim into every plan prompt and query.
        entity = entity.strip().rstrip(".,:;|").strip()
        # Provenance audit. The incident this closes: a prompt that named no
        # stadium ("the stadium of Rome") was resolved by the model to
        # "Stadio dei Marmi", nothing in the log said that name was the model's
        # invention, and the whole run - 30 queries, corpus and all - anchored
        # on a different stadium in Tuscany. This line is what makes "the user
        # named this" distinguishable from "the model invented this" after the
        # fact. The existing `entity resolution:` line is kept verbatim right
        # below it because other tooling greps that wording.
        if from_titles:
            origin = "result-titles (attested in 2+ hit titles, not from the model or the concept)"
        elif _entity_in_text(entity, concept):
            origin = "user-supplied (the entity string occurs in the concept/user text)"
        else:
            origin = ("model-generated (INVENTED: the entity string does NOT occur "
                      "in the concept/user text)")
        logger.info(
            "entity provenance: origin={} entity='{}' concept='{}' confirmed_by='{}' "
            "ambiguous={}",
            origin, _audit_text(entity, 120), _audit_text(concept, 80),
            _audit_text(titles, 150), ambiguous,
        )
        if ambiguous:
            # `ambiguous=True` previously rode along inside the combined line,
            # where its consequence is invisible: the anchor is still applied and
            # every planner query inherits it, so a known-ambiguous subject
            # deserves to be named as a risk on its own line.
            logger.info(
                "entity anchor risk: ambiguous=true, downstream planner queries will be "
                "anchored on '{}' (titles admitting other referents: '{}')",
                _audit_text(entity, 120), _audit_text(titles, 150),
            )
        logger.info(
            "entity resolution: {} -> {} confirmed by '{}' ambiguous={}{}",
            concept[:80], entity, titles[:150], ambiguous,
            " (resolved from result titles)" if attested and ambiguous else "",
        )
        self.db.set(f"entity:{ResearchEngine.ENTITY_CACHE_VERSION}:{concept.strip().lower()}", entity)
        return entity

    @staticmethod
    def _attested_entity(hits: list[dict]) -> str:
        """Best entity name actually occurring in result titles.

        Real titles use lowercase connectors ("Stadium of Domitian"), so
        requiring two consecutive capitalised words finds nothing. Score
        contiguous n-grams by how many hits contain them, then keep only the
        ones the word-boundary confirmation accepts.
        """
        def titles() -> list[str]:
            out = []
            for hit in hits:
                title = str(hit.get("title") or "")
                for chunk in title.split("|"):
                    chunk = chunk.split(" - ")[0].strip()
                    if chunk:
                        out.append(chunk)
            return out

        rows = titles()
        if not rows:
            return ""

        grams: set[str] = set()
        for row in rows:
            words = row.split()
            if not words or not words[0][:1].isupper():
                continue
            for size in range(2, min(6, len(words)) + 1):
                for start in range(0, len(words) - size + 1):
                    window = words[start:start + size]
                    if not window[0][:1].isupper():
                        continue
                    if len(" ".join(window)) > 60:
                        continue
                    grams.add(" ".join(window))

        best, best_hits = "", 0
        for gram in sorted(grams, key=lambda g: (-len(g), g)):
            seen = sum(1 for row in rows if gram in row)
            # One title is not evidence of an entity: a lone result produced
            # "Some Random Page" and "New AS Roma Stadium" as candidate subjects.
            if seen < 2 or seen <= best_hits:
                continue
            if _entity_confirmed(gram, hits):
                best, best_hits = gram, seen
        return best

    def _anchor(self, query: str, entity: str) -> str:
        """Ensure a query names the resolved entity.

        Bare topical words drift to the wrong entity entirely: "seismic" pulls a
        sales platform rather than Roman earthquake history.

        But anchoring is only meaningful when the entity is a NAME. When entity
        resolution falls back it returns the concept itself, and pasting that
        clause onto every query is what produced "reason for demolition of Rome
        stadium The demolition of the stadium in Rome" - the same run5 poisoning
        that made DDG/Bing return pure junk. A resolved name ("Stadio dei Marmi")
        narrows a query; a restated sentence only dilutes it, so it is dropped.
        """
        query = (query or "").strip()
        if not entity:
            return query
        entity = entity.strip()
        if not _is_proper_name(entity):
            return query
        if entity.lower() in query.lower():
            return query
        # Avoid duplicating generic words already leading the query.
        lead = query.split()[0].lower() if query.split() else ""
        if lead and lead in entity.lower():
            return query
        return f"{query} {entity}".strip()

    @timed("ResearchEngine.missing_terms")
    def missing_terms(self, section_text: str, corpus: str, limit: int | None = None) -> list[str]:
        """Section terms this corpus cannot support, rarest and longest first.

        ``_content_tokens`` is passed in rather than reimplemented so a section
        is tokenised exactly the way the planner and the hit filter already
        tokenise it. Empty list means "do not spend a query on this section".
        """
        return ranked_missing_terms(
            section_text, page_blocks(corpus), tokenize=_content_tokens, limit=limit
        )

    @timed("ResearchEngine.coverage")
    def coverage(self, corpus: str, claim_terms: list[str]) -> dict:
        """Report which topic terms the corpus actually supports.

        Aggregate quality can look healthy while the corpus omits the subject
        entirely - one run scored 0.544 on a corpus with zero mentions of the
        hypogeum, which is precisely what the document needed to discuss.
        """
        blob = re.sub(r"[^a-z0-9]+", " ", (corpus or "").lower())
        blob = f" {blob} "
        terms = [t for t in dict.fromkeys(claim_terms or []) if len(t) > 3][:24]
        present = [t for t in terms if f" {t.lower()} " in blob]
        missing = [t for t in terms if t not in present]
        return {
            "terms": len(terms),
            "present": len(present),
            "missing": missing,
            "ratio": round(len(present) / len(terms), 3) if terms else 1.0,
        }

    @timed("ResearchEngine.planner")
    def planner(self, concept: str, prompt: str = "") -> ResearchPlan:
        entity = self._resolve_entity(concept, prompt=prompt)
        response = self.agent.model(
            f"{concept}\n\nThe subject is: {entity}",
            system_prompt=_PLAN_SYSTEM,
        )
        parsed = self._parse_json_like(response)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("strategies"), list):
            return ResearchPlan(
                strategies=[ResearchStrategy(query=self._anchor(concept, entity), goal="Main search")]
            )
        try:
            plan = ResearchPlan.model_validate(parsed)
        except (TypeError, ValueError):
            return ResearchPlan(
                strategies=[ResearchStrategy(query=self._anchor(concept, entity), goal="Main search")]
            )

        def anchor_all(strategies):
            for strat in strategies:
                strat.query = self._anchor(strat.query, entity)
                anchor_all(strat.sub_queries or [])

        anchor_all(plan.strategies)
        logger.info(
            "anchored plan for {}: {}",
            entity,
            [s.query for s in plan.strategies][:4],
        )
        return plan

    # --- crawler -------------------------------------------------------------
    @timed("ResearchEngine.crawl_plan")
    def crawl_plan(self, plan: ResearchPlan) -> list[dict]:
        pages, seen = [], set()
        for strategy in plan.strategies:
            if len(pages) >= self.max_pages_total:
                break
            self._crawl_node(strategy, pages, seen)
        return pages

    @timed("ResearchEngine._filter_hits")
    def _filter_hits(self, query: str, hits: list[dict]) -> list[dict]:
        """Drop search hits that are not actually about the query.

        The search backends intermittently answer with ads and unrelated pages
        (a Colosseum query can return used-car lots). Accepting those silently
        produces fake research, so every hit must clear a relevance bar measured
        against this embedder's own off-topic floor.
        """
        if not query or not hits:
            return hits
        try:
            query_vec = self.embedder.embed_one(query)
            floor = self.embedder.similarity(query_vec, self.embedder.embed_one(self._NEUTRAL_REFERENCE))
        except Exception:
            return hits
        floor = max(0.0, min(floor, 0.95))
        span = max(1e-6, 1.0 - floor)

        # Two failure modes, both observed live:
        # 1. Embedder similarity alone passed "Demolition (2015 film)" for
        #    "Demolition of Stadio dei Marmi Rome" - one shared word beat the
        #    floor.
        # 2. Requiring 2 shared tokens unconditionally dropped genuine hits
        #    whose short snippets omit query tokens, starving the corpus to
        #    376 chars from 27 searches.
        # So: corroborate with tokens, but only when the embedder is also
        # unconfident. Confident matches survive on embedding alone.
        q_tokens = _content_tokens(query)
        min_overlap = 2 if len(q_tokens) >= 4 else 0

        kept = []
        for hit in hits:
            text = f"{hit.get('title', '')} {hit.get('snippet', '')}".strip()
            if not text:
                continue
            try:
                score = self.embedder.similarity(query_vec, self.embedder.embed_one(text))
            except Exception:
                continue
            if score < floor + self.min_hit_relevance * span:
                logger.debug(
                    "dropping off-topic hit (score={:.3f} floor={:.3f}): {}",
                    score, floor, text[:80],
                )
                continue
            if min_overlap:
                overlap = len(q_tokens & _content_tokens(text))
                if overlap < min_overlap and score < floor + 0.6 * span:
                    logger.debug(
                        "dropping uncorroborated weak hit (overlap {}/{} score={:.3f}): {}",
                        overlap, min_overlap, score, text[:80],
                    )
                    continue
            kept.append(hit)
        return kept

    @timed("ResearchEngine._crawl_node")
    def _crawl_node(self, node: ResearchStrategy, pages: list[dict], seen: set, level: int | None = None):
        level = level or int(node.level or 1)
        query = (node.query or "").strip()
        if not query:
            return
        hits = self._filter_hits(query, self.search(query))
        if not hits:
            logger.debug(f"no relevant results for query: {query!r}")
        for hit in hits[: self.pages_per_query]:
            if len(pages) >= self.max_pages_total:
                return
            if hit["url"] in seen:
                continue
            seen.add(hit["url"])
            text = self._fetch(hit["url"])
            pages.append(
                {
                    "level": level,
                    "query": query,
                    "title": hit["title"],
                    "url": hit["url"],
                    "snippet": hit["snippet"],
                    "text": text,
                }
            )
        for sub in node.sub_queries:
            if len(pages) >= self.max_pages_total:
                return
            self._crawl_node(sub, pages, seen)

    @timed("ResearchEngine._crawl_queries")
    def _crawl_queries(
        self, queries: Iterable[str], seen: set[str] | None = None
    ) -> list[dict]:
        pages, used = [], (seen if seen is not None else set())
        for query in queries:
            if len(pages) >= self.max_pages_total:
                break
            self._crawl_node(ResearchStrategy(query=query), pages, used)
        return pages

    # --- gap research (writer -> research feedback loop, default OFF) ----------
    # The writer cannot invent a section the corpus has no material for, and
    # re-rolling the same section against the same corpus at a higher
    # temperature cannot help (three such re-rolls cost three LLM calls and
    # produced three placeholders on the 2026-10-10 run). This is the missing
    # half: buy more material, once, under a ceiling.
    #
    # Every constant below is a CEILING, not a target. Cost is in artifacts/
    # gap-research/cost-model.md; the short version is that the research half of
    # the loop costs no LLM calls at all, because the queries are built here
    # rather than asked for, and only the re-written sections cost anything.
    GAP_TERMS_PER_QUERY = 3
    GAP_TERM_MAX_CHARS = 40
    GAP_QUERY_MAX_CHARS = 200

    @staticmethod
    def _ranked_terms(terms: Iterable[str]) -> list[str]:
        """De-duplicate, trim and bound incoming terms, preserving their order.

        Order carries the rarity ranking the caller computed, so it is kept:
        sorting here would throw away the distinction between the most and the
        least distinctive term. Length is capped because terms arrive from
        section titles, and a 10k-character title must not become a query.
        """
        ranked, seen = [], set()
        for term in terms or []:
            clean = " ".join(str(term or "").split())[: ResearchEngine.GAP_TERM_MAX_CHARS]
            key = clean.lower()
            if not clean or key in seen:
                continue
            seen.add(key)
            ranked.append(clean)
        return ranked

    @timed("ResearchEngine.gap_queries")
    def gap_queries(
        self, terms: list[str], entity: str = "", limit: int = 3,
        per_query: int | None = None,
    ) -> list[str]:
        """Turn ranked missing terms into at most ``limit`` search queries.

        Built directly instead of asking the model for them, for three reasons
        in order of weight:

        1. Cost. ``_think`` and ``_refined_queries`` each spend one Oracle call.
           The query needed here is mechanical - join the most distinctive
           missing term with the next two and anchor it to the entity - and
           paying a model to produce it would add an LLM call to a loop that
           already exists because LLM calls were wasted.
        2. Determinism. Two runs of the same document must produce the same
           queries, or their corpora are not comparable.
        3. Boundedness. A model returns as many queries as it likes and no fixed
           length; here the count, the length and the terms in them are all
           fixed by the caller.

        ``_anchor`` is reused, not reimplemented, so these queries get the same
        entity anchoring every planner query gets: bare topical words drift to
        the wrong entity, which is how "the stadium of Rome" once resolved to a
        stadium in Carrara.
        """
        ranked = self._ranked_terms(terms)
        cap = max(0, int(limit))
        if not ranked or not cap:
            return []
        per = max(1, int(per_query or self.GAP_TERMS_PER_QUERY))
        # The tail beyond cap*per is dropped, not queued: there is exactly one
        # round, so a term that cannot reach a query cannot be researched. Empty
        # chunks are dropped BEFORE anchoring - anchoring "" yields the bare
        # entity, which would spend the whole query budget on one real query
        # plus two copies of the entity name.
        chunks = [ranked[start:start + per] for start in range(0, cap * per, per)]
        queries = [self._anchor(" ".join(chunk), entity) for chunk in chunks if chunk]
        return [q[: self.GAP_QUERY_MAX_CHARS].strip() for q in queries if q.strip()]

    @timed("ResearchEngine.targeted_research")
    def targeted_research(
        self,
        terms: list[str],
        entity: str = "",
        limit: int | None = None,
        *,
        page_cap: int | None = None,
        seen_urls: Iterable[str] | None = None,
    ) -> dict:
        """One budgeted research round aimed at the terms the corpus lacks.

        Returns ``{"queries", "pages", "terms", "query_budget", "page_budget",
        "skipped"}``. ``pages`` are in exactly the shape ``_crawl_queries``
        produces, so the caller merges them into its page list and re-assesses
        without translating anything. ``skipped`` is empty when the round ran
        and otherwise says why not - which is the difference between "searched
        and found nothing" and "never searched".

        Three hard ceilings, none of which the caller can raise: the query
        budget (``limit`` may only lower it), the page budget, and the fact that
        this runs at all. ``pages_per_query``/``max_pages_total`` are tightened
        for the duration of the crawl and restored in a ``finally``, so the
        ceiling is enforced before pages are FETCHED - bounding the result
        afterwards would still have paid for the extra downloads.
        """
        result = {
            "queries": [], "pages": [], "terms": [], "skipped": "",
            "query_budget": 0, "page_budget": 0,
        }
        if not gap_research_enabled():
            result["skipped"] = "disabled: QUILL_GAP_RESEARCH is off"
            return result

        query_budget = gap_research_queries_budget()
        page_budget = gap_research_pages_budget()
        if limit is not None:
            query_budget = max(0, min(int(limit), query_budget))
        if page_cap is not None:
            page_budget = max(0, min(int(page_cap), page_budget))
        result["query_budget"] = query_budget
        result["page_budget"] = page_budget

        ranked = self._ranked_terms(terms)
        result["terms"] = ranked[: query_budget * self.GAP_TERMS_PER_QUERY]
        result["queries"] = self.gap_queries(
            ranked, entity, limit=query_budget
        )
        if not result["queries"]:
            result["skipped"] = "no terms reached a query"
            return result

        known = {str(url) for url in (seen_urls or []) if url}
        previous = (self.pages_per_query, self.max_pages_total)
        try:
            self.pages_per_query = min(previous[0], page_budget)
            self.max_pages_total = min(previous[1], page_budget)
            pages = self._crawl_queries(result["queries"], seen=set(known))
        except Exception as exc:
            logger.warning(
                "gap research: crawl failed after {} quer(y/ies) ({})",
                len(result["queries"]), f"{type(exc).__name__}: {exc}",
            )
            pages = []
        finally:
            self.pages_per_query, self.max_pages_total = previous

        result["pages"] = pages[:page_budget]
        logger.info(
            "gap research: queries={} pages={} page_budget={} terms={}",
            len(result["queries"]), len(result["pages"]), page_budget,
            _audit_text(", ".join(result["terms"]), 200),
        )
        return result

    @timed("ResearchEngine.search")
    def search(self, query: str) -> list[dict]:
        # The scrapers stay in the chain even when SearXNG is configured: a
        # SearXNG instance that 403s or returns nothing must degrade to them,
        # not to zero results. Only the first non-empty list is used.
        results = self._searxng(query) or self._ddg(query) or self._bing(query)
        return results

    @timed("ResearchEngine._bing")
    def _bing(self, query: str) -> list[dict]:
        try:
            url = "https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "format": "rss"})
            data = self._http_get(url)
            # RSS is XML: <link> is a void element in HTML, so an HTML parser
            # silently discards every result URL.
            root = ElementTree.fromstring(data.decode("utf-8", "replace"))
            hits = []
            for item in root.iterfind(".//item"):
                title = (item.findtext("title") or "").strip()
                link = (item.findtext("link") or "").strip()
                desc = (item.findtext("description") or "").strip()
                if not title or not link:
                    continue
                if not link.lower().startswith(("http://", "https://")):
                    continue
                hits.append({"title": title, "url": link, "snippet": desc[:300]})
            return hits[:8]
        except Exception:
            return []

    @timed("ResearchEngine._ddg")
    def _ddg(self, query: str) -> list[dict]:
        try:
            url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
            data = self._http_get(url)
            soup = BeautifulSoup(data, "html.parser")
            hits = []
            for result in soup.select("div.result"):
                a = result.select_one("a.result__a")
                snippet = result.select_one("a.result__snippet")
                href = a.get("href") if a else ""
                href = self._resolve_ddg(href)
                if a and href:
                    hits.append(
                        {
                            "title": a.get_text(strip=True),
                            "url": href,
                            "snippet": (snippet.get_text(strip=True) if snippet else "")[:300],
                        }
                    )
            return hits[:8]
        except Exception:
            return []

    @staticmethod
    def _resolve_ddg(href: str) -> str:
        """Resolve DuckDuckGo's //duckduckgo.com/l/?uddg=<url> redirect links."""
        if not href:
            return ""
        if href.startswith("//"):
            href = "https:" + href
        parsed = urllib.parse.urlparse(href)
        if "duckduckgo.com" in (parsed.netloc or "") and parsed.path.startswith("/l/"):
            query = urllib.parse.parse_qs(parsed.query)
            target = query.get("uddg", [""])[0]
            if target:
                return target
        return href

    # Shared defaults; callers' headers merge OVER this, never replace it.
    _HTTP_DEFAULT_HEADERS: dict[str, str] = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
        "Accept": "text/html,application/rss+xml",
    }

    @timed("ResearchEngine._searxng")
    def _searxng(self, query: str) -> list[dict]:
        """Query a self-hosted SearXNG instance for JSON results.

        Read at call time, not import time: the pipeline must run unchanged on a
        machine with no instance configured, and a test (or a later lane adding
        a Docker instance) can point the engine at a different host between
        calls without restarting the process.
        """
        # Unset means "use the conventional local instance", NOT "no backend".
        # Requiring the export meant a default checkout silently fell through to
        # the scrapers - the exact failure this provider was added to end.
        # An EXPLICIT empty value stays a working opt-out for machines with no
        # instance and no wish to reach one.
        _configured = os.environ.get("QUILL_SEARXNG_URL")
        base = (
            _SEARXNG_DEFAULT_URL if _configured is None else _configured
        ).strip().rstrip("/")
        if not base:
            # Audited: an unconfigured instance and an instance that answered
            # nothing both surface as `searxng -> []` and a fallback to _ddg,
            # which is exactly how a wrong-anchor run hides in the log.
            logger.debug(
                "searxng skipped: QUILL_SEARXNG_URL set to empty (explicit opt-out), "
                "no request sent q='{}'",
                _audit_text(query, _SEARXNG_QUERY_LOG_CAP),
            )
            return []
        try:
            cats = os.environ.get("QUILL_SEARXNG_CATEGORIES") or "general"
            params = {"q": query, "format": "json", "categories": cats, "language": "en"}
            url = f"{base}/search?" + urllib.parse.urlencode(params)
            # Audit line. Until now the log recorded only `search query=<text>`,
            # so nothing showed the host, the path, or the categories asked for
            # - the three things that explain a wrong or empty answer. `params`
            # is the single source of truth: the URL echoed below is re-encoded
            # from the same dict with only `q` shortened, so the log cannot drift
            # from the request it describes. The raw `url` is deliberately NOT
            # echoed - it carries the untruncated query back in.
            q_log = _audit_text(query, _SEARXNG_QUERY_LOG_CAP)
            logger.debug(
                "searxng request: base={} url={} params: q='{}' format={} categories={} "
                "language={}",
                base,
                f"{base}/search?" + urllib.parse.urlencode(dict(params, q=q_log)),
                q_log, params["format"], params["categories"], params["language"],
            )
            try:
                data = self._http_get(url, timeout=30, headers={"Accept": "application/json"})
            except urllib.error.HTTPError as exc:
                # SearXNG answers 403 for format=json unless `json` is listed in
                # search.formats in settings.yml. Name that, or the operator
                # spends an hour blaming the network.
                if exc.code == 403:
                    logger.warning(
                        "searxng 403 from {}: add 'json' to search.formats in settings.yml",
                        base,
                    )
                raise
            body = data.decode("utf-8", "replace") if isinstance(data, (bytes, bytearray)) else str(data)
            payload = json.loads(body)
            results = payload.get("results") if isinstance(payload, dict) else None
            if not isinstance(results, list):
                # A dict here means the instance answered something else (an
                # error page, a proxy body). Iterating it would yield keys.
                logger.warning("searxng: 'results' is {}, expected list", type(results).__name__)
                return []
            stalled = payload.get("unresponsive_engines") or []
            if stalled:
                logger.debug("searxng: {} unresponsive engine(s): {}", len(stalled), stalled)
            hits = []
            for item in results:
                if not isinstance(item, dict):
                    continue
                title = str(item.get("title") or "").strip()
                link = str(item.get("url") or "").strip()
                if not title or not link:
                    continue
                if not link.lower().startswith(("http://", "https://")):
                    # javascript:/data: results would reach _fetch, which raises
                    # and swallows them one at a time; drop them here instead.
                    continue
                hits.append({"title": title, "url": link,
                             "snippet": str(item.get("content") or "").strip()[:300]})
            kept = hits[:8]
            # Audit line. `instance_returned` is what separates "the instance
            # had nothing for this query" (0) from "the instance returned plenty
            # and every hit was dropped here" (usable=0). Both look identical in
            # a zero-result run but are different failures with different fixes,
            # so the count the backend actually produced is logged explicitly.
            logger.debug(
                "searxng response: instance_returned={} usable={} kept={} dropped={}",
                len(results), len(hits), len(kept), len(hits) - len(kept),
            )
            return kept
        except Exception as exc:
            logger.warning("searxng failed: {}: {}", type(exc).__name__, exc)
            return []

    @timed("ResearchEngine._http_get")
    def _http_get(
        self,
        url: str,
        *,
        timeout: float = 12,
        headers: dict[str, str] | None = None,
    ) -> bytes:
        """Fetch ``url`` over the one and only outbound HTTP path.

        ``timeout`` and ``headers`` are keyword-only with the historical values
        as defaults, so _ddg / _bing / _fetch are byte-for-byte unaffected.
        Supplied ``headers`` are merged *over* the defaults rather than
        replacing them: a provider that only needs a different ``Accept``
        (SearXNG JSON) must not silently lose the Firefox ``User-Agent`` and
        start getting bot-blocked.
        """
        from utilis.safety import is_blocked_url
        blocked, reason = is_blocked_url(url)
        if blocked:
            logger.info("BLOCKED url={} reason={}", (url or "")[:120], reason)
            raise ValueError(f"blocked url ({reason}): {url!r}")
        if not url or not url.lower().startswith(("http://", "https://")):
            raise ValueError(f"unusable url: {url!r}")
        merged = dict(self._HTTP_DEFAULT_HEADERS)
        if headers:
            merged.update(headers)
        req = urllib.request.Request(url, headers=merged)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()

    @timed("ResearchEngine._fetch")
    def _fetch(self, url: str, max_chars: int = 8000) -> str:
        try:
            data = self._http_get(url)
            soup = BeautifulSoup(data, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "aside", "noscript"]):
                tag.decompose()
            text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
            return text[:max_chars]
        except Exception:
            return ""

    # --- validate + think ----------------------------------------------------
    @timed("ResearchEngine.validate")
    def validate(self, concept: str, pages: list[dict]) -> dict:
        corpus = " ".join(p["text"] for p in pages if p.get("text"))
        coverage = round(self.embedder.similarity(self.embedder.embed_one(concept), self.embedder.embed_one(corpus)), 3) if corpus else 0.0

        brief = "\n".join(f"- [{p['level']}] {p['title']}: {p['snippet'][:140]}" for p in pages[:24])
        scout: ScoutReport = self.agent.Scout(concept, brief)

        status = scout.status
        summary = (scout.summary or "").strip() if scout.status == "done" else ""
        if not summary:
            # Never leave the artifact empty. A 0-byte .research.md previously
            # looked like the corpus was empty when it was actually a
            # reporting bug: summary was only written on status == "done".
            summary = self._fallback_summary(concept, pages, coverage)
        questionnaire = self._clean_questions(scout.questionnaire)

        if status == "needs_user_input" and not questionnaire:
            status = "continue"  # no usable questions -> let Oracle drive
        if status == "done" and coverage < 0.3:
            status = "continue"  # low coverage but scout happy - push deeper
        return {"status": status, "coverage": coverage, "summary": summary, "questionnaire": questionnaire}

    @staticmethod
    def _fallback_summary(concept: str, pages: list[dict], coverage: float) -> str:
        """Deterministic stand-in so the research artifact is never blank."""
        if not pages:
            return (
                f"No research pages were retrieved for '{concept}'. "
                "Search returned no usable results; see the run log for query "
                "and filter decisions."
            )
        lines = [
            f"Research summary for '{concept}' (coverage {coverage:.3f}).",
            "Scout did not return a done-state summary; listing retrieved sources.",
            "",
        ]
        for page in pages[:24]:
            lines.append(
                f"- [{page['level']}] {page['title']}\n  {page['url']}\n  {page['snippet'][:200]}"
            )
        return "\n".join(lines)

    @timed("ResearchEngine._think")
    def _think(self, concept: str, pages: list[dict], extra_instruction: str = "") -> OracleDecision:
        brief = "\n".join(
            f"- [{p['level']}] {p['title']} ({p['url']}): {p['snippet'][:100]}"
            for p in pages[-16:]
        )
        prompt = (
            f"CONCEPT:\n{concept}\n\nRESEARCH GATHERED SO FAR ({len(pages)} pages):\n{brief}\n\n"
            "Decide whether research is complete or what to search next."
        )
        if extra_instruction:
            prompt += f"\n\n{extra_instruction}"
        return self.agent.Oracle(prompt)

    @timed("ResearchEngine._refined_queries")
    def _refined_queries(self, concept: str, answers: dict) -> list[str]:
        joined = "\n".join(f"- {q}: {a}" for q, a in answers.items())
        prompt = f"CONCEPT:\n{concept}\n\nUSER CLARIFICATIONS:\n{joined}\n\nGenerate 3 new focused research queries covering the clarified areas."
        decision: OracleDecision = self.agent.Oracle(prompt)
        if decision.next_queries:
            return decision.next_queries[:3]
        split = [p.strip() for p in joined.splitlines() if p.strip()]
        return split[:3] or [concept.strip()]

    @staticmethod
    def _first_question(text: str) -> str:
        """Keep only the first question when an item packs several into one string."""
        parts = [p.strip() for p in re.split(r"(?<=\?)\s+", text or "") if p.strip()]
        for part in parts:
            if part.endswith("?"):
                return part
        return parts[0] if parts else text

    @staticmethod
    def _clean_questions(questionnaire: list[str], limit: int = 3) -> list[str]:
        """Drop truncated items, near-duplicates and search-answerable questions."""
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in questionnaire or []:
            question = " ".join(str(raw).split()).strip()
            if "?" in question:
                question = ResearchEngine._first_question(question)
            if len(question) < 12 or len(question) > 160:
                continue
            if not question.endswith(("?", ".")):
                continue
            rule = _is_research_fact_question(question)
            if rule:
                logger.info(
                    "questionnaire dropped: rule={} question={!r} (search answers this, "
                    "not the user; an all-dropped set falls through to Oracle research)",
                    rule, question[:120],
                )
                continue
            key = ResearchEngine._question_key(question)
            if key in seen:
                continue
            seen.add(key)
            cleaned.append(question)
            if len(cleaned) >= limit:
                break
        return cleaned

    def _already_asked(self, question: str) -> bool:
        """True when this question, or a reworded twin, has been put to the user.

        Exact-key equality is too brittle: "What is the specific name of the
        stadium in Rome you refer to?" and "What is the name of the stadium in
        Rome?" are the same question but produce different keys. Token-set
        overlap survives rewording while still separating distinct questions.
        """
        tokens = set(self._question_tokens(question))
        if not tokens:
            return True
        for seen in self._asked_question_tokens:
            union = tokens | seen
            if union and len(tokens & seen) / len(union) >= self.QUESTION_DUP_THRESHOLD:
                return True
        return False

    def _remember_asked(self, question: str) -> None:
        tokens = set(self._question_tokens(question))
        if tokens:
            self._asked_question_tokens.append(tokens)

    @staticmethod
    def _question_tokens(question: str) -> list[str]:
        return ResearchEngine._question_key(question).split()

    @staticmethod
    def _question_key(question: str) -> str:
        """Comparison key that ignores wording noise and shared boilerplate."""
        stop = {
            "can", "you", "could", "would", "please", "provide", "share", "more",
            "specific", "details", "about", "the", "a", "an", "of", "on", "for",
            "and", "or", "in", "to", "what", "which", "how", "give", "is", "are",
            "be", "any", "that", "this", "with", "from", "it", "its", "we", "i",
            "your", "our", "us", "me", "considering", "important", "importance",
        }
        words = [w for w in re.findall(r"[a-z0-9]+", question.lower()) if w not in stop]
        return " ".join(words)

    @timed("ResearchEngine._ask_user")
    def _ask_user(self, questionnaire: list[str]) -> dict:
        answers = {}
        questionnaire = self._clean_questions(questionnaire)
        if not questionnaire:
            return answers
        if not self._interactive():
            print("\n[QUESTIONNAIRE] Skipped — no interactive terminal.")
            return answers

        try:
            import questionary
        except ImportError:  # pragma: no cover
            questionary = None

        print("\n[QUESTIONNAIRE] The research needs input from you.")
        print("Answer what you can; leave the rest blank to continue.\n")
        class _QuestionTimeout(Exception):
            pass

        def _on_alarm(_signum, _frame):
            raise _QuestionTimeout()

        limit = int(os.environ.get("QUILL_QUESTION_TIMEOUT", "60") or 60)
        prior_handler = None
        try:
            prior_handler = signal.signal(signal.SIGALRM, _on_alarm)
        except (ValueError, OSError):
            prior_handler = None
        if prior_handler is not None:
            signal.alarm(max(1, limit))

        try:
            for index, question in enumerate(questionnaire, start=1):
                prompt = f"{index}. {question}"
                if questionary is not None and self.use_questionary:
                    reply = questionary.text(prompt).ask()
                else:
                    reply = input(f"{prompt}\n   -> ")
                if reply and str(reply).strip():
                    text = str(reply).strip()
                    # "idk" is not an answer. Feeding it into _refined_queries
                    # produced garbage follow-up queries and a re-ask loop.
                    if _is_informative(text):
                        answers[question] = text
                    else:
                        logger.info(
                            "questionnaire non-informative answer discarded: {!r}",
                            text[:40],
                        )
        except (EOFError, KeyboardInterrupt):
            print("\n[QUESTIONNAIRE] Cancelled.")
        except _QuestionTimeout:
            logger.info(
                "questionnaire timed out after {}s, proceeding with {} answer(s)",
                limit, len(answers),
            )
            print(f"\n[QUESTIONNAIRE] Timed out after {limit}s; "
                  f"continuing with {len(answers)} answer(s).")
        finally:
            if prior_handler is not None:
                signal.alarm(0)
                try:
                    signal.signal(signal.SIGALRM, prior_handler)
                except (ValueError, OSError):
                    pass
        return answers
        return answers

    @staticmethod
    def _interactive() -> bool:
        """True only when there is a real terminal to read answers from."""
        try:
            return bool(sys.stdin and sys.stdin.isatty())
        except (AttributeError, ValueError):
            return False

    @staticmethod
    def _parse_json_like(response: str) -> dict | None:
        candidate = response.strip()
        candidate = re.sub(r"^```[a-zA-Z]*\s*", "", candidate)
        candidate = re.sub(r"\s*```$", "", candidate)
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            if json_repair is not None:
                try:
                    return json_repair.loads(candidate)
                except Exception:
                    return None
        return None