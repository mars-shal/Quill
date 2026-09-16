"""Service 13 — SearchService: agentic web search for supplementary evidence.

DuckDuckGo search (the same open-source backend ScrapeGraphAI's SearchGraph
calls under the hood) followed by markitdown conversion so retrieval can
treat web pages like document chunks. Web material is marked
non-authoritative: it may supply domain facts (what SWEP is, NUC
requirements, workshop procedures) but never personal facts about the
student.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path

from . import config
from .models import SearchResult

logger = logging.getLogger(__name__)

_MIN_DELAY_S = 4.5


# ---------------------------------------------------------------------------
# Disk cache: one JSON file per request under config.SEARCH_CACHE_DIR, so
# repeated runs (and repeated sections researching the same topic) never
# re-pay network requests or hit rate limits.
# ---------------------------------------------------------------------------


def _cache_enabled() -> bool:
    return config.SEARCH_CACHE_TTL_H > 0


def _cache_path(key: str) -> Path:
    return Path(config.SEARCH_CACHE_DIR) / f"{key}.json"


def _cache_key(url: str, payload: dict) -> str:
    raw = url + json.dumps(payload, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> list[dict] | None:
    """Cached results when fresh; None when missing, expired, or unreadable."""
    if not _cache_enabled():
        return None
    path = _cache_path(key)
    try:
        age_s = time.time() - path.stat().st_mtime
        if age_s > config.SEARCH_CACHE_TTL_H * 3600:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else None
    except (OSError, json.JSONDecodeError):
        return None


def _cache_put(key: str, data: list[dict]) -> None:
    if not _cache_enabled() or not data:
        return
    try:
        path = _cache_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")
    except OSError as exc:
        logger.debug("search cache write failed: %s", exc)


def _ddgs_search(query: str, num_results: int) -> list[dict]:
    """Search DuckDuckGo via ``ddgs``; returns raw result dicts (never raises).

    The same open-source backend ScrapeGraphAI's own search path uses
    (``search_on_web`` delegates here). A failure returns an empty list
    so the search layer never breaks the pipeline.
    """
    try:
        from ddgs import DDGS

        with DDGS() as client:
            return [r for r in client.text(query, max_results=num_results) if r.get("href")]
    except Exception as exc:  # noqa: BLE001 — search never breaks the run
        logger.warning("duckduckgo search failed for %r: %s", query, exc)
        return []


def search(query: str, *, num_results: int = 5) -> list[SearchResult]:
    """Search the web via DuckDuckGo; returns ranked results (never raises)."""
    if not config.SEARCH_ENABLED:
        return []
    logger.info("searching: %s", query)
    key = _cache_key(query, {"limit": num_results, "engine": "duckduckgo"})
    cached = _cache_get(key)
    if cached is not None:
        return [SearchResult(**item) for item in cached]
    results: list[SearchResult] = []
    for item in _ddgs_search(query, num_results):
        text = (item.get("body") or "").strip()
        if not text:
            continue
        results.append(
            SearchResult(
                title=item.get("title", ""),
                url=item["href"],
                snippet=text[:300],
                markdown=text,
            )
        )
    if results:
        _cache_put(key, [asdict(r) for r in results])
        for result in results:
            logger.info("  site: %s — %s", result.title or "(untitled)", result.url)
    else:
        logger.info("  no results")
    return results


def _parallel(items: list[str], worker: Callable[[str], object]) -> dict[str, object]:
    """Run ``worker(item)`` for each item on bounded parallel workers.

    Items are split round-robin so each worker keeps the ``_MIN_DELAY_S``
    rate-limit between its own consecutive calls; results are merged back
    in the original input order. A failed item maps to ``None`` — the
    caller decides what absence means. Never raises.
    """
    n = max(1, min(config.SEARCH_CONCURRENCY, len(items)))

    def run(bucket: list[str]) -> dict[str, object]:
        out: dict[str, object] = {}
        for i, item in enumerate(bucket):
            if i > 0:
                time.sleep(_MIN_DELAY_S)
            try:
                out[item] = worker(item)
            except Exception as exc:  # noqa: BLE001 — search never breaks the run
                logger.warning("search call failed for %r: %s", item, exc)
                out[item] = None
        return out

    if n <= 1 or len(items) <= 1:
        return run(items)
    buckets = [items[i::n] for i in range(n)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
        merged: dict[str, object] = {}
        for partial in pool.map(run, buckets):
            merged.update(partial)
    return merged


def search_many(
    queries: list[str], *, num_results: int | None = None
) -> dict[str, list[SearchResult]]:
    """Run one web search per query; returns ``{query: results}``.

    Queries run on up to ``config.SEARCH_CONCURRENCY`` parallel workers
    (each still rate-limited by ``_MIN_DELAY_S`` between its own calls).
    Each query is capped at ``config.SEARCH_RESULTS`` results (or
    ``num_results`` when given).  A failed query yields an empty list —
    never raises, so the research phase survives partial search failures.
    """
    per_query = num_results or config.SEARCH_RESULTS
    active = [q for q in queries if q.strip()]
    if not active:
        return {}

    def worker(q: str) -> list[SearchResult]:
        return search(q, num_results=per_query)

    merged = _parallel(active, worker)
    return {q: merged.get(q) or [] for q in active}


def _scrapegraph_llm_config() -> dict | None:
    """LLM config for ScrapeGraphAI from the active provider chain.

    Returns the ``{"model_instance": ChatOpenAI, "model_tokens": n}`` dict
    ScrapeGraphAI's ``_create_llm`` accepts directly, wired to the first
    active provider that has a real model name (skipping ``"default"``
    placeholders). None when no provider qualifies, so callers fall back.
    """
    try:
        from langchain_openai import ChatOpenAI
    except ImportError:
        return None
    try:
        from . import providers
    except ImportError:
        return None
    for provider in providers.active_chain():
        model = getattr(provider, "model", "") or ""
        if not model or model == "default":
            continue
        try:
            kwargs: dict = {
                "model": model,
                "api_key": provider.api_key or "not-needed",
                "base_url": provider.base_url,
                "temperature": 0,
            }
            if "11434" in provider.base_url or "ollama" in provider.base_url.lower():
                kwargs["extra_body"] = {"format": "json"}
            llm = ChatOpenAI(**kwargs)
        except Exception as exc:  # noqa: BLE001 — probe the next provider
            logger.debug("scrapegraph llm config failed for %s: %s", provider.name, exc)
            continue
        return {"model_instance": llm, "model_tokens": config.SCRAPEGRAPH_MODEL_TOKENS}
    return None


def _scrapegraph_extract(url: str, timeout: float | None = None) -> str:
    """LLM-extract ``url`` via ScrapeGraphAI SmartScraperGraph (never raises).

    Returns the extracted notes as text; "" when disabled, the dependency
    is missing, no provider qualifies, or extraction failed (the caller
    falls back to markitdown).
    """
    if not config.SCRAPEGRAPH_ENABLED:
        return ""
    try:
        from scrapegraphai.graphs import SmartScraperGraph
    except ImportError:
        return ""
    llm_config = _scrapegraph_llm_config()
    if llm_config is None:
        return ""
    if timeout is None:
        timeout = config.SCRAPEGRAPH_TIMEOUT_S
    try:
        graph = SmartScraperGraph(
            prompt=config.SCRAPEGRAPH_PROMPT,
            source=url,
            config={"llm": llm_config, "verbose": False, "headless": True},
        )
    except Exception as exc:  # noqa: BLE001 — extraction must never raise
        logger.warning("scrapegraph construction failed for %s: %s", url, exc)
        return ""

    outcome: dict[str, object] = {"result": {}, "error": None}

    def _run() -> None:
        try:
            outcome["result"] = graph.run()
        except Exception as exc:  # noqa: BLE001 — captured, not raised
            outcome["error"] = exc

    worker = threading.Thread(target=_run, daemon=True)
    worker.start()
    worker.join(timeout=timeout)
    if worker.is_alive():
        logger.warning("scrapegraph extraction timed out for %s", url)
        return ""
    if outcome["error"] is not None:
        logger.warning("scrapegraph extraction failed for %s: %s", url, outcome["error"])
        return ""
    result = outcome["result"]
    if not result:
        return ""
    if isinstance(result, str):
        return result.strip()
    try:
        return json.dumps(result, indent=2, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(result)


def fetch_links(urls: list[str]) -> dict[str, str]:
    """Batch-fetch multiple URLs to markdown (never raises).

    Used to merge links extracted from the user's prompt into the
    research corpus (feature 5).  Runs on up to
    ``config.SEARCH_CONCURRENCY`` parallel workers.  Returns
    ``{url: markdown}`` for every URL that produced content; unusable
    URLs are simply absent.
    """
    if not config.SEARCH_ENABLED:
        return {}
    valid = [u for u in dict.fromkeys(urls) if u and u.startswith(("http://", "https://"))]
    if not valid:
        return {}
    logger.info("fetching %d prompt link(s)", len(valid))

    def worker(url: str) -> str:
        md = _scrapegraph_extract(url)
        if not md:
            md = _fetch_markitdown(url)
        if md.strip():
            logger.info("  fetched: %s", url)
        return md

    merged = _parallel(valid, worker)
    return {url: md for url, md in merged.items() if isinstance(md, str) and md.strip()}


def _fetch_markitdown(url: str) -> str:
    """Convert ``url`` to markdown via markitdown without raising."""
    try:
        from markitdown import MarkItDown

        return MarkItDown(enable_plugins=False).convert_url(url).markdown or ""
    except Exception:  # noqa: BLE001 — never break the pipeline
        logger.debug("markitdown failed for %s", url)
        return ""


def fetch(url: str) -> str:
    """Fetch ``url`` and convert to markdown (never raises).

    ScrapeGraphAI extraction first, then markitdown as the open-source
    fallback, then an empty string so the search layer never breaks the
    pipeline.
    """
    if not config.SEARCH_ENABLED or not url:
        return ""
    md = _scrapegraph_extract(url)
    if md.strip():
        return md
    return _fetch_markitdown(url)
