"""Rewrite cascade: after a section rewrite, align similar sections.

Embedding the newly rewritten text and comparing it against the stored chunk
vectors of every other section finds places that talk about the same thing.
Each match is rewritten with the source text attached as a *reference* — an
alignment standard for facts, terminology, and tone — never as text to copy.
Gated by ``config.REWRITE_CASCADE_ENABLED`` and bounded by
``config.REWRITE_CASCADE_MAX``.
"""

from __future__ import annotations

from collections.abc import Callable

from . import config
from . import embedding_service
from . import md_rewriter
from .models import GenerationResult, Section, walk_sections
from .storage import StorageService

#: Rewrite instruction for cascaded sections: keep this section's own content
#: and wording, but match the reference's facts, terminology, and tone.
ALIGN_INSTRUCTION = (
    "Align this section with the reference section below: match its facts, "
    "terminology, and tone, but keep this section's own content, structure, "
    "and wording. Do not copy the reference text."
)


def find_similar_sections(
    project_id: str,
    store: StorageService,
    source_text: str,
    *,
    exclude_section_id: str,
    skip: set[str] | None = None,
    limit: int | None = None,
    min_similarity: float | None = None,
) -> list[tuple[str, str, float]]:
    """Rank sections by how similar their stored chunk vectors are to ``source_text``.

    Embeds ``source_text`` and scores each other section by its best-matching
    chunk (``search_vectors(..., top_k=1)``). Returns ``(section_id, title,
    similarity)`` triples at or above the threshold, best first, capped at
    ``REWRITE_CASCADE_MAX``. The source section itself and any id in ``skip``
    are never returned.
    """
    if not source_text:
        return []
    if limit is None:
        limit = config.REWRITE_CASCADE_MAX
    if min_similarity is None:
        min_similarity = config.REWRITE_CASCADE_SIMILARITY
    query = embedding_service.embed_texts([source_text])[0]
    candidates: list[tuple[str, str, float]] = []
    for section in walk_sections(store.get_sections(project_id)):
        if section.section_id == exclude_section_id:
            continue
        if skip is not None and section.section_id in skip:
            continue
        best = store.search_vectors(
            project_id, query, section_ids=[section.section_id], top_k=1
        )
        if not best:
            continue
        score = best[0].similarity
        if score >= min_similarity:
            candidates.append((section.section_id, section.title, score))
    candidates.sort(key=lambda item: item[2], reverse=True)
    return candidates[:limit]


def cascade_rewrite(
    project_id: str,
    store: StorageService,
    source_section_id: str,
    source_text: str,
    *,
    source_title: str = "",
    cancel: Callable[[], bool] | None = None,
    skip: set[str] | None = None,
) -> dict[str, GenerationResult]:
    """Rewrite sections similar to ``source_text`` so they align with it.

    Returns ``{section_id: GenerationResult}`` for every cascaded rewrite.
    Returns an empty dict when the cascade is disabled or nothing matches.
    Each match gets ``ALIGN_INSTRUCTION`` with the source text as a reference
    (alignment standard, not copy source). Ids in ``skip`` (e.g. sections the
    caller is already rewriting) are excluded from matching.
    """
    if not config.REWRITE_CASCADE_ENABLED:
        return {}
    matches = find_similar_sections(
        project_id,
        store,
        source_text,
        exclude_section_id=source_section_id,
        skip=skip,
    )
    results: dict[str, GenerationResult] = {}
    for section_id, _title, _score in matches:
        if cancel is not None and cancel():
            break
        result = md_rewriter.rewrite_section(
            project_id,
            section_id,
            store,
            instruction=ALIGN_INSTRUCTION,
            references=[(source_title or source_section_id, source_text)],
            cancel=cancel,
        )
        results[section_id] = result
    return results
