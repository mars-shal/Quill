"""Service — RelationService: section-vs-siblings relatedness check.

The relation layer takes a section and the document's section list and
answers one question: how similar is this section to its siblings? Sibling
sections whose header embeddings score at or above
``config.RELATION_MIN_SIMILARITY`` are returned ranked by cosine
similarity, so retrieval can pull their summaries into the prompt. That
keeps the writer from producing sections that drift off-topic, and the
related titles double as grounding for web/knowledge research queries
("everything the research pulls must be connected to the section").

Never raises: a missing embedding, an unknown section, or an empty tree
all yield an empty result, so the relation layer can never break a run.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import config
from .models import Section, find_section, walk_sections
from .storage import StorageService, cosine_similarity


@dataclass
class RelationResult:
    """One sibling section scored for relatedness to the target section."""

    section_id: str
    title: str
    score: float


def rank_related(
    project_id: str,
    section_id: str,
    store: StorageService,
    *,
    limit: int | None = None,
) -> list[RelationResult]:
    """Sibling sections most related to ``section_id`` (never raises).

    Compares the section's stored header embedding against every other
    section in the document, keeps siblings at or above
    ``config.RELATION_MIN_SIMILARITY``, sorts by score descending, and
    caps the result at ``config.RELATION_TOP_K``.
    """
    limit = config.RELATION_TOP_K if limit is None else limit
    if limit <= 0:
        return []
    try:
        sections = store.get_sections(project_id)
        target = find_section(sections, section_id)
        if target is None:
            return []
        target_vec = store.get_header_embedding(project_id, section_id)
        if not target_vec:
            return []
        scored: list[RelationResult] = []
        for sibling in walk_sections(sections):
            if sibling.section_id == section_id:
                continue
            vec = store.get_header_embedding(project_id, sibling.section_id)
            if not vec:
                continue
            score = cosine_similarity(target_vec, vec)
            if score >= config.RELATION_MIN_SIMILARITY:
                scored.append(
                    RelationResult(sibling.section_id, sibling.title, score)
                )
        scored.sort(key=lambda r: r.score, reverse=True)
        return scored[:limit]
    except Exception:
        return []


def summarize(section: Section, *, limit: int = 240) -> str:
    """Short plain-text summary of a section (description + content)."""
    parts = [section.description] if section.description else []
    parts.extend(unit.text for unit in section.content)
    text = " ".join(p for p in parts if p).strip()
    return text[:limit]
