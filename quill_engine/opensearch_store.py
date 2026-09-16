"""Service — OpenSearch + Redis storage backend (feature 8).

``OpenSearchStore`` implements the same :class:`StorageService` protocol as
``InMemoryStore`` (:mod:`.storage`) but persists each project's buckets to
OpenSearch indexes (``config.OS_INDEX_*``) as JSON documents, with an
optional Redis read cache (``config.REDIS_URL``) in front of the hot reads.

Serialization: every dataclass in :mod:`.models` (Section tree, Chunk,
VectorRecord, GenerationResult, Warning, EvidenceRequirement, ...) is
converted to/from plain JSON via :func:`dataclasses.asdict`-compatible
helpers, so the OpenSearch documents round-trip losslessly.

Safety: every method degrades instead of raising — a failed OpenSearch call
logs a warning and the store keeps serving from its in-process cache (the
last successfully written state), so the pipeline never breaks because the
backend hiccupped. ``new_store()`` is the factory: it honors
``config.STORE_BACKEND`` and falls back to :class:`InMemoryStore` when
OpenSearch is unreachable or unconfigured.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from . import config
from .models import (
    Chunk,
    ContentUnit,
    GenerationResult,
    ScoredChunk,
    Section,
    SourceRef,
    VectorRecord,
    Warning,
    new_chunk,
    new_section,
    new_vector_record,
)
from .storage import InMemoryStore, StorageService, cosine_similarity

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# JSON (de)serialization helpers — lossless for our dataclasses
# ---------------------------------------------------------------------------


def _to_json(value: Any) -> dict:
    """Dataclass -> JSON dict (recursive); lists of dataclasses too."""
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_json(v) for k, v in asdict(value).items()}
    if isinstance(value, list):
        return [_to_json(item) for item in value]
    if isinstance(value, dict):
        return {k: _to_json(v) for k, v in value.items()}
    return value


def _section_from_json(data: dict) -> Section:
    """Rebuild a Section (with children) from its JSON dict."""
    return Section(
        section_id=data["section_id"],
        title=data["title"],
        level=data["level"],
        order=data["order"],
        parent_id=data.get("parent_id"),
        description=data.get("description", ""),
        content=[
            ContentUnit(
                text=c.get("text", ""),
                kind=c.get("kind", "paragraph"),
                table_data=c.get("table_data"),
            )
            for c in data.get("content", [])
        ],
        children=[_section_from_json(c) for c in data.get("children", [])],
        word_count=data.get("word_count", 0),
        summary=data.get("summary", ""),
    )


def _chunk_from_json(data: dict) -> Chunk:
    return Chunk(
        chunk_id=data["chunk_id"],
        section_id=data["section_id"],
        text=data["text"],
        tokens=data["tokens"],
        kind=data.get("kind", "paragraph"),
        table_data=data.get("table_data"),
    )


def _vector_from_json(data: dict) -> VectorRecord:
    return new_vector_record(
        data["section_id"], data["embedding"], model=data.get("model", config.EMBEDDING_MODEL),
        dim=data.get("dim", config.EMBEDDING_DIM), chunk_id=data.get("chunk_id"),
        kind=data.get("kind", "chunk"),
    )


def _generation_from_json(data: dict) -> GenerationResult:
    return GenerationResult(
        section_id=data["section_id"],
        text=data.get("text", ""),
        warnings=[
            Warning(code=w.get("code", "unknown"), message=w.get("message", ""),
                    location=w.get("location"))
            for w in data.get("warnings", [])
        ],
        status=data.get("status", "generated"),
        error=data.get("error"),
        missing_fields=list(data.get("missing_fields", [])),
        sources=[
            SourceRef(
                title=s.get("title", ""),
                url=s.get("url", ""),
                kind=s.get("kind", ""),
            )
            for s in data.get("sources", [])
        ],
        model=data.get("model", ""),
    )


def _style_from_json(data: dict) -> dict:
    return dict(data)


# ---------------------------------------------------------------------------
# RedisCache — optional read cache (disabled when REDIS_URL is empty)
# ---------------------------------------------------------------------------


class RedisCache:
    """Thin key/string cache over Redis; never raises (disabled on failure)."""

    def __init__(self) -> None:
        self._client = None
        self._enabled = False
        url = config.REDIS_URL
        if not url:
            return
        try:
            import redis

            client = redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2)
            client.ping()
            self._client = client
            self._enabled = True
        except Exception as exc:  # noqa: BLE001 — backend must never break us
            logger.warning("redis unavailable (%s): %s", url, exc)

    @property
    def enabled(self) -> bool:
        return self._enabled

    def get(self, key: str) -> str | None:
        if not self._enabled:
            return None
        try:
            value = self._client.get(key)  # type: ignore[union-attr]
            return value.decode("utf-8") if isinstance(value, bytes) else value
        except Exception as exc:  # noqa: BLE001
            logger.warning("redis get failed: %s", exc)
            return None

    def set(self, key: str, value: str, ttl: int = 3600) -> None:
        if not self._enabled:
            return
        try:
            self._client.set(key, value, ex=ttl)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.warning("redis set failed: %s", exc)

    def delete(self, key: str) -> None:
        if not self._enabled:
            return
        try:
            self._client.delete(key)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.warning("redis delete failed: %s", exc)


# ---------------------------------------------------------------------------
# OpenSearchStore — StorageService protocol over OpenSearch + Redis
# ---------------------------------------------------------------------------


class OpenSearchStore:
    """OpenSearch-backed implementation of :class:`StorageService`.

    Layout: one document per (index, project_id); the document is the whole
    bucket (list of sections/chunks/vectors or keyed maps) serialized as
    JSON. ``_cache`` is the last-written in-process state, so reads keep
    working during OpenSearch outages and the store never raises.
    """

    def __init__(self, client: Any, *, cache: InMemoryStore | None = None, redis: RedisCache | None = None) -> None:
        self._client = client
        self._cache = cache or InMemoryStore()
        self._redis = redis or RedisCache()
        self._indices = set()

    # -- low-level OpenSearch helpers -------------------------------------

    def _ensure_index(self, index: str) -> None:
        if index in self._indices:
            return
        try:
            if not self._client.indices.exists(index=index):
                # ``doc`` stores the whole project bucket as raw JSON; the
                # mapping is disabled so keyed chunk/vector dicts never
                # explode into thousands of mapped fields (each 384-dim
                # embedding alone would add ~384 fields and trip the 1000
                # field cap). Reads use ``client.get`` and need no mapping.
                self._client.indices.create(index=index, body={
                    "mappings": {"properties": {"doc": {"type": "object", "enabled": False}}}
                })
            self._indices.add(index)
        except Exception as exc:  # noqa: BLE001
            logger.warning("opensearch index %s unavailable: %s", index, exc)

    def _put(self, index: str, project_id: str, payload: Any) -> None:
        """Write a bucket document to OpenSearch + in-process cache."""
        self._ensure_index(index)
        body = _to_json(payload)
        try:
            self._client.index(index=index, id=f"proj-{project_id}", body={"doc": body})
            if self._redis.enabled:
                self._redis.set(f"quill:{index}:{project_id}", json.dumps(body))
        except Exception as exc:  # noqa: BLE001
            logger.warning("opensearch write %s/%s failed: %s", index, project_id, exc)

    def _get(self, index: str, project_id: str) -> dict | None:
        """Read a bucket document: Redis cache -> OpenSearch -> in-process cache."""
        key = f"quill:{index}:{project_id}"
        if self._redis.enabled:
            raw = self._redis.get(key)
            if raw is not None:
                try:
                    data = json.loads(raw)
                    return data.get("doc", data)
                except (ValueError, TypeError):
                    pass
        try:
            response = self._client.get(index=index, id=f"proj-{project_id}")
            source = response.get("_source", {})
            return source.get("doc", source)
        except Exception as exc:  # noqa: BLE001
            logger.warning("opensearch read %s/%s failed: %s", index, project_id, exc)
            return None

    # -- sections ---------------------------------------------------------

    def save_sections(self, project_id: str, sections: list[Section]) -> None:
        self._cache.save_sections(project_id, sections)
        self._put(config.OS_INDEX_SECTIONS, project_id, [_to_json(s) for s in sections])

    def get_sections(self, project_id: str) -> list[Section]:
        data = self._get(config.OS_INDEX_SECTIONS, project_id)
        if isinstance(data, list):
            try:
                return [_section_from_json(item) for item in data]
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("opensearch sections deserialize failed: %s", exc)
        return self._cache.get_sections(project_id)

    def get_all_leaves(self, project_id: str) -> list[Section]:
        return [leaf for section in self.get_sections(project_id) for leaf in section.leaves()]

    # -- chunks -----------------------------------------------------------

    def save_chunks(self, project_id: str, chunks: list[Chunk]) -> None:
        self._cache.save_chunks(project_id, chunks)
        self._put(config.OS_INDEX_CHUNKS, project_id, {
            chunk.chunk_id: _to_json(chunk) for chunk in chunks
        })

    def _chunks_for(self, project_id: str) -> dict[str, Chunk]:
        out: dict[str, Chunk] = {}
        data = self._get(config.OS_INDEX_CHUNKS, project_id)
        if isinstance(data, dict):
            try:
                for cid, item in data.items():
                    out[cid] = _chunk_from_json(item)
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("opensearch chunks deserialize failed: %s", exc)
        cached = self._cache._chunks.get(project_id, {})  # noqa: SLF001
        out.update(cached)
        return out

    # -- vectors ----------------------------------------------------------

    def save_vectors(self, project_id: str, records: list[VectorRecord]) -> None:
        self._cache.save_vectors(project_id, records)
        self._put(config.OS_INDEX_VECTORS, project_id, {
            record.vector_id: _to_json(record) for record in records
        })

    def _vectors_for(self, project_id: str) -> list[VectorRecord]:
        out: list[VectorRecord] = []
        data = self._get(config.OS_INDEX_VECTORS, project_id)
        if isinstance(data, dict):
            try:
                for item in data.values():
                    out.append(_vector_from_json(item))
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("opensearch vectors deserialize failed: %s", exc)
        out.extend(self._cache._vectors.get(project_id, []))  # noqa: SLF001
        return out

    def get_header_embedding(self, project_id: str, section_id: str) -> list[float] | None:
        for record in self._vectors_for(project_id):
            if record.kind == "header" and record.section_id == section_id:
                return record.embedding
        return None

    def search_vectors(
        self,
        project_id: str,
        query_embedding: list[float],
        *,
        section_ids: list[str],
        top_k: int,
    ) -> list[ScoredChunk]:
        """Cosine rank over stored chunk vectors (mirrors InMemoryStore)."""
        allowed = set(section_ids)
        scored: list[tuple[float, VectorRecord]] = []
        for record in self._vectors_for(project_id):
            if record.kind != "chunk" or record.section_id not in allowed:
                continue
            scored.append((cosine_similarity(query_embedding, record.embedding), record))
        scored.sort(key=lambda pair: pair[0], reverse=True)

        chunks = self._chunks_for(project_id)
        results: list[ScoredChunk] = []
        for similarity, record in scored[:top_k]:
            chunk = chunks.get(record.chunk_id or "")
            if chunk is None:
                continue
            results.append(
                ScoredChunk(
                    chunk_id=chunk.chunk_id,
                    section_id=chunk.section_id,
                    text=chunk.text,
                    similarity=similarity,
                    tokens=chunk.tokens,
                )
            )
        return results

    # -- generations ------------------------------------------------------

    def save_generation(
        self, project_id: str, section_id: str, result: GenerationResult
    ) -> None:
        self._cache.save_generation(project_id, section_id, result)
        current = self._get(config.OS_INDEX_GENERATIONS, project_id)
        bucket = dict(current) if isinstance(current, dict) else {}
        bucket[section_id] = _to_json(result)
        self._put(config.OS_INDEX_GENERATIONS, project_id, bucket)

    def get_generation(self, project_id: str, section_id: str) -> GenerationResult | None:
        data = self._get(config.OS_INDEX_GENERATIONS, project_id)
        if isinstance(data, dict) and section_id in data:
            try:
                return _generation_from_json(data[section_id])
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("opensearch generation deserialize failed: %s", exc)
        return self._cache.get_generation(project_id, section_id)

    # -- evidence ---------------------------------------------------------

    def save_evidence(self, project_id: str, answers: dict[str, str]) -> None:
        self._cache.save_evidence(project_id, answers)
        current = self._get(config.OS_INDEX_EVIDENCE, project_id)
        bucket = dict(current) if isinstance(current, dict) else {}
        bucket.update(answers)
        self._put(config.OS_INDEX_EVIDENCE, project_id, bucket)

    def get_evidence(self, project_id: str) -> dict[str, str]:
        data = self._get(config.OS_INDEX_EVIDENCE, project_id)
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
        return self._cache.get_evidence(project_id)

    # -- style profiles ---------------------------------------------------

    def save_style(self, project_id: str, section_id: str, profile: dict) -> None:
        self._cache.save_style(project_id, section_id, profile)
        current = self._get(config.OS_INDEX_STYLE, project_id)
        bucket = dict(current) if isinstance(current, dict) else {}
        bucket[section_id] = _to_json(profile)
        self._put(config.OS_INDEX_STYLE, project_id, bucket)

    def get_style(self, project_id: str, section_id: str) -> dict | None:
        data = self._get(config.OS_INDEX_STYLE, project_id)
        if isinstance(data, dict) and section_id in data:
            try:
                return _style_from_json(data[section_id])
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("opensearch style deserialize failed: %s", exc)
        return self._cache.get_style(project_id, section_id)

    # -- project lifecycle ------------------------------------------------

    def delete_project(self, project_id: str) -> None:
        self._cache.delete_project(project_id)
        for index in (
            config.OS_INDEX_SECTIONS,
            config.OS_INDEX_CHUNKS,
            config.OS_INDEX_VECTORS,
            config.OS_INDEX_GENERATIONS,
            config.OS_INDEX_EVIDENCE,
            config.OS_INDEX_STYLE,
        ):
            self._redis.delete(f"quill:{index}:{project_id}")
            try:
                self._client.delete(index=index, id=f"proj-{project_id}")
            except Exception as exc:  # noqa: BLE001 — backend must never break us
                logger.warning("opensearch delete %s/%s failed: %s", index, project_id, exc)


# ---------------------------------------------------------------------------
# JsonFileStore — disk-backed StorageService (one JSON file per project)
# ---------------------------------------------------------------------------


class JsonFileStore:
    """StorageService persisted as one JSON file per project.

    Layout: ``<config.PERSIST_DIR>/<project_id>.json`` holds the project's
    buckets — sections, chunks, vectors, generations, evidence, styles —
    serialized with the same JSON helpers as the OpenSearch backend. An
    :class:`InMemoryStore` cache fronts the file (reads hit the cache, saves
    update it and rewrite the file), so a re-opened document finds its prior
    generations and can be rewritten instead of regenerated. Degrades instead
    of raising: an unreadable/corrupt file logs a warning and the store keeps
    serving from cache.
    """

    def __init__(self, directory: str | None = None) -> None:
        self._dir = Path(directory or config.PERSIST_DIR)
        self._cache = InMemoryStore()
        self._loaded: set[str] = set()

    def _path(self, project_id: str) -> Path:
        return self._dir / f"{project_id}.json"

    def _ensure_loaded(self, project_id: str) -> None:
        """Load a project's file into the cache once per id."""
        if project_id in self._loaded:
            return
        self._loaded.add(project_id)
        try:
            data = self._path(project_id).read_text(encoding="utf-8")
            raw = json.loads(data)
        except (OSError, ValueError):
            return
        if not isinstance(raw, dict):
            return
        sections = raw.get("sections")
        if isinstance(sections, list):
            try:
                self._cache.save_sections(
                    project_id, [_section_from_json(s) for s in sections]
                )
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("disk store sections deserialize failed: %s", exc)
        chunks = raw.get("chunks")
        if isinstance(chunks, dict):
            try:
                self._cache.save_chunks(
                    project_id, [_chunk_from_json(c) for c in chunks.values()]
                )
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("disk store chunks deserialize failed: %s", exc)
        vectors = raw.get("vectors")
        if isinstance(vectors, list):
            try:
                self._cache.save_vectors(
                    project_id, [_vector_from_json(v) for v in vectors]
                )
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("disk store vectors deserialize failed: %s", exc)
        generations = raw.get("generations")
        if isinstance(generations, dict):
            try:
                for section_id, item in generations.items():
                    self._cache.save_generation(
                        project_id, str(section_id), _generation_from_json(item)
                    )
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("disk store generation deserialize failed: %s", exc)
        evidence = raw.get("evidence")
        if isinstance(evidence, dict):
            self._cache.save_evidence(
                project_id, {str(k): str(v) for k, v in evidence.items()}
            )
        styles = raw.get("styles")
        if isinstance(styles, dict):
            for section_id, profile in styles.items():
                self._cache.save_style(project_id, str(section_id), _style_from_json(profile))

    def _persist(self, project_id: str) -> None:
        """Write the cache's current project state to its JSON file."""
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "sections": [_to_json(s) for s in self._cache.get_sections(project_id)],
                "chunks": {
                    cid: _to_json(c) for cid, c in self._cache._chunks_for(project_id).items()
                },
                "vectors": [_to_json(v) for v in self._cache._vectors.get(project_id, [])],
                "generations": {
                    section_id: _to_json(g)
                    for section_id, g in self._cache._generations.get(project_id, {}).items()
                },
                "evidence": self._cache.get_evidence(project_id),
                "styles": self._cache._styles.get(project_id, {}),
            }
            tmp = self._path(project_id).with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(self._path(project_id))
        except OSError as exc:
            logger.warning("disk store write %s failed: %s", project_id, exc)

    # -- sections ---------------------------------------------------------

    def save_sections(self, project_id: str, sections: list[Section]) -> None:
        self._ensure_loaded(project_id)
        self._cache.save_sections(project_id, sections)
        self._persist(project_id)

    def get_sections(self, project_id: str) -> list[Section]:
        self._ensure_loaded(project_id)
        return self._cache.get_sections(project_id)

    def get_all_leaves(self, project_id: str) -> list[Section]:
        self._ensure_loaded(project_id)
        return self._cache.get_all_leaves(project_id)

    # -- chunks -----------------------------------------------------------

    def save_chunks(self, project_id: str, chunks: list[Chunk]) -> None:
        self._ensure_loaded(project_id)
        self._cache.save_chunks(project_id, chunks)
        self._persist(project_id)

    # -- vectors ----------------------------------------------------------

    def save_vectors(self, project_id: str, records: list[VectorRecord]) -> None:
        self._ensure_loaded(project_id)
        self._cache.save_vectors(project_id, records)
        self._persist(project_id)

    def get_header_embedding(self, project_id: str, section_id: str) -> list[float] | None:
        self._ensure_loaded(project_id)
        return self._cache.get_header_embedding(project_id, section_id)

    def search_vectors(
        self,
        project_id: str,
        query_embedding: list[float],
        *,
        section_ids: list[str],
        top_k: int,
    ) -> list[ScoredChunk]:
        self._ensure_loaded(project_id)
        return self._cache.search_vectors(
            project_id, query_embedding, section_ids=section_ids, top_k=top_k
        )

    # -- generations ------------------------------------------------------

    def save_generation(
        self, project_id: str, section_id: str, result: GenerationResult
    ) -> None:
        self._ensure_loaded(project_id)
        self._cache.save_generation(project_id, section_id, result)
        self._persist(project_id)

    def get_generation(self, project_id: str, section_id: str) -> GenerationResult | None:
        self._ensure_loaded(project_id)
        return self._cache.get_generation(project_id, section_id)

    # -- evidence ---------------------------------------------------------

    def save_evidence(self, project_id: str, answers: dict[str, str]) -> None:
        self._ensure_loaded(project_id)
        self._cache.save_evidence(project_id, answers)
        self._persist(project_id)

    def get_evidence(self, project_id: str) -> dict[str, str]:
        self._ensure_loaded(project_id)
        return self._cache.get_evidence(project_id)

    # -- style profiles ---------------------------------------------------

    def save_style(self, project_id: str, section_id: str, profile: dict) -> None:
        self._ensure_loaded(project_id)
        self._cache.save_style(project_id, section_id, profile)
        self._persist(project_id)

    def get_style(self, project_id: str, section_id: str) -> dict | None:
        self._ensure_loaded(project_id)
        return self._cache.get_style(project_id, section_id)

    # -- project lifecycle ------------------------------------------------

    def delete_project(self, project_id: str) -> None:
        self._loaded.discard(project_id)
        self._cache.delete_project(project_id)
        try:
            self._path(project_id).unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("disk store delete %s failed: %s", project_id, exc)


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def new_store() -> StorageService:
    """Storage backend factory honoring ``config.STORE_BACKEND``.

    ``"disk"`` returns a :class:`JsonFileStore` (persistent, no external
    dependency); ``"opensearch"`` attempts a live OpenSearch connection
    (using ``config.OPEN_SEARCH_URL``); on any failure it logs and falls
    back to :class:`InMemoryStore`. Any other value returns
    :class:`InMemoryStore`.
    """
    if config.STORE_BACKEND == "disk":
        return JsonFileStore()
    if config.STORE_BACKEND != "opensearch":
        return InMemoryStore()

    url = config.OPEN_SEARCH_URL
    if not url:
        logger.warning("STORE_BACKEND=opensearch but OPEN_SEARCH_URL is empty; using InMemoryStore")
        return InMemoryStore()

    try:
        from opensearchpy import OpenSearch

        client = OpenSearch(
            [url],
            http_auth=(config.OPEN_SEARCH_USER, config.OPEN_SEARCH_PASSWORD),
            use_ssl=url.startswith("https://"),
            verify_certs=False,  # Aiven cert pinning handled by caller if needed
            timeout=10,
            max_retries=1,
            retry_on_timeout=False,
        )
        if not client.ping():
            raise ConnectionError("opensearch ping failed")
        logger.info("storage backend: opensearch @ %s", url)
        return OpenSearchStore(client)
    except Exception as exc:  # noqa: BLE001 — backend must never break the run
        logger.warning("opensearch connection failed (%s); using InMemoryStore", exc)
        return InMemoryStore()
