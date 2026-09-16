"""Central configuration for quill_engine.

Every knob lives here (or under env vars) so services never hardcode
keys, model ids, or budgets. Existing values mirror what was previously
inlined in ``main.py``.
"""

from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv(path: str | Path = ".env") -> None:
    """Populate ``os.environ`` from a ``KEY=VALUE`` file (stdlib only).

    Existing environment variables always win, so an exported key overrides
    ``.env``. Never raises: a missing or malformed file is simply skipped.
    Called before any config constant is resolved, so secrets live in
    ``.env`` (gitignored) instead of this module.
    """
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

# ---------------------------------------------------------------------------
# Providers — API keys are read from the environment (or a `.env` file at
# the project root; see `.env.example`). No key is ever hardcoded here.
# ---------------------------------------------------------------------------

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
SEARCH_ENABLED = os.environ.get("QUILL_SEARCH", "1") not in {"0", "false", "no"}
WEB_SUPPLEMENT_ALL = os.environ.get("QUILL_WEB_SUPPLEMENT", "1") not in {"0", "false", "no"}
SEARCH_RESULTS = int(os.environ.get("QUILL_SEARCH_RESULTS", "5"))
# Search results are cached on disk so repeated runs (and repeated
# sections researching the same topic) never re-pay the wait.
# 0 disables the cache; TTL is in hours.
SEARCH_CACHE_DIR = os.environ.get(
    "QUILL_SEARCH_CACHE_DIR", os.path.expanduser("~/.quill-engine/cache")
)
SEARCH_CACHE_TTL_H = float(os.environ.get("QUILL_SEARCH_CACHE_TTL_H", "168"))
# Parallel web searches (per-worker rate limit still applies).
SEARCH_CONCURRENCY = int(os.environ.get("QUILL_SEARCH_CONCURRENCY", "3"))

# ---------------------------------------------------------------------------
# ScrapeGraphAI — LLM page extraction for research fetches. When the package
# is importable, fetch_links/fetch route page content through a
# SmartScraperGraph (using the active LLM provider chain) and fall back to
# markitdown when extraction fails.
# ---------------------------------------------------------------------------
SCRAPEGRAPH_ENABLED = os.environ.get("QUILL_SCRAPEGRAPH", "1") not in {"0", "false", "no"}
SCRAPEGRAPH_MODEL_TOKENS = int(os.environ.get("QUILL_SCRAPEGRAPH_TOKENS", "8192"))
SCRAPEGRAPH_TIMEOUT_S = float(os.environ.get("QUILL_SCRAPEGRAPH_TIMEOUT", "45"))
SCRAPEGRAPH_PROMPT = os.environ.get(
    "QUILL_SCRAPEGRAPH_PROMPT",
    "Extract the substantive content of this page as structured markdown notes: "
    "key facts, statistics, figures, named entities, and quotable claims. "
    "Preserve exact numbers and quote wording. Return the notes only.",
)

# ---------------------------------------------------------------------------
# Provider failover chain (WritingService). Providers are tried in this
# order; a provider that is rate-limited or otherwise failing is marked
# down (honoring Retry-After) and the next one is used, so one exhausted
# provider never fails the run. Names must be keys of providers.PROVIDER_DEFS.
# ---------------------------------------------------------------------------

LLM_PROVIDERS = [
    p.strip()
    for p in os.environ.get("LLM_PROVIDERS", "ollama").split(",")
    if p.strip()
]

GROQ_MODEL = os.environ.get(
    "GROQ_MODEL", os.environ.get("LLM_MODEL", "llama-3.3-70b-versatile")
)
OPENROUTER_MODEL = os.environ.get(
    "OPENROUTER_MODEL", "google/gemma-4-31b-it:free"
)
GOOGLE_MODEL = os.environ.get("GOOGLE_MODEL", "gemini-flash-latest")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:1b")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
MISTRAL_MODEL = os.environ.get("MISTRAL_MODEL", "mistral-large-latest")
TOGETHER_MODEL = os.environ.get(
    "TOGETHER_MODEL", "meta-llama/Llama-3.3-70B-Instruct-Turbo"
)
XAI_MODEL = os.environ.get("XAI_MODEL", "grok-3-mini")
LMSTUDIO_MODEL = os.environ.get("LMSTUDIO_MODEL", "local-model")
VLLM_MODEL = os.environ.get("VLLM_MODEL", "local")

# Writing profile: "small" tunes generation for small/local models (staged
# planning pass, tighter outputs), "large" uses single-pass generation.
# "auto" picks small when the first provider in the chain is local
# (ollama/lmstudio/vllm).
LLM_PROFILE = os.environ.get("QUILL_PROFILE", "auto").lower()

# Staged writing: run a cheap planning pass ("beats") before each section so
# small models stay grounded and coherent. "auto" enables it for local/small
# profiles; "1"/"0" force it on/off. Doubles LLM calls, halves drift.
WRITING_STAGED = os.environ.get("QUILL_STAGED", "auto").lower()

# Deterministic temperature per .agent/agent.md §7 (0.2–0.4).
LLM_TEMPERATURE = 0.3
LLM_MAX_TOKENS = 4096
LLM_TIMEOUT_S = float(os.environ.get("QUILL_LLM_TIMEOUT", "300"))
LLM_MAX_RETRIES = int(os.environ.get("LLM_MAX_RETRIES", "2"))
LLM_PROVIDER_COOLDOWN_S = int(os.environ.get("LLM_PROVIDER_COOLDOWN_S", "120"))
# When every provider is in cooldown, WritingService waits for the earliest
# cooldown to expire (up to this total) before failing the section.
LLM_ALL_DOWN_MAX_WAIT_S = int(os.environ.get("LLM_ALL_DOWN_MAX_WAIT_S", "600"))

# Legacy single-provider override: when LLM_BASE_URL is set explicitly the
# chain collapses to that endpoint with LLM_MODEL (e.g. local Ollama /v1).
LLM_MODEL = os.environ.get("LLM_MODEL", GROQ_MODEL)
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")
LLM_BASE_URL_EXPLICIT = "LLM_BASE_URL" in os.environ

# DocumentProcessor's MarkItDown LLM client (image-heavy extraction only).
# Kept on the cloud providers even when the writing engine runs on Ollama.
EXTRACTION_BASE_URL = os.environ.get(
    "EXTRACTION_BASE_URL", "https://openrouter.ai/api/v1"
)
EXTRACTION_MODEL = os.environ.get("EXTRACTION_MODEL", "google/gemma-4-31b-it:free")

# EmbeddingService model + batching (NFR: batch 64, retry 3x).
EMBEDDING_MODEL = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384
EMBED_BATCH_SIZE = 64
EMBED_MAX_RETRIES = 3

# Device for sentence-transformer embeddings. The embedding model is small
# (~80MB) so CPU is fast and avoids CUDA launch failures on weaker GPUs.
EMBEDDING_DEVICE = os.environ.get("QUILL_EMBEDDING_DEVICE", "auto") 

# ---------------------------------------------------------------------------
# ChunkingService budgets (.agent/agent.md §3)
# ---------------------------------------------------------------------------

CHUNK_MIN_TOKENS = 400
CHUNK_MAX_TOKENS = 800
CHUNK_OVERLAP_TOKENS = 50
CHUNK_TOKENIZER = "cl100k_base"

# ---------------------------------------------------------------------------
# RetrievalService budgets (.agent/agent.md §5 + Architecture doc)
# ---------------------------------------------------------------------------

RETRIEVAL_TOP_K = 8
TARGET_CONTEXT_TOKENS = 12_000

# ---------------------------------------------------------------------------
# Evidence gating (RequirementService / Orchestrator)
# ---------------------------------------------------------------------------

# Coverage = fields present in evidence / fields required by the section.
# Below MIN -> section is blocked (never written); below WARN -> written
# with warnings; at/above WARN -> written normally.
EVIDENCE_MIN_COVERAGE = float(os.environ.get("QUILL_EVIDENCE_MIN", "0.7"))
EVIDENCE_WARN_COVERAGE = float(os.environ.get("QUILL_EVIDENCE_WARN", "0.9"))
EVIDENCE_FILE = os.environ.get("QUILL_EVIDENCE_FILE", "")

# One LLM style-analysis call per chapter (cached); deterministic metrics
# always run. Disable to keep runs fully local-deterministic.
STYLE_ANALYSIS_ENABLED = os.environ.get("QUILL_STYLE_ANALYSIS", "1") not in {
    "0",
    "false",
    "no",
}

# ---------------------------------------------------------------------------
# ValidationService (.agent/agent.md §8)
# ---------------------------------------------------------------------------

MIN_SECTION_WORDS = int(os.environ.get("QUILL_MIN_SECTION_WORDS", "50"))

# Severe warnings (repeated paragraphs, verbatim source copying, placeholders,
# too-short output) trigger an automatic rewrite pass — up to
# GENERATION_MAX_RETRIES attempts before the section is accepted as-is.
GENERATION_MAX_RETRIES = int(os.environ.get("QUILL_GENERATION_RETRIES", "2"))

# Fraction of the generated text's 6-grams that may appear verbatim in the
# source evidence before the output is flagged as a copy rather than a write.
VERBATIM_COPY_THRESHOLD = float(os.environ.get("QUILL_VERBATIM_THRESHOLD", "0.5"))

# Sentence-level plagiarism gate: a sentence whose 7-gram containment against
# the evidence exceeds this is flagged (severe -> rewrite pass) even when the
# section's overall overlap stays under VERBATIM_COPY_THRESHOLD. 0 disables.
PLAGIARISM_SENTENCE_THRESHOLD = float(os.environ.get("QUILL_PLAG_THRESHOLD", "0.6"))

# ---------------------------------------------------------------------------
# ContextBuilder (WritingService prompt construction)
# ---------------------------------------------------------------------------

# Instruct the model to render structured evidence (activity logs, equipment
# lists, schedules) as markdown tables, and to leave [IMAGE: caption] markers
# where a figure/photo belongs in the report.
GENERATE_TABLES = os.environ.get("QUILL_GENERATE_TABLES", "1") not in {"0", "false", "no"}
INCLUDE_IMAGE_PLACEHOLDERS = os.environ.get("QUILL_IMAGE_PLACEHOLDERS", "1") not in {
    "0",
    "false",
    "no",
}
# When enabled the writer must emit `[MISSING: field]` markers instead of
# inventing content for fields the evidence cannot support.
STRICT_EVIDENCE = os.environ.get("QUILL_STRICT_EVIDENCE", "1") not in {
    "0",
    "false",
    "no",
}

# Cleaner (Stage 4): scrub boilerplate (ISBN/DOI/copyright, navigation and
# TOC fragments, bare URLs, retrieval IDs, citation blocks) from retrieved
# text so the writer never sees raw scrape content.
CLEAN_EVIDENCE = os.environ.get("QUILL_CLEAN", "1") not in {"0", "false", "no"}

# ---------------------------------------------------------------------------
# Humanizer style rules (ContextBuilder)
# ---------------------------------------------------------------------------

# When enabled the system instructions append a "write like a human" block:
# varied sentence lengths, no transition glue, plain words over corporate
# speak, concrete specifics, and no AI buzzwords. Applied to generate and
# rewrite prompts alike.
HUMANIZER_ENABLED = os.environ.get("QUILL_HUMANIZER", "1") not in {
    "0",
    "false",
    "no",
}

# ---------------------------------------------------------------------------
# Relation layer (RetrievalService)
# ---------------------------------------------------------------------------

# Each section is compared against its sibling sections (header-embedding
# cosine). Related siblings' summaries are pulled into the prompt so the
# writer ties the section to the document instead of drifting off-topic,
# and web/knowledge research queries are grounded in those related titles
# so the research a section draws on is connected to its context.
RELATION_ENABLED = os.environ.get("QUILL_RELATION", "1") not in {"0", "false", "no"}
RELATION_TOP_K = int(os.environ.get("QUILL_RELATION_TOP_K", "3"))
# Minimum cosine similarity for a sibling to count as related (below this
# the section is treated as standalone and no relation context is added).
RELATION_MIN_SIMILARITY = float(os.environ.get("QUILL_RELATION_SIM", "0.3"))

# ---------------------------------------------------------------------------
# Section merging (/merge command)
# ---------------------------------------------------------------------------

# Minimum header-embedding cosine similarity for two sibling sections to be
# merged into one by the `/merge` command. High bar: only near-duplicates
# should merge (a report chapter duplicated verbatim, or two leaves that
# clearly cover the same ground).
MERGE_MIN_SIMILARITY = float(os.environ.get("QUILL_MERGE_SIM", "0.85"))

# ---------------------------------------------------------------------------
# Evidence Builder (Stage 5: raw chunks -> compact fact packets)
# ---------------------------------------------------------------------------

# Hard caps on facts rendered into prompts: count, per-fact length, total.
EVIDENCE_MAX_FACTS = int(os.environ.get("QUILL_EVIDENCE_FACTS", "30"))
EVIDENCE_MAX_CHARS_PER_FACT = int(os.environ.get("QUILL_EVIDENCE_FACT_CHARS", "240"))
EVIDENCE_MAX_TOTAL_CHARS = int(os.environ.get("QUILL_EVIDENCE_CHARS", "12000"))

# ---------------------------------------------------------------------------
# ExportService
# ---------------------------------------------------------------------------

EXPORT_DIR = os.environ.get("QUILL_EXPORT_DIR", "output")

# Directory for the disk-backed store (``QUILL_STORE=disk``). Project state —
# sections, chunks, vectors, generations, evidence, style profiles — is
# persisted here as one JSON file per project so a re-opened document can be
# rewritten instead of regenerated.
PERSIST_DIR = os.environ.get("QUILL_PERSIST_DIR", os.path.join(".quill_engine", "projects"))

# During export/preview, re-derive (via the rewrite cascade) any section that
# is missing, failed, blocked, or carries severe validation warnings — so the
# emitted document is cleaned up at write time instead of only on generate.
EXPORT_REWRITE_SECTIONS = os.environ.get("QUILL_EXPORT_REWRITE_SECTIONS", "1") not in {
    "0",
    "false",
    "no",
}

# When a rewrite instruction is given, allow the rewrite cascade to restructure
# the section tree (add/remove/rewrite sections) instead of only rewriting
# existing bodies. Structural changes are instruction-driven only: they never
# run at export time and never when the user selected specific sections.
REWRITE_STRUCTURE_ENABLED = os.environ.get("QUILL_REWRITE_STRUCTURE", "1") not in {
    "0",
    "false",
    "no",
}

# After a section rewrite succeeds, automatically find other sections whose
# stored chunk embeddings are similar to the rewritten text and align them
# with it (facts, terminology, tone) so the document stays consistent. The
# matched sections are rewritten with the source text attached as a reference
# — alignment standard, never a copy source. Bounded by REWRITE_CASCADE_MAX
# and gated on the rewrite path only.
REWRITE_CASCADE_ENABLED = os.environ.get("QUILL_REWRITE_CASCADE", "1") not in {
    "0",
    "false",
    "no",
}
REWRITE_CASCADE_MAX = int(os.environ.get("QUILL_REWRITE_CASCADE_MAX", "3"))
REWRITE_CASCADE_SIMILARITY = float(
    os.environ.get("QUILL_REWRITE_CASCADE_SIM", "0.35")
)

# Model override for the restructure planner's LLM call (plan_restructure);
# empty -> the curator model, then the first active provider's default.
PLAN_MODEL = os.environ.get("QUILL_PLAN_MODEL", "")

# Structure-only ingestion: keep the template's section tree (headings,
# levels, order) but drop its content entirely. The template's prose is
# never used as evidence; writing is driven by the topic from the prompt,
# per-section research, and the user's questionnaire answers instead.
STRUCTURE_ONLY = os.environ.get("QUILL_STRUCTURE_ONLY", "1") not in {"0", "false", "no"}

# When structure-only, force a per-section web supplement for every section
# (including personal ones like Week logs); without it, personal sections get
# only graph notes + user answers.
STRUCTURE_ONLY_WEB_ALL = os.environ.get("QUILL_STRUCTURE_ONLY_WEB_ALL", "1") not in {
    "0",
    "false",
    "no",
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

# Task instruction for non-interactive runs (QUILL_PROMPT); in a TTY the
# CLI asks interactively instead.
PROMPT = os.environ.get("QUILL_PROMPT", "")

# Thinking layer (follow-up interview): after the structure is extracted, a
# thinking model proposes follow-up questions which are asked via questionary.
INTERVIEW_ENABLED = os.environ.get("QUILL_INTERVIEW", "1") not in {"0", "false", "no"}
# Model for the thinking layer; falls back to the first active provider.
INTERVIEW_MODEL = os.environ.get("QUILL_INTERVIEW_MODEL", "")
# Max follow-up questions per run.
INTERVIEW_MAX_QUESTIONS = int(os.environ.get("QUILL_INTERVIEW_QUESTIONS", "4"))
# Max template sections extracted from the task instruction per run; each is
# appended to the document as a new section to generate.
TEMPLATE_MAX_SECTIONS = int(os.environ.get("QUILL_TEMPLATE_SECTIONS", "10"))

# ---------------------------------------------------------------------------
# Research phase (Query Curator -> web search -> knowledge graph)
# ---------------------------------------------------------------------------

# Master switch for the research phase (features 3-7). When enabled the
# orchestrator runs: prompt -> query curator (topic + query list) -> web
# searches (incl. region variants and the per-run unique angle) -> results
# merged with prompt-supplied links -> persisted to the knowledge graph.
RESEARCH_ENABLED = os.environ.get("QUILL_RESEARCH", "1") not in {"0", "false", "no"}

# Small/cheap model for the Query Curator (topic -> search queries). Falls
# back to the normal writing chain when unset.
CURATOR_MODEL = os.environ.get("QUILL_CURATOR_MODEL", "")

# How many curated queries per topic (each query is also searched per region).
CURATOR_QUERIES = int(os.environ.get("QUILL_CURATOR_QUERIES", "6"))

# Regions searched per query (the user's "Nigeria / Africa / Europe / America").
RESEARCH_REGIONS = [
    r.strip()
    for r in os.environ.get("QUILL_RESEARCH_REGIONS", "Nigeria,Africa,Europe,America").split(",")
    if r.strip()
]

# Unique-angle pool: one angle is picked per run so every report researches a
# different facet of the same topic (feature 7).
RESEARCH_ANGLES = [
    a.strip()
    for a in os.environ.get(
        "QUILL_RESEARCH_ANGLES",
        "current state,key challenges,recent innovations,regulatory framework,case studies,future outlook",
    ).split(",")
    if a.strip()
]

# Max links kept per curated query (web results + prompt-supplied links).
RESEARCH_MAX_LINKS = int(os.environ.get("QUILL_RESEARCH_MAX_LINKS", "5"))

# ---------------------------------------------------------------------------
# Knowledge graph / memory (basic-memory, features 2 + 6)
# ---------------------------------------------------------------------------

MEMORY_ENABLED = os.environ.get("QUILL_MEMORY", "1") not in {"0", "false", "no"}
MEMORY_PROJECT = os.environ.get("QUILL_MEMORY_PROJECT", "quill-engine")
# Workspace dir holding the markdown notes + sqlite knowledge graph.
MEMORY_DATA_DIR = os.environ.get("QUILL_MEMORY_DIR", "~/.quill-engine/memory")

# ---------------------------------------------------------------------------
# OpenSearch + Redis storage backend (feature 8)
# ---------------------------------------------------------------------------

OPEN_SEARCH_URL = os.environ.get("OPEN_SEARCH_URL", "")
OPEN_SEARCH_USER = os.environ.get("OPEN_SEARCH_USER", "")
OPEN_SEARCH_PASSWORD = os.environ.get("OPEN_SEARCH_PASSWORD", "")

# Verify TLS certificates for the OpenSearch connection (default on). Only
# disable for clusters with self-signed certs you control.
OS_VERIFY_TLS = os.environ.get("QUILL_OS_VERIFY_TLS", "1") not in {"0", "false", "no"}

REDIS_URL = os.environ.get("REDIS_URL", "")

# Explicit QUILL_STORE wins; default to the in-memory backend so the
# pipeline never depends on an external cluster (opt in via QUILL_STORE=opensearch).
STORE_BACKEND = os.environ.get("QUILL_STORE", "memory")

# Index names for the OpenSearch backend.
OS_INDEX_SECTIONS = os.environ.get("QUILL_OS_INDEX_SECTIONS", "quill-sections")
OS_INDEX_CHUNKS = os.environ.get("QUILL_OS_INDEX_CHUNKS", "quill-chunks")
OS_INDEX_VECTORS = os.environ.get("QUILL_OS_INDEX_VECTORS", "quill-vectors")
OS_INDEX_GENERATIONS = os.environ.get("QUILL_OS_INDEX_GENERATIONS", "quill-generations")
OS_INDEX_EVIDENCE = os.environ.get("QUILL_OS_INDEX_EVIDENCE", "quill-evidence")
OS_INDEX_STYLE = os.environ.get("QUILL_OS_INDEX_STYLE", "quill-style")
