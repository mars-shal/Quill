"""Storage abstraction for quill_engine.

Services never hold state or reach into each other — everything goes
through a ``StorageService``. The MVP ships ``InMemoryStore``; a
pgvector-backed store (Postgres 16 + SQLAlchemy 2.0, per
``.agent/master.md``) implements the same protocol later.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Protocol

from .models import (
    Chunk,
    GenerationResult,
    ScoredChunk,
    Section,
    VectorRecord,
)


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length vectors."""
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


class StorageService(Protocol):
    """Contract every service depends on (swap in-memory <-> pgvector)."""

    def save_sections(self, project_id: str, sections: list[Section]) -> None: ...

    def save_chunks(self, project_id: str, chunks: list[Chunk]) -> None: ...

    def save_vectors(self, project_id: str, records: list[VectorRecord]) -> None: ...

    def get_sections(self, project_id: str) -> list[Section]: ...

    def get_all_leaves(self, project_id: str) -> list[Section]: ...

    def get_header_embedding(self, project_id: str, section_id: str) -> list[float] | None: ...

    def search_vectors(
        self,
        project_id: str,
        query_embedding: list[float],
        *,
        section_ids: list[str],
        top_k: int,
    ) -> list[ScoredChunk]: ...

    def save_generation(
        self, project_id: str, section_id: str, result: GenerationResult
    ) -> None: ...

    def get_generation(self, project_id: str, section_id: str) -> GenerationResult | None: ...

    def save_evidence(self, project_id: str, answers: dict[str, str]) -> None: ...

    def get_evidence(self, project_id: str) -> dict[str, str]: ...

    def save_style(self, project_id: str, section_id: str, profile: dict) -> None: ...

    def get_style(self, project_id: str, section_id: str) -> dict | None: ...

    def delete_project(self, project_id: str) -> None: ...


@dataclass
class InMemoryStore:
    """Dict-backed implementation of :class:`StorageService` (MVP)."""

    _sections: dict[str, list[Section]] = field(default_factory=dict)
    _chunks: dict[str, dict[str, Chunk]] = field(default_factory=dict)
    _vectors: dict[str, list[VectorRecord]] = field(default_factory=dict)
    _generations: dict[str, dict[str, GenerationResult]] = field(default_factory=dict)
    _evidence: dict[str, dict[str, str]] = field(default_factory=dict)
    _styles: dict[str, dict[str, dict]] = field(default_factory=dict)

    # -- sections ---------------------------------------------------------

    def save_sections(self, project_id: str, sections: list[Section]) -> None:
        self._sections[project_id] = sections

    def get_sections(self, project_id: str) -> list[Section]:
        return self._sections.get(project_id, [])

    def get_all_leaves(self, project_id: str) -> list[Section]:
        leaves: list[Section] = []
        for section in self.get_sections(project_id):
            leaves.extend(section.leaves())
        return leaves

    # -- chunks -----------------------------------------------------------

    def save_chunks(self, project_id: str, chunks: list[Chunk]) -> None:
        for chunk in chunks:
            self._chunks.setdefault(project_id, {})[chunk.chunk_id] = chunk

    def _chunks_for(self, project_id: str) -> dict[str, Chunk]:
        return self._chunks.setdefault(project_id, {})

    # -- vectors ----------------------------------------------------------

    def save_vectors(self, project_id: str, records: list[VectorRecord]) -> None:
        self._vectors.setdefault(project_id, []).extend(records)

    def get_header_embedding(self, project_id: str, section_id: str) -> list[float] | None:
        for record in self._vectors.get(project_id, []):
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
        """Cosine rank over chunk vectors restricted to ``section_ids``.

        Scores are resolved against stored chunk text so downstream
        services never touch raw vector internals.
        """
        allowed = set(section_ids)
        scored: list[tuple[float, VectorRecord]] = []
        for record in self._vectors.get(project_id, []):
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
        self._generations.setdefault(project_id, {})[section_id] = result

    def get_generation(self, project_id: str, section_id: str) -> GenerationResult | None:
        return self._generations.get(project_id, {}).get(section_id)

    # -- evidence ---------------------------------------------------------

    def save_evidence(self, project_id: str, answers: dict[str, str]) -> None:
        self._evidence.setdefault(project_id, {}).update(answers)

    def get_evidence(self, project_id: str) -> dict[str, str]:
        return dict(self._evidence.get(project_id, {}))

    # -- style profiles ---------------------------------------------------

    def save_style(self, project_id: str, section_id: str, profile: dict) -> None:
        self._styles.setdefault(project_id, {})[section_id] = profile

    def get_style(self, project_id: str, section_id: str) -> dict | None:
        return self._styles.get(project_id, {}).get(section_id)

    # -- project lifecycle ------------------------------------------------

    def delete_project(self, project_id: str) -> None:
        self._sections.pop(project_id, None)
        self._chunks.pop(project_id, None)
        self._vectors.pop(project_id, None)
        self._generations.pop(project_id, None)
        self._evidence.pop(project_id, None)
        self._styles.pop(project_id, None)
