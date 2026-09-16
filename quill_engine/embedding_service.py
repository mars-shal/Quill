"""Service 4 — EmbeddingService: chunks -> vector records + persistence.

Port of the former lazy ``_get_embedder``/``_embed`` helpers from
``main.py``, adding batching, retry, and persistence per
``.agent/agent.md`` §4.
"""

from __future__ import annotations

import logging
import time

from . import config
from .models import (
    Chunk,
    Section,
    VectorRecord,
    new_vector_record,
    walk_sections,
)

logger = logging.getLogger(__name__)

_embedder: "SentenceTransformer | None" = None  # noqa: F821 — lazy import
_embedder_device: str = config.EMBEDDING_DEVICE


def _get_embedder():
    """Lazily load the sentence-transformer model (downloads on first use).

    Import is deferred to first use so ``import quill_engine`` never pays
    the multi-second torch startup. Cache-first: the model is loaded with
    ``local_files_only=True`` so a cached model never needs the network —
    sentence-transformers otherwise pings huggingface.co on every load
    even when the files are present, and a flaky connection there raises
    ``urllib3.exceptions.ProtocolError`` out of ``ingest()``, killing the
    whole run. Only when the model is not in the cache do we fall back to
    a network download.
    """
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer

        device = None if _embedder_device == "auto" else _embedder_device
        try:
            _embedder = SentenceTransformer(
                config.EMBEDDING_MODEL, device=device, local_files_only=True
            )
        except Exception:
            logger.info("embedding model not in cache; downloading %s", config.EMBEDDING_MODEL)
            _embedder = SentenceTransformer(config.EMBEDDING_MODEL, device=device)
    return _embedder


def _embed(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    embedder = _get_embedder()
    try:
        vectors = embedder.encode(texts, normalize_embeddings=True)
    except Exception as exc:
        # CUDA kernel launch failure — the CUDA context is already poisoned,
        # so moving the same model to CPU fails too. Reload a fresh CPU-only
        # model and retry once; pin the device so later calls skip CUDA.
        if "cuda" in str(exc).lower() or "cuda_error" in str(exc):
            logger.warning("embedding CUDA error, reloading on CPU: %s", exc)
            return _embed_on_cpu(texts)
        raise
    return [v.tolist() for v in vectors]


def _embed_on_cpu(texts: list[str]) -> list[list[float]]:
    """Reload the embedder fresh on CPU (the CUDA context is unrecoverable)."""
    global _embedder, _embedder_device
    _embedder = None
    _embedder_device = "cpu"
    embedder = _get_embedder()
    vectors = embedder.encode(texts, normalize_embeddings=True)
    return [v.tolist() for v in vectors]


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed arbitrary texts (used by RetrievalService for query fallback)."""
    return _embed(texts)


def _batched(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _embed_with_retry(texts: list[str]) -> list[list[float]]:
    """Batch + retry on provider failure (3 attempts, exponential backoff)."""
    out: list[list[float]] = []
    for batch in _batched(texts, config.EMBED_BATCH_SIZE):
        for attempt in range(1, config.EMBED_MAX_RETRIES + 1):
            try:
                out.extend(_embed(batch))
                break
            except Exception as exc:
                if attempt == config.EMBED_MAX_RETRIES:
                    raise
                logger.warning(
                    "embedding batch failed (attempt %d/%d): %s",
                    attempt,
                    config.EMBED_MAX_RETRIES,
                    exc,
                )
                time.sleep(2**attempt)
    return out


def embed_chunks(chunks: list[Chunk]) -> list[VectorRecord]:
    """Embed chunk texts into ``kind="chunk"`` vector records."""
    if not chunks:
        return []
    embeddings = _embed_with_retry([c.text for c in chunks])
    return [
        new_vector_record(
            section_id=chunk.section_id,
            embedding=emb,
            model=config.EMBEDDING_MODEL,
            dim=config.EMBEDDING_DIM,
            chunk_id=chunk.chunk_id,
            kind="chunk",
        )
        for chunk, emb in zip(chunks, embeddings)
    ]


def embed_section_headers(sections: list[Section]) -> list[VectorRecord]:
    """Embed every section title into ``kind="header"`` query vectors."""
    all_sections = walk_sections(sections)
    if not all_sections:
        return []
    embeddings = _embed_with_retry([s.title for s in all_sections])
    return [
        new_vector_record(
            section_id=section.section_id,
            embedding=emb,
            model=config.EMBEDDING_MODEL,
            dim=config.EMBEDDING_DIM,
            kind="header",
        )
        for section, emb in zip(all_sections, embeddings)
    ]
