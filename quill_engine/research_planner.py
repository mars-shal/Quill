"""Service — ResearchPlanner (Query Curator): prompt -> ResearchPlan.

Features 3-5 + 7 of the research phase:

* Feature 4 — a small/cheap LLM (``config.CURATOR_MODEL``, falling back to
  the first active provider) turns the user's prompt into a topic plus a
  list of search queries (what/how/why/...). Each query is later expanded
  per region (``config.RESEARCH_REGIONS``) by :func:`build_search_queries`.
* Feature 7 — one unique research angle is picked per run from
  ``config.RESEARCH_ANGLES`` (hash-stable on the prompt) and added as an
  extra query, so every run researches a different facet of the topic.
* Features 3 + 5 — URLs in the prompt text are separated from normal text
  (deterministic regex, independent of the LLM) into ``prompt_links``; the
  orchestrator fetches those links and merges them into the research corpus.

Nothing here raises: a failed curator call degrades to a deterministic
prompt-derived plan so the research phase survives LLM hiccups.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re


from . import config, providers
from .models import ResearchPlan, ResearchQuery

logger = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://[^\s)\]}]+")


def extract_links(text: str) -> list[str]:
    """Pull bare URLs out of prompt text (feature 3: links vs normal text).

    Deduplicates and strips trailing punctuation. Returns ``[]`` when the
    prompt carries no links, so the research phase never searches URLs.
    """
    if not text:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for url in _URL_RE.findall(text):
        url = url.rstrip(".,;:!?)]}\"'")
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def pick_angle(prompt: str) -> str:
    """Per-run unique research angle (feature 7).

    Hash-stable on the prompt, so the same prompt always picks the same
    angle in a given code/config state — deterministic for verification —
    while different prompts (or a different ``RESEARCH_ANGLES`` pool) get
    different facets. Returns ``""`` when the pool is empty.
    """
    angles = config.RESEARCH_ANGLES
    if not angles:
        return ""
    digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    return angles[int(digest, 16) % len(angles)]


# ---------------------------------------------------------------------------
# Curator LLM call
# ---------------------------------------------------------------------------

_CURATOR_SYSTEM = (
    "You are a research query curator for industrial-training (SIWES/SWEP) "
    "report writing. Given a user's task instruction, produce a compact "
    "research plan as STRICT JSON with exactly these keys:\n"
    '{"topic": "<one-line report topic>",'
    ' "queries": [{"query": "<search query about the domain, not personal facts>",'
    ' "kind": "what|how|why|challenges|innovations|regulatory|examples"}],'
    ' "links": ["<bare URLs mentioned in the instruction, if any>"]}\n'
    "Rules: the topic is the industry/domain the report covers (e.g. an "
    "engineering workshop, a production process, an IT department). Generate "
    "5-7 diverse search queries covering different angles: definitions and "
    "terminology, procedures and methods, standards and specifications, "
    "real-world examples, common problems and solutions, equipment and "
    "materials, and recent developments. Each query must be web-searchable "
    "domain knowledge — never the student's personal details, names, school, "
    "dates, or company. links must be URLs that literally appear in the "
    "instruction. Output JSON only, no prose, no markdown fences."
)


def _curator_complete(prompt: str) -> str:
    """One small-model completion via the first active provider (never raises)."""
    provider = next(iter(providers.active_chain()), None)
    if provider is None:
        logger.warning("query curator: no active LLM provider")
        return ""
    try:
        return providers.complete(
            providers.with_model(provider, config.CURATOR_MODEL),
            [
                {"role": "system", "content": _CURATOR_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=1024,
            max_retries=1,
        )
    except Exception as exc:
        logger.warning("query curator call failed: %s", exc)
        return ""


# ---------------------------------------------------------------------------
# Tolerant parsing
# ---------------------------------------------------------------------------


def _parse_json(raw: str) -> dict | None:
    """Parse the curator's JSON output, tolerating fences and stray prose."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except (ValueError, TypeError):
        pass
    block = re.search(r"\{.*\}", text, re.DOTALL)
    if block:
        try:
            data = json.loads(block.group(0))
            return data if isinstance(data, dict) else None
        except (ValueError, TypeError):
            pass
    return None


def _fallback_plan(prompt: str) -> ResearchPlan:
    """Deterministic plan when the curator returns nothing usable.

    Every query template is interpolated with the actual report topic so
    web searches target the subject being written about — never the literal
    placeholder string "the topic".
    """
    topic = _fallback_topic(prompt)
    base = [
        (f"what is the current state of {topic} in the report", "what"),
        (f"how does {topic} work in practice", "how"),
        (f"why is {topic} important", "why"),
        (f"what challenges affect {topic}", "challenges"),
        (f"what recent innovations relate to {topic}", "innovations"),
        (f"what regulatory framework governs {topic}", "regulatory"),
    ][: max(1, config.CURATOR_QUERIES)]
    queries = [
        ResearchQuery(query=query, region="global", kind=kind)
        for query, kind in base
    ]
    return ResearchPlan(topic=topic, queries=queries, angle="", prompt_links=[])


def _fallback_topic(prompt: str) -> str:
    """First substantive clause of the prompt, trimmed to ~80 chars."""
    cleaned = re.sub(r"\s+", " ", prompt).strip(" .,;:\n")
    if not cleaned:
        return "the report topic"
    for splitter in (". ", "? ", "! ", "\n"):
        first = cleaned.split(splitter, 1)[0]
        if first:
            cleaned = first
            break
    return cleaned[:80]


def _topic_diverges(topic: str, prompt: str) -> bool:
    """True when the curator's topic drifted from the prompt's vocabulary.

    Guards against tiny-model hallucinations (e.g. reading "NUC" as
    "Nuclear"): when the topic shares almost no content words with the
    prompt, the plan falls back to the deterministic prompt-derived plan
    so research never chases a phantom subject. The threshold is strict
    (>= half of the topic's words must come from the prompt) because a
    wrong research subject pollutes every section.
    """
    if not topic:
        return True
    words_topic = {w for w in re.split(r"[^A-Za-z]+", topic.lower()) if len(w) > 3}
    words_prompt = {w for w in re.split(r"[^A-Za-z]+", prompt.lower()) if len(w) > 3}
    if not words_topic:
        return True
    overlap = len(words_topic & words_prompt)
    return overlap / len(words_topic) < 0.5


def _plan_from_data(data: dict, prompt: str) -> ResearchPlan:
    """Build a ResearchPlan from a parsed curator dict (never raises)."""
    raw_topic = str(data.get("topic") or "").strip()
    diverged = _topic_diverges(raw_topic, prompt)
    topic = _fallback_topic(prompt) if diverged else raw_topic

    queries: list[ResearchQuery] = []
    for item in data.get("queries") or []:
        if not isinstance(item, dict):
            continue
        query = str(item.get("query") or "").strip()
        if not query:
            continue
        kind = str(item.get("kind") or "what").strip().lower()
        queries.append(ResearchQuery(query=query, region="global", kind=kind))
        if len(queries) >= config.CURATOR_QUERIES:
            break

    links = extract_links(prompt)
    for item in data.get("links") or []:
        if isinstance(item, str) and item.startswith("http") and item not in links:
            links.append(item)

    if diverged or not queries:
        return _fallback_plan(prompt)

    return ResearchPlan(topic=topic, queries=queries, angle="", prompt_links=links)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_plan(prompt: str) -> ResearchPlan | None:
    """Run the Query Curator over ``prompt`` -> ResearchPlan (never raises).

    ``None`` only for an empty prompt. The plan always carries a topic,
    ``CURATOR_QUERIES`` (or fewer) search queries, the per-run angle, and
    any prompt-supplied links.
    """
    if not prompt or not prompt.strip():
        return None
    raw = _curator_complete(prompt)
    if raw:
        logger.info("thinking: curator output — %s", raw[:2000])
    plan = _plan_from_data(_parse_json(raw) or {}, prompt)
    plan.angle = pick_angle(prompt)
    logger.info(
        "query curator: topic=%r angle=%r queries=%d links=%d",
        plan.topic,
        plan.angle,
        len(plan.queries),
        len(plan.prompt_links),
    )
    for rq in plan.queries:
        logger.info("  sub-search: [%s] %s", rq.kind, rq.query)
    if plan.prompt_links:
        for url in plan.prompt_links:
            logger.info("  prompt link: %s", url)
    return plan


def build_search_queries(plan: ResearchPlan) -> list[str]:
    """Expand a plan into the concrete query list for web search (features 4 + 7).

    Each curated query is searched as-is (global) and once per region
    (``config.RESEARCH_REGIONS``: Nigeria, Africa, Europe, America), then
    the unique angle is added as a final topic-level query. All queries are
    deduplicated and capped so a plan cannot explode the search budget.
    """
    out: list[str] = []
    seen: set[str] = set()

    def add(query: str) -> None:
        query = re.sub(r"\s+", " ", query).strip()
        if query and query not in seen:
            seen.add(query)
            out.append(query)

    for rq in plan.queries:
        add(rq.query)
        for region in config.RESEARCH_REGIONS:
            add(f"{rq.query} {region}")
    if plan.angle:
        add(f"{plan.topic} {plan.angle}")
    return out[: config.CURATOR_QUERIES * (1 + len(config.RESEARCH_REGIONS)) + 2]
