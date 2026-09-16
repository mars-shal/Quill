"""Service 5 — RetrievalService: task instruction -> ranked evidence.

Each section/subsection is generated against its own content: the task
instruction (the user's prompt or the section title) is embedded and ranked
against the section's chunks, padded from neighboring sections when thin,
then trimmed to the token budget (``.agent/agent.md`` §5).
"""

from __future__ import annotations

from . import cleaner, config, embedding_service, memory_service, relation_service, requirement_service, search_service, style_service
from .models import (
    EvidencePacket,
    ScoredChunk,
    Section,
    SourceRef,
    find_section,
    walk_sections,
)
from .relation_service import RelationResult
from .storage import StorageService


def _estimate_target_words(section: Section) -> int:
    """Target length: use the template's parsed word count when available."""
    if section.word_count > 0:
        return max(config.MIN_SECTION_WORDS, section.word_count)
    words = sum(len(unit.text.split()) for unit in section.content)
    for child in section.children:
        words += sum(len(unit.text.split()) for unit in child.content)
    return max(config.MIN_SECTION_WORDS, words)


def _trim_to_budget(scored: list[ScoredChunk], budget: int) -> list[ScoredChunk]:
    """Trim ranked chunks until cumulative tokens fit ``budget``."""
    kept: list[ScoredChunk] = []
    used = 0
    for chunk in scored:
        if kept and used + chunk.tokens > budget:
            break
        kept.append(chunk)
        used += chunk.tokens
    return kept


def _phrase_repeats(tokens: list[str], i: int) -> bool:
    """True when the same 2-word phrase starts again at index ``i+2``."""
    return (
        i + 3 < len(tokens)
        and tokens[i].lower() == tokens[i + 2].lower()
        and tokens[i + 1].lower() == tokens[i + 3].lower()
    )


def _dedupe_tokens(text: str) -> str:
    """Collapse repeated words and phrases ("CHAPTER TWO CHAPTER TWO CHAPTER ONE")."""
    tokens = text.split()
    out: list[str] = []
    i = 0
    while i < len(tokens):
        if out and tokens[i].lower() == out[-1].lower():
            i += 1
            continue
        if _phrase_repeats(tokens, i):
            out.extend([tokens[i], tokens[i + 1]])
            i = _skip_repeats(tokens, i)
            continue
        out.append(tokens[i])
        i += 1
    return " ".join(out)


def _skip_repeats(tokens: list[str], i: int) -> int:
    """Advance past every copy of the 2-word phrase starting at ``i``."""
    j = i + 2
    while (
        j + 1 < len(tokens)
        and tokens[j].lower() == tokens[i].lower()
        and tokens[j + 1].lower() == tokens[i + 1].lower()
    ):
        j += 2
    return j


def _clean_web_query(parts: list[str]) -> str:
    """Join query fragments, dedupe repeated tokens, cap length."""
    return _dedupe_tokens(" ".join(p for p in parts if p)).strip()[:200]


def _web_supplement(
    section: Section,
    missing: list[str],
    related: list[str],
    *,
    report_topic: str = "",
) -> list[ScoredChunk]:
    """Search the web for domain facts to enrich the section evidence.

    Runs for every non-personal section by default (``config.WEB_SUPPLEMENT_ALL``),
    or only for sections whose own evidence cannot cover their required
    fields when it is disabled. Personal records (week logs, activities)
    are never supplemented — unless ``config.STRUCTURE_ONLY_WEB_ALL`` is set
    (structure-only mode), in which case the search is scoped to the
    section's own title and missing fields so personal sections still get
    background to write against (never the raw task prompt). Results are
    tagged non-authoritative.

    The query is built from the section title plus the report topic (when
    known) so the search targets the subject actually being written about,
    not boilerplate like "definition background".
    """
    title = section.title.lower()
    personal = any(k in title for k in ("week", "log", "abstract", "conclusion", "challenge"))
    if personal and not config.STRUCTURE_ONLY_WEB_ALL:
        return []
    if not missing and not config.WEB_SUPPLEMENT_ALL:
        return []
    related_clean = [r for r in related if r][:3]
    query_text = _clean_web_query(
        [
            report_topic or section.title,
            section.title if report_topic else "",
            " ".join(missing),
            "related: " + " ".join(related_clean) if related_clean else "",
        ]
    )
    chunks: list[ScoredChunk] = []
    for result in search_service.search(query_text):
        text = result.markdown.strip()
        if config.CLEAN_EVIDENCE:
            text = cleaner.clean(text)
        if not text:
            continue
        tokens = max(1, len(text.split()))
        chunks.append(
            ScoredChunk(
                chunk_id=f"web_{result.url[:40]}",
                section_id=section.section_id,
                text=f"[WEB - {result.title} ({result.url}) - background only]\n{text[:800]}",
                similarity=0.0,
                tokens=tokens,
                source_type="web",
                source_title=result.title,
                source_url=result.url,
            )
        )
        if len(chunks) >= 3:
            break
    return chunks


def _graph_supplement(
    project_id: str, query: str, related: list[str]
) -> list[ScoredChunk]:
    """Pull researched facts from the knowledge-graph memory (feature 6).

    Returns the memory notes most relevant to ``query`` as tagged chunks so
    the writing engine can draw on previously researched areas. Scoped to
    ``project_id`` so research from one report never leaks into another.
    Never raises; empty when memory is disabled or nothing matches.
    """
    if not config.RESEARCH_ENABLED:
        return []
    try:
        notes = memory_service.search_notes(query, project_id=project_id)
    except Exception:
        return []
    chunks: list[ScoredChunk] = []
    for note in notes:
        text = note.content.strip()
        if config.CLEAN_EVIDENCE:
            text = cleaner.clean(text)
        if not text:
            continue
        tokens = max(1, len(text.split()))
        chunks.append(
            ScoredChunk(
                chunk_id="memory_graph",
                section_id="",
                text=f"[RESEARCH - from knowledge-graph memory - background only]\n{text[:1200]}",
                similarity=0.0,
                tokens=tokens,
                source_type="memory",
                source_title=note.title,
                source_url=note.source_url or "",
            )
        )
        if len(chunks) >= 3:
            break
    return chunks


def _relation_supplement(
    project_id: str,
    source: Section,
    store: StorageService,
    related: list[RelationResult],
) -> list[ScoredChunk]:
    """Add the most related sibling sections as background (feature 8).

    Ranked by header-embedding similarity against every other section in
    the project; the top matches become short context chunks so the
    writing engine can keep tone and claims consistent across the report.
    """
    if not related:
        return []
    chunks: list[ScoredChunk] = []
    for rel in related:
        section = find_section(store.get_sections(project_id), rel.section_id)
        if section is None:
            continue
        body = relation_service.summarize(section)
        if not body:
            continue
        tokens = max(1, len(body.split()))
        chunks.append(
            ScoredChunk(
                chunk_id=f"relation_{rel.section_id[:40]}",
                section_id="",
                text=f"[RELATED: {rel.title}]\n{body}",
                similarity=rel.score,
                tokens=tokens,
                source_type="relation",
                source_title=rel.title,
                source_url="",
            )
        )
    return chunks


def collect_sources(packet: EvidencePacket) -> list[SourceRef]:
    """Provenance for each chunk the generation engine actually received.

    Ordered by position in the packet so the first-cited sources are the
    highest-ranked evidence; deduplicated by (title, url) and capped to
    the number of chunks actually supplied.
    """
    sources: list[SourceRef] = []
    seen: set[tuple[str, str]] = set()
    for chunk in packet.chunks:
        if not chunk.source_type:
            continue
        key = (chunk.source_title, chunk.source_url)
        if key in seen:
            continue
        seen.add(key)
        sources.append(
            SourceRef(
                title=chunk.source_title,
                url=chunk.source_url,
                kind=chunk.source_type,
            )
        )
    return sources


# Fallback when the section carries no analyzable text (structure-only
# ingestion drops the template body): the deterministic analyzer returns
# {}, so the writer would otherwise get an empty style profile.
_DEFAULT_STYLE_PROFILE = {
    "tone": "formal academic",
    "register": "formal",
    "tense": "past",
    "avg_sentence_words": 20,
    "first_person_signals": 0,
}


def _user_notes(answers: dict[str, str]) -> str:
    """Render the user's answered evidence fields as one readable block."""
    lines = []
    for field, value in sorted(answers.items()):
        value = value.strip()
        if not value:
            continue
        label = requirement_service.FIELD_LABELS.get(
            field, field.replace("_", " ").capitalize()
        )
        lines.append(f"- {label} {value}")
    return "\n".join(lines)


def retrieve(
    project_id: str,
    query: str,
    store: StorageService,
    *,
    section_id: str,
    top_k: int = config.RETRIEVAL_TOP_K,
    references: list[tuple[str, str]] = (),
) -> EvidencePacket:
    """Return section-scoped evidence relevant to ``query`` (read-only).

    The query is embedded and ranked against the section's own leaves,
    padded from neighboring sections when thin, then trimmed to budget.
    ``references`` are ``(label, text)`` pairs attached from the prompt's
    ``@``-mentions; they are appended as always-relevant evidence.
    """
    sections = store.get_sections(project_id)
    source = find_section(sections, section_id)
    if source is None:
        raise ValueError(f"unknown section: {section_id}")

    query_embedding = embedding_service.embed_texts([query])[0]
    target_ids = [leaf.section_id for leaf in source.leaves()]
    results = store.search_vectors(
        project_id, query_embedding, section_ids=target_ids, top_k=top_k
    )

    # Pad from neighboring sections (same project) when the section is thin.
    if len(results) < top_k:
        neighbor_ids = [
            s.section_id
            for s in walk_sections(sections)
            if s.section_id not in target_ids
        ]
        seen = {c.chunk_id for c in results}
        if neighbor_ids:
            neighbors = store.search_vectors(
                project_id, query_embedding, section_ids=neighbor_ids, top_k=top_k
            )
            for neighbor in neighbors:
                if neighbor.chunk_id in seen:
                    continue
                results.append(neighbor)
                seen.add(neighbor.chunk_id)
                if len(results) >= top_k:
                    break

    results = _trim_to_budget(results, config.TARGET_CONTEXT_TOKENS)

    titles = {s.section_id: s.title for s in walk_sections(sections)}
    for chunk in results:
        if not chunk.source_type:
            chunk.source_type = "source"
            chunk.source_title = titles.get(chunk.section_id, "source report")

    answers = store.get_evidence(project_id)
    reqs = requirement_service.build_requirements(source, answers=answers)
    missing = requirement_service.missing_fields(reqs)

    related: list[RelationResult] = []
    if config.RELATION_ENABLED:
        related = relation_service.rank_related(project_id, source.section_id, store)
    related_titles = [r.title for r in related]

    results.extend(_web_supplement(source, missing, related_titles, report_topic=query))
    results.extend(_graph_supplement(project_id, query, related_titles))
    results.extend(_relation_supplement(project_id, source, store, related))

    # @-mentioned files: always relevant, never trimmed away.
    for label, text in references:
        if not text.strip():
            continue
        results.append(
            ScoredChunk(
                chunk_id=f"ref-{label}",
                section_id=source.section_id,
                text=text,
                similarity=1.0,
                tokens=len(text.split()),
                source_type="reference",
                source_title=label,
            )
        )

    # Recompute requirements against the full evidence (research/graph
    # supplements included) so structure-only sections pass the gate on
    # research instead of being flagged as fully missing.
    evidence = "\n".join(
        c.text for c in results if c.source_type in ("web", "memory")
    )
    reqs = requirement_service.build_requirements(
        source, answers=answers, evidence=evidence
    )
    missing = requirement_service.missing_fields(reqs)

    return EvidencePacket(
        section_id=source.section_id,
        section_title=source.title,
        target_words=_estimate_target_words(source),
        style_profile=style_service.profile_for(project_id, source, store)
        or dict(_DEFAULT_STYLE_PROFILE),
        chunks=results,
        query=query,
        missing_fields=missing,
        user_notes=_user_notes(answers),
        section_summaries=[
            (s.title, s.summary)
            for s in walk_sections(sections)
            if s.summary.strip()
        ],
    )
