"""Service 9 — Orchestrator: coordinates all services.

Generates a corrected write-up for every section and subsection of the
source document: each node of the reference tree is retrieved (section-
scoped evidence), prompted with the user's task instruction, and generated
in document order. Failure recovery is per section: failures are persisted
with ``status="failed"`` (partial text kept) so ``run`` retries them
without regenerating completed sections (``.agent/agent.md`` §9).
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Callable

from . import (
    cascade_service,
    chunking_service,
    config,
    context_builder,
    document_processor,
    embedding_service,
    md_rewriter,
    memory_service,
    providers,
    questionnaire,
    requirement_service,
    research_planner,
    retrieval_service,
    search_service,
    section_parser,
    validation_service,
    writing_service,
)
from .models import (
    EvidencePacket,
    EvidenceRequirement,
    GenerationResult,
    MergeResult,
    ResearchNote,
    Section,
    SourceRef,
    Warning,
    count_words,
    find_section,
    new_vector_record,
    remove_section,
    renumber_orders,
    summarize_sections,
    walk_sections,
)
from .storage import StorageService, cosine_similarity

logger = logging.getLogger(__name__)

StreamFn = Callable[[str, str], None]

# Invoked by run() as sections resolve: (section_id, status, done_ratio).
ProgressFn = Callable[[str, str, float], None]

# Polled before each section; returning True stops the run with partial results.
CancelFn = Callable[[], bool]


def _delta_for(section_id: str, on_delta: StreamFn | None) -> Callable[[str], None] | None:
    """Bind a section id onto ``on_delta`` (``None``-safe passthrough)."""
    if on_delta is None:
        return None
    return lambda delta_text: on_delta(section_id, delta_text)


def _project_id_for(file_path: str) -> str:
    """Deterministic project id from the source file path.

    The same file always maps to the same project, so a re-opened document
    finds its persisted sections and generations (see ``JsonFileStore``)
    and can be rewritten instead of regenerated.
    """
    resolved = os.path.abspath(os.path.expanduser(file_path))
    digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:16]
    return f"proj_{digest}"


def ingest(
    file_path: str,
    store: StorageService,
    *,
    project_id: str | None = None,
    embed: bool = True,
    structure_only: bool | None = None,
) -> str:
    """Parse, chunk, and embed a source document into ``store``.

    Returns the ``project_id`` (generated when not provided). With
    ``embed=False`` the pipeline stops after chunking (useful for a
    quick structural run). With ``structure_only`` (default: the
    ``config.STRUCTURE_ONLY`` flag) the template's body is dropped —
    headings, levels, and order are kept but its prose never becomes
    evidence — and only header embeddings are stored, so the tree is
    the template and the content comes from research, the knowledge
    graph, and the user's answers.
    """
    project_id = project_id or _project_id_for(file_path)
    structure_only = config.STRUCTURE_ONLY if structure_only is None else structure_only

    doc = document_processor.process(file_path)
    sections = section_parser.parse(doc.markdown_text, include_content=not structure_only)
    summarize_sections(sections)
    chunks = chunking_service.chunk(sections)

    store.save_sections(project_id, sections)
    store.save_chunks(project_id, chunks)

    if embed:
        records = embedding_service.embed_section_headers(sections)
        if not structure_only:
            records += embedding_service.embed_chunks(chunks)
        store.save_vectors(project_id, records)

    logger.info(
        "ingested %s -> project %s (%d sections, %d chunks)",
        file_path,
        project_id,
        len(sections),
        len(chunks),
    )
    return project_id


def _section_gate(
    section: Section,
    answers: dict[str, str],
    *,
    evidence: str = "",
) -> tuple[list[EvidenceRequirement], list[str], float]:
    """Coverage-gate inputs for one section (evidence-aware in structure-only mode).

    ``evidence`` (research/knowledge-graph text) counts toward lenient
    fields only — see :func:`requirement_service.build_requirements`.
    """
    reqs = requirement_service.build_requirements(
        section, answers=answers, evidence=evidence
    )
    return reqs, requirement_service.missing_fields(reqs), requirement_service.coverage(reqs)


def _post_process_sections(
    project_id: str,
    sections: list,
    store: StorageService,
) -> None:
    """Auto-rename duplicate titles and sort children by order field."""
    for section in sections:
        if section.children:
            _post_process_sections(project_id, section.children, store)

    titles_seen: dict[str, int] = {}
    changed = False
    for section in sections:
        key = section.title.strip().lower()
        if key in titles_seen:
            titles_seen[key] += 1
            section.title = f"{section.title} ({titles_seen[key]})"
            changed = True
        else:
            titles_seen[key] = 1

    sections.sort(key=lambda s: s.order)

    if changed:
        store.save_sections(project_id, sections)


def run(
    project_id: str,
    store: StorageService,
    *,
    prompt: str = "",
    stream: StreamFn | None = None,
    interactive: bool = False,
    progress_cb: ProgressFn | None = None,
    cancel: CancelFn | None = None,
    references: list[tuple[str, str]] = (),
    on_delta: StreamFn | None = None,
) -> dict[str, GenerationResult]:
    """Generate every section and subsection, in document order.

    The task instruction (``prompt``) is threaded into each generation via
    the retrieval query; each section's own content is the evidence it is
    corrected against. Idempotent: sections persisted with
    ``status="generated"`` are skipped; failed sections are retried.

    When the research phase is enabled (``config.RESEARCH_ENABLED``) it
    runs before generation: Query Curator -> web search (region + angle
    variants) + prompt-supplied links -> knowledge-graph memory. The graph
    context is then pulled into retrieval (see
    :func:`retrieval_service.retrieve`).

    Evidence gate: when a section's required fields are not covered by the
    source (below ``EVIDENCE_MIN_COVERAGE``) it is written as ``blocked``
    and never sent to the LLM — with ``interactive=True`` the questionnaire
    prompts for the missing fields first. In structure-only mode
    (``config.STRUCTURE_ONLY``) retrieval runs before the gate so research
    and knowledge-graph text counts toward coverage (lenient fields only),
    and the same packet is passed to generation to avoid re-retrieving.
    ``stream`` is invoked with
    ``(section_id, text)`` after each success. ``progress_cb`` (when given)
    is invoked with ``(section_id, status, done_ratio)`` after every section
    is resolved, with ``section_id=""`` for the research phase. ``cancel``
    (when given) is polled before each section (and before the research
    phase); when it returns ``True`` the run stops and the results gathered
    so far are returned. ``references`` are ``(label, text)`` pairs from the
    prompt's ``@``-mentions, attached as always-relevant evidence.
    ``on_delta`` (when given) is invoked with ``(section_id, delta_text)``
    for every raw stream fragment produced while a section is generated.
    """
    sections = store.get_sections(project_id)
    results: dict[str, GenerationResult] = {}
    answers = store.get_evidence(project_id)
    total = max(1, len(list(walk_sections(sections))))
    done = 0

    if cancel is not None and cancel():
        return results
    if config.RESEARCH_ENABLED and prompt:
        if progress_cb is not None:
            progress_cb("", "research", 0.0)
        research(project_id, prompt=prompt, progress_cb=progress_cb)

    for section in walk_sections(sections):
        if cancel is not None and cancel():
            break
        existing = store.get_generation(project_id, section.section_id)
        if existing is not None and existing.status == "generated":
            results[section.section_id] = existing
            done += 1
            if progress_cb is not None:
                progress_cb(section.section_id, "skipped", done / total)
            continue

        packet = None
        evidence = ""
        if config.STRUCTURE_ONLY:
            packet = retrieval_service.retrieve(
                project_id,
                prompt or section.title,
                store,
                section_id=section.section_id,
                references=references,
            )
            evidence = "\n".join(
                c.text for c in packet.chunks if c.source_type in ("web", "memory")
            )
        reqs, missing, ratio = _section_gate(section, answers, evidence=evidence)

        if missing and interactive:
            questionnaire.run_wizard(missing, store, project_id)
            answers = store.get_evidence(project_id)
            reqs, missing, ratio = _section_gate(section, answers, evidence=evidence)
            packet = None  # answers changed; re-retrieve inside _generate_one

        if ratio < config.EVIDENCE_MIN_COVERAGE:
            result = GenerationResult(
                section_id=section.section_id,
                text="",
                warnings=[
                    Warning(
                        code="blocked_missing_evidence",
                        message=f"evidence coverage {ratio:.0%} < {config.EVIDENCE_MIN_COVERAGE:.0%}; "
                        f"missing: {', '.join(missing) or 'n/a'}",
                        location=section.section_id,
                    )
                ],
                status="blocked",
                missing_fields=missing,
            )
            store.save_generation(project_id, section.section_id, result)
            results[section.section_id] = result
            done += 1
            if progress_cb is not None:
                progress_cb(section.section_id, "blocked", done / total)
            continue

        if progress_cb is not None:
            progress_cb(section.section_id, "generating", done / total)
        result = _generate_one(
            project_id,
            section.section_id,
            store,
            query=prompt or section.title,
            packet=packet,
            cancel=cancel,
            references=references,
            on_delta=on_delta,
            progress_cb=progress_cb,
        )
        store.save_generation(project_id, section.section_id, result)
        results[section.section_id] = result
        done += 1
        if progress_cb is not None:
            progress_cb(section.section_id, result.status, done / total)

        if result.status == "generated" and stream is not None:
            stream(section.section_id, result.text)

    _post_process_sections(project_id, sections, store)
    return results


def rewrite(
    project_id: str,
    store: StorageService,
    section_ids: list[str] | None = None,
    *,
    prompt: str = "",
    stream: StreamFn | None = None,
    progress_cb: ProgressFn | None = None,
    cancel: CancelFn | None = None,
    references: list[tuple[str, str]] = (),
    on_delta: StreamFn | None = None,
) -> dict[str, GenerationResult]:
    """Research phase + rewrite of the given sections.

    Mirrors :func:`run`: when the research phase is enabled the prompt is
    researched first (Query Curator -> web search -> knowledge-graph memory), so
    every rewrite also draws fresh graph context. ``section_ids`` selects
    the sections to rewrite; when ``None``/empty, every section that
    already holds a ``"generated"`` result is rewritten. Rewrites are
    deliberate: each target's stored generation is overwritten, so a
    rewrite never falls into run's "skipped (already generated)" path.
    ``progress_cb`` receives ``(section_id, "generating", ratio)`` before
    each section and the terminal status after; ``stream`` receives the
    rewritten text on success. ``cancel`` (when given) is polled before
    each target; when it returns ``True`` the run stops with partial
    results. ``on_delta`` (when given) is invoked with
    ``(section_id, delta_text)`` for every raw stream fragment produced
    while a target is rewritten.

    Structural mode: when ``config.REWRITE_STRUCTURE_ENABLED`` is on, a
    non-empty ``prompt`` and an empty ``section_ids`` trigger
    :func:`md_rewriter.restructure` instead — the planner may also ADD and
    REMOVE sections, not just rewrite existing ones. Explicit section
    selection always takes the per-section path.
    """
    sections = store.get_sections(project_id)
    results: dict[str, GenerationResult] = {}

    if cancel is not None and cancel():
        return results
    if config.RESEARCH_ENABLED and prompt:
        if progress_cb is not None:
            progress_cb("", "research", 0.0)
        research(project_id, prompt=prompt, progress_cb=progress_cb)

    if config.REWRITE_STRUCTURE_ENABLED and prompt and not section_ids:
        if progress_cb is not None:
            progress_cb("", "restructuring", 0.0)
        outcome = md_rewriter.restructure(
            project_id,
            store,
            instruction=prompt,
            cancel=cancel,
            references=references,
            progress_cb=progress_cb,
            on_delta=on_delta,
        )
        total = max(1, len(outcome.rewritten))
        done = 0
        for section_id, result in outcome.rewritten.items():
            store.save_generation(project_id, section_id, result)
            results[section_id] = result
            done += 1
            if progress_cb is not None:
                progress_cb(section_id, result.status, done / total)
            if result.status == "generated" and stream is not None:
                stream(section_id, result.text)
        return results

    if section_ids:
        targets = [
            s for s in walk_sections(sections) if s.section_id in set(section_ids)
        ]
    else:
        targets = [
            s
            for s in walk_sections(sections)
            if (g := store.get_generation(project_id, s.section_id)) is not None
            and g.status == "generated"
        ]

    total = max(1, len(targets))
    done = 0
    target_ids = {section.section_id for section in targets}
    # Cascade only fills alignment gaps; skip direct targets and already-generated sections.
    cascade_skip = target_ids | {
        s.section_id
        for s in walk_sections(sections)
        if (g := store.get_generation(project_id, s.section_id)) is not None
        and g.status == "generated"
    }

    for section in targets:
        if cancel is not None and cancel():
            break
        if progress_cb is not None:
            progress_cb(section.section_id, "generating", done / total)
        rewrite_kwargs = {"instruction": prompt, "cancel": cancel, "references": references}
        if on_delta is not None:
            rewrite_kwargs["on_delta"] = _delta_for(section.section_id, on_delta)
        result = md_rewriter.rewrite_section(
            project_id,
            section.section_id,
            store,
            **rewrite_kwargs,
        )
        store.save_generation(project_id, section.section_id, result)
        results[section.section_id] = result
        done += 1
        if progress_cb is not None:
            progress_cb(section.section_id, result.status, done / total)

        if result.status == "generated" and stream is not None:
            stream(section.section_id, result.text)

        if result.status == "generated" and prompt:
            cascaded = cascade_service.cascade_rewrite(
                project_id,
                store,
                section.section_id,
                result.text,
                source_title=section.title,
                cancel=cancel,
                skip=cascade_skip,
            )
            for cascade_id, cascade_result in cascaded.items():
                store.save_generation(project_id, cascade_id, cascade_result)
                results[cascade_id] = cascade_result
                if progress_cb is not None:
                    progress_cb(cascade_id, cascade_result.status, done / total)
                if cascade_result.status == "generated" and stream is not None:
                    stream(cascade_id, cascade_result.text)

    return results


def format_document(
    project_id: str,
    store: StorageService,
    *,
    stream: StreamFn | None = None,
    progress_cb: ProgressFn | None = None,
    cancel: CancelFn | None = None,
    on_delta: StreamFn | None = None,
) -> dict[str, GenerationResult]:
    """Reformat every section's body in place (content-preserving).

    Iterates all sections in tree order and passes each through
    :func:`md_rewriter.format_section`, a pure Markdown-normalization pass
    with no retrieval and no content changes — unlike :func:`rewrite` it
    never triggers structural planning or cascade rewrites. Every section
    with text is formatted (not just ``"generated"`` ones), so drafts and
    parsed originals are covered too. ``progress_cb`` receives
    ``(section_id, "generating", ratio)`` before each section and the
    terminal status after; ``stream`` receives each formatted body;
    ``on_delta`` receives raw stream fragments; ``cancel`` is polled
    between sections and stops the pass early.
    """
    sections = store.get_sections(project_id)
    results: dict[str, GenerationResult] = {}

    if cancel is not None and cancel():
        return results

    targets = [s for s in walk_sections(sections) if _has_text(s)]
    total = max(1, len(targets))
    done = 0
    for section in targets:
        if cancel is not None and cancel():
            break
        if progress_cb is not None:
            progress_cb(section.section_id, "generating", done / total)
        format_kwargs: dict = {"cancel": cancel}
        if on_delta is not None:
            format_kwargs["on_delta"] = _delta_for(section.section_id, on_delta)
        result = md_rewriter.format_section(
            project_id, section.section_id, store, **format_kwargs
        )
        store.save_generation(project_id, section.section_id, result)
        results[section.section_id] = result
        done += 1
        if progress_cb is not None:
            progress_cb(section.section_id, result.status, done / total)
        if result.status == "generated" and stream is not None:
            stream(section.section_id, result.text)
    return results


def _has_text(section: Section) -> bool:
    if section.description:
        return True
    return any(u.text for u in section.content)


def _section_text(project_id: str, store: StorageService, section: Section) -> str:
    """Current text for a section: stored generation, else parsed content."""
    gen = store.get_generation(project_id, section.section_id)
    if gen is not None and gen.text:
        return gen.text
    parts = [section.description] if section.description else []
    parts.extend(u.text for u in section.content if u.text)
    return "\n\n".join(parts)


def merge_similar_sections(
    project_id: str,
    store: StorageService,
    *,
    threshold: float | None = None,
    cancel: CancelFn | None = None,
    progress_cb: ProgressFn | None = None,
) -> list[MergeResult]:
    """Merge sibling sections whose headers are near-duplicates.

    Groups every section by its parent, scores each sibling pair with the
    header-embedding cosine similarity (stored embeddings, computed and
    persisted on demand when missing), and merges every pair at or above
    ``threshold`` (default ``config.MERGE_MIN_SIMILARITY``): the earlier
    section keeps its identity and absorbs the later one's description,
    content, and children; the absorbed section is removed from the tree.
    Orders are renumbered, summaries recomputed, and the tree persisted
    when anything merged. ``progress_cb`` receives ``(section_id, "merging",
    ratio)`` per sibling group; ``cancel`` stops the pass early (partial
    merges are still persisted). Returns the merged pairs.
    """
    limit = config.MERGE_MIN_SIMILARITY if threshold is None else threshold
    sections = store.get_sections(project_id)
    all_sections = walk_sections(sections)
    if not all_sections:
        return []

    embeddings: dict[str, list[float]] = {}
    missing: list[Section] = []
    for section in all_sections:
        vec = store.get_header_embedding(project_id, section.section_id)
        if vec:
            embeddings[section.section_id] = vec
        else:
            missing.append(section)
    if missing:
        vectors = embedding_service.embed_section_headers(missing)
        store.save_vectors(project_id, vectors)
        embeddings.update({r.section_id: r.embedding for r in vectors})

    groups: dict[str | None, list[Section]] = {}
    for section in all_sections:
        groups.setdefault(section.parent_id, []).append(section)

    results: list[MergeResult] = []
    total = max(1, len(groups))
    for group_index, group in enumerate(groups.values()):
        for i, kept in enumerate(group):
            if not find_section(sections, kept.section_id):
                continue
            kept_vec = embeddings.get(kept.section_id)
            if kept_vec is None:
                continue
            best: tuple[int, float] | None = None
            for j in range(i + 1, len(group)):
                removed = group[j]
                if not find_section(sections, removed.section_id):
                    continue
                removed_vec = embeddings.get(removed.section_id)
                if removed_vec is None:
                    continue
                score = cosine_similarity(kept_vec, removed_vec)
                if score >= limit and (best is None or score > best[1]):
                    best = (j, score)
            if best is None:
                continue
            removed = group[best[0]]
            if kept.description and removed.description:
                kept.description = f"{kept.description}\n{removed.description}"
            elif removed.description:
                kept.description = removed.description
            kept.content.extend(removed.content)
            for child in removed.children:
                child.parent_id = kept.section_id
            kept.children.extend(removed.children)
            count_words(kept)
            remove_section(sections, removed.section_id)
            results.append(
                MergeResult(kept.section_id, removed.section_id, best[1])
            )
        if progress_cb is not None:
            progress_cb("", "merging", (group_index + 1) / total)
        if cancel is not None and cancel():
            break

    if results:
        renumber_orders(sections)
        summarize_sections(sections)
        store.save_sections(project_id, sections)
    return results


def research(project_id: str, *, prompt: str, progress_cb: ProgressFn | None = None) -> ResearchNote | None:
    """Research phase: Query Curator -> web search -> knowledge graph.

    Features 3-7: the query curator turns ``prompt`` into a plan (topic,
    what/how/why queries, unique angle, prompt links); the plan is expanded
    per region (Nigeria/Africa/Europe/America) and searched via DuckDuckGo;
    prompt-supplied links are fetched and merged; everything is persisted
    to the knowledge-graph memory. Never raises — a failure at any step
    logs a warning and the pipeline proceeds without research.
    """
    try:
        plan = research_planner.build_plan(prompt)
        if plan is None:
            logger.info("research: empty prompt; skipping")
            return None

        queries = research_planner.build_search_queries(plan)
        logger.info(
            "research: topic=%r angle=%r searching %d queries (+%d prompt links)",
            plan.topic,
            plan.angle,
            len(queries),
            len(plan.prompt_links),
        )

        if progress_cb is not None:
            progress_cb("", "searching", 0.2)
        by_query = search_service.search_many(queries)
        fetched = search_service.fetch_links(plan.prompt_links)

        notes: list[ResearchNote] = []
        for query, results in by_query.items():
            for result in results[: config.RESEARCH_MAX_LINKS]:
                if not result.markdown.strip():
                    continue
                notes.append(
                    ResearchNote(
                        title=f"{plan.topic}: {query[:60]}",
                        content=f"{result.markdown.strip()[:2000]}",
                        source_url=result.url,
                        authoritative=result.authoritative,
                        tags=[plan.angle] if plan.angle else [],
                    )
                )
        for url, markdown in fetched.items():
            notes.append(
                ResearchNote(
                    title=f"{plan.topic}: prompt link ({url[:40]})",
                    content=markdown[:2000],
                    source_url=url,
                    authoritative=False,
                    tags=[plan.angle] if plan.angle else [],
                )
            )

        if notes:
            if progress_cb is not None:
                progress_cb("", "researching", 0.8)
            memory_service.save_research(project_id, plan, notes)
        memory_service.remember_angle(project_id, plan.angle)
        logger.info("research: %d notes persisted for project %s", len(notes), project_id)
        return notes[0] if notes else None
    except Exception as exc:  # research must never break the run
        logger.warning("research phase failed: %s", exc)
        return None


def _last_used_model() -> str:
    """``"provider/model"`` of the most recent generation, or ``""``."""
    used = providers.last_used()
    return f"{used[0]}/{used[1]}" if used else ""


def _generate_one(
    project_id: str,
    section_id: str,
    store: StorageService,
    *,
    query: str,
    packet: EvidencePacket | None = None,
    cancel: CancelFn | None = None,
    references: list[tuple[str, str]] = (),
    on_delta: StreamFn | None = None,
    progress_cb: ProgressFn | None = None,
) -> GenerationResult:
    """Generate one section; ``packet`` (when given) skips re-retrieval.

    The orchestrator retrieves up front in structure-only mode so the
    evidence gate can count research toward coverage; passing the same
    packet avoids a duplicate retrieval (and duplicate web searches).
    ``on_delta`` (when given) receives each raw stream fragment as the
    section body is generated (including validation retry attempts).
    """
    try:
        if progress_cb is not None:
            progress_cb(section_id, "thinking", 0.0)
        if packet is None:
            packet = retrieval_service.retrieve(
                project_id, query, store, section_id=section_id, references=references
            )
        prompt = context_builder.build(packet)
        source_texts = [c.text for c in packet.chunks]
        gen_kwargs = {"cancel": cancel}
        if on_delta is not None:
            gen_kwargs["on_delta"] = _delta_for(section_id, on_delta)
        if progress_cb is not None:
            progress_cb(section_id, "writing", 0.3)
        text = writing_service.generate(prompt, **gen_kwargs)
        if progress_cb is not None:
            progress_cb(section_id, "proofreading", 0.7)
        warnings = validation_service.check(
            section_id, text, source_chunks=source_texts
        )
        retries = 0
        while (
            validation_service.has_severe(warnings)
            and retries < config.GENERATION_MAX_RETRIES
        ):
            if cancel is not None and cancel():
                raise writing_service.GenerationCancelled()
            retries += 1
            severe = sorted(
                {w.code for w in warnings if w.code in validation_service.SEVERE_CODES}
            )
            logger.warning(
                "section %s failed validation (%s); rewrite attempt %d/%d",
                section_id,
                ", ".join(severe),
                retries,
                config.GENERATION_MAX_RETRIES,
            )
            prompt = context_builder.build_rewrite(
                packet,
                existing_text=text,
                instruction=validation_service.retry_instruction(warnings),
            )
            if progress_cb is not None:
                progress_cb(section_id, "writing", 0.3)
            text = writing_service.generate(prompt, **gen_kwargs)
            if progress_cb is not None:
                progress_cb(section_id, "proofreading", 0.7)
            warnings = validation_service.check(
                section_id, text, source_chunks=source_texts
            )
        return GenerationResult(
            section_id=section_id,
            text=text,
            warnings=warnings,
            sources=retrieval_service.collect_sources(packet),
            model=_last_used_model(),
        )
    except writing_service.GenerationCancelled:
        raise
    except Exception as exc:  # keep pipeline alive; mark section failed
        logger.exception("section %s failed", section_id)
        return GenerationResult(
            section_id=section_id,
            text="",
            warnings=[
                Warning(
                    code="generation_failed",
                    message=str(exc),
                    location=section_id,
                )
            ],
            status="failed",
            error=str(exc),
        )


def new_store() -> StorageService:
    """Storage factory honoring ``config.STORE_BACKEND``.

    ``"opensearch"`` attempts a live OpenSearch connection (via
    :func:`opensearch_store.new_store`) and falls back to the in-memory
    store on any failure; any other value returns ``InMemoryStore``.
    """
    from .opensearch_store import new_store as _opensearch_new_store

    return _opensearch_new_store()
