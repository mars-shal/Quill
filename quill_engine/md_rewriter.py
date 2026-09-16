"""Service — MarkdownRewriter: regenerate already-generated sections.

Rewrite takes a section's current generated body, pulls fresh evidence
(retrieval + knowledge-graph memory), and regenerates the body against
the user's instruction via :func:`context_builder.build_rewrite`.

Unlike ``orchestrator.run`` this is deliberately NOT idempotent: the
caller overwrites the stored generation, so a rewrite never falls into
the "skipped (already generated)" path. The service returns the new
result without persisting it — the orchestrator owns persistence (same
convention as ``orchestrator._generate_one``).

Structural rewriting (:func:`plan_restructure` + :func:`restructure`)
lets an instruction-driven rewrite also ADD, REMOVE, and RENAME sections:
the planner proposes the tree edits, they are validated and applied, and
every changed section is regenerated through the same cascade.
"""

from __future__ import annotations

import json
import logging
import re


from . import (
    config,
    context_builder,
    providers,
    retrieval_service,
    validation_service,
    writing_service,
)
from .models import (
    AddOp,
    GenerationResult,
    PromptPackage,
    RenameOp,
    RestructureOutcome,
    RestructurePlan,
    RewriteOp,
    Warning,
    find_section,
    insert_section,
    new_section,
    remove_section,
    walk_sections,
)
from .storage import StorageService

logger = logging.getLogger(__name__)


def _last_used_model() -> str:
    """``"provider/model"`` of the most recent generation, or ``""``."""
    used = providers.last_used()
    return f"{used[0]}/{used[1]}" if used else ""


def rewrite_section(
    project_id: str,
    section_id: str,
    store: StorageService,
    *,
    instruction: str = "",
    cancel: Callable[[], bool] | None = None,
    on_delta: Callable[[str], None] | None = None,
    references: list[tuple[str, str]] = (),
) -> GenerationResult:
    """Rewrite one section's body against ``instruction``.

    Retrieval is driven by ``instruction`` (falling back to the section
    title when empty) so the rewrite request drives what gets revised.
    A section with no prior generation is treated as a fresh generate.
    Failures are returned as ``status="failed"`` (never raised) so the
    pipeline stays alive, mirroring ``orchestrator._generate_one``.
    ``cancel`` is polled between stream chunks and propagates
    ``GenerationCancelled`` to the caller. ``on_delta`` (when given)
    receives each raw stream fragment of the regenerated body.
    """
    try:
        sections = store.get_sections(project_id)
        section = find_section(sections, section_id)
        query = instruction or (section.title if section is not None else section_id)

        packet = retrieval_service.retrieve(
            project_id, query, store, section_id=section_id, references=references
        )
        existing = store.get_generation(project_id, section_id)
        existing_text = existing.text if existing is not None else ""

        package = context_builder.build_rewrite(
            packet,
            existing_text=existing_text,
            instruction=instruction,
        )
        gen_kwargs = {"cancel": cancel}
        if on_delta is not None:
            gen_kwargs["on_delta"] = on_delta
        text = writing_service.generate(package, **gen_kwargs)
        source_texts = [c.text for c in packet.chunks]
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
            logger.warning(
                "rewrite of section %s failed validation; attempt %d/%d",
                section_id,
                retries,
                config.GENERATION_MAX_RETRIES,
            )
            package = context_builder.build_rewrite(
                packet,
                existing_text=text,
                instruction=validation_service.retry_instruction(warnings),
            )
            gen_kwargs = {"cancel": cancel}
            if on_delta is not None:
                gen_kwargs["on_delta"] = on_delta
            text = writing_service.generate(package, **gen_kwargs)
            warnings = validation_service.check(
                section_id, text, source_chunks=source_texts
            )

        return GenerationResult(
            section_id=section_id,
            text=text,
            warnings=warnings,
            status="generated",
            sources=retrieval_service.collect_sources(packet),
            model=_last_used_model(),
        )
    except writing_service.GenerationCancelled:
        raise
    except Exception as exc:  # keep the pipeline alive; mark the section failed
        logger.exception("rewrite of section %s failed", section_id)
        return GenerationResult(
            section_id=section_id,
            text="",
            warnings=[
                Warning(
                    code="rewrite_failed",
                    message=str(exc),
                    location=section_id,
                )
            ],
            status="failed",
            error=str(exc),
        )


_FORMAT_SYSTEM = (
    "You are a careful Markdown editor. Reformat the given section's text for\n"
    "clean, consistent Markdown: normalize heading levels (single # for the\n"
    "title, ## for subsections), consistent paragraph spacing, tidy list and\n"
    "emphasis markup, and clear code spans. Do NOT change the wording, meaning,\n"
    "facts, or structure of the content. Do NOT add, remove, or rewrite the\n"
    "prose. Output only the reformatted Markdown body."
)


def format_section(
    project_id: str,
    section_id: str,
    store: StorageService,
    *,
    instruction: str = "",
    cancel: Callable[[], bool] | None = None,
    on_delta: Callable[[str], None] | None = None,
) -> GenerationResult:
    """Reformat one section's body in place (content-preserving).

    Unlike :func:`rewrite_section` this does no retrieval: it is a pure
    text transformation that normalizes Markdown markup (headings, spacing,
    lists, emphasis). ``existing_text`` comes from the stored generation
    when present, else the parsed content. ``cancel`` and ``on_delta``
    behave as in :func:`rewrite_section`. Failures return
    ``status="failed"`` (never raised), mirroring the rest of the pipeline.
    """
    try:
        sections = store.get_sections(project_id)
        section = find_section(sections, section_id)
        existing = store.get_generation(project_id, section_id)
        existing_text = existing.text if existing is not None else ""
        if not existing_text and section is not None:
            parts = [section.description] if section.description else []
            parts.extend(u.text for u in section.content if u.text)
            existing_text = "\n\n".join(parts)
        if not existing_text:
            return GenerationResult(
                section_id=section_id,
                text="",
                warnings=[],
                status="failed",
                error="section has no text to format",
            )

        task = f"Additional instruction: {instruction}" if instruction else ""
        package = PromptPackage(
            system_instructions=_FORMAT_SYSTEM,
            template=(
                f"{task}\n\nReformat this section's Markdown:\n\n"
                f"{existing_text}"
            ).strip(),
            style_profile={},
            evidence=[],
            target_words=0,
            missing_fields=[],
        )
        gen_kwargs = {"cancel": cancel}
        if on_delta is not None:
            gen_kwargs["on_delta"] = on_delta
        text = writing_service.generate(package, **gen_kwargs)
        warnings = validation_service.check(
            section_id, text, source_chunks=[] if section is None else [u.text for u in section.content]
        )
        return GenerationResult(
            section_id=section_id,
            text=text,
            warnings=warnings,
            status="generated",
            sources=[],
            model=_last_used_model(),
        )
    except writing_service.GenerationCancelled:
        raise
    except Exception as exc:
        logger.exception("format of section %s failed", section_id)
        return GenerationResult(
            section_id=section_id,
            text="",
            warnings=[
                Warning(code="format_failed", message=str(exc), location=section_id)
            ],
            status="failed",
            error=str(exc),
        )


# ---------------------------------------------------------------------------
# Structural rewrite: add / remove / rewrite sections
# ---------------------------------------------------------------------------

_PLAN_SYSTEM = (
    "You are a report editor restructuring the section tree of an "
    "industrial-training (SIWES/SWEP) report. Given the current sections "
    "and the user's rewrite instruction, produce a STRICT JSON plan with "
    "exactly these keys:\n"
    '{"rewrite": [{"section_id": "<id>", "instruction": "<what to change>"}],'
    ' "add": [{"title": "<new title>", "parent_id": "<id> or null",'
    ' "after_section_id": "<sibling id> or null", "description": "<optional>",'
    ' "instruction": "<what to write>"}],'
    ' "remove": ["<section id>"],'
    ' "rename": [{"section_id": "<id>", "title": "<new title>"}]}\n'
    "Rules: rewrite revises existing sections (a per-op instruction overrides "
    "the user's instruction when non-empty). add inserts a new section under "
    "parent_id (null = top-level chapter), after the sibling after_section_id "
    "(null = append at the end of that level). remove deletes a section with "
    "its whole subtree; only remove sections the instruction clearly calls "
    "for or that are empty/redundant. rename retitles an existing section "
    "without moving it — use it when the instruction calls for a more "
    "accurate heading. A section may appear in at most one list, and only "
    "ids listed below may be referenced. Never invent ids. Output JSON only, "
    "no prose, no markdown fences."
)


def _plan_prompt(instruction: str, sections: list) -> str:
    """Render the section tree (id, level, title, status) for the planner."""
    lines = [f"User instruction: {instruction}", "", "Current sections:"]
    for section in walk_sections(sections):
        indent = "  " * max(0, section.level - 1)
        lines.append(f"{indent}- {section.section_id} [{section.level}] {section.title}")
    lines.append("")
    lines.append(
        "Return the JSON plan describing which sections to rewrite, add, "
        "remove, and rename to best fulfill the instruction."
    )
    return "\n".join(lines)


def _plan_complete(prompt: str) -> str:
    """One structured call for the restructure plan (never raises)."""
    provider = next(iter(providers.active_chain()), None)
    if provider is None:
        logger.warning("restructure planner: no active LLM provider")
        return ""
    try:
        model = config.PLAN_MODEL or config.CURATOR_MODEL
        return providers.complete(
            providers.with_model(provider, model),
            [
                {"role": "system", "content": _PLAN_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=1024,
            max_retries=1,
        )
    except Exception as exc:
        logger.warning("restructure planner call failed: %s", exc)
        return ""


def _optional_str(value) -> str | None:
    if value in (None, ""):
        return None
    return str(value)


def _parse_plan(raw: str) -> RestructurePlan:
    """Parse the planner's JSON into a plan, tolerating fences/stray prose."""
    if not raw:
        return RestructurePlan()
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    data: dict | None = None
    try:
        data = json.loads(text)
        if not isinstance(data, dict):
            data = None
    except (ValueError, TypeError):
        pass
    if data is None:
        block = re.search(r"\{.*\}", text, re.DOTALL)
        if block:
            try:
                parsed = json.loads(block.group(0))
                data = parsed if isinstance(parsed, dict) else None
            except (ValueError, TypeError):
                pass
    if data is None:
        return RestructurePlan()

    plan = RestructurePlan()
    for item in data.get("rewrite", []) or []:
        if isinstance(item, dict) and item.get("section_id"):
            plan.rewrite.append(
                RewriteOp(section_id=str(item["section_id"]), instruction=str(item.get("instruction") or ""))
            )
    for item in data.get("add", []) or []:
        if isinstance(item, dict) and item.get("title"):
            plan.add.append(
                AddOp(
                    title=str(item["title"]),
                    parent_id=_optional_str(item.get("parent_id")),
                    after_section_id=_optional_str(item.get("after_section_id")),
                    level=int(item["level"]) if item.get("level") not in (None, "") else None,
                    description=str(item.get("description") or ""),
                    instruction=str(item.get("instruction") or ""),
                )
            )
    for section_id in data.get("remove", []) or []:
        if isinstance(section_id, str) and section_id:
            plan.remove.append(section_id)
    for item in data.get("rename", []) or []:
        if isinstance(item, dict) and item.get("section_id") and item.get("title"):
            plan.rename.append(
                RenameOp(section_id=str(item["section_id"]), title=str(item["title"]))
            )
    return plan


def _validate_plan(plan: RestructurePlan, sections: list) -> RestructurePlan:
    """Drop operations referencing unknown ids or conflicting lists."""
    known = {s.section_id for s in walk_sections(sections)}
    removed_set = set(plan.remove) & known
    rewritten_set = {op.section_id for op in plan.rewrite if op.section_id in known}

    valid = RestructurePlan()
    valid.remove = sorted(removed_set - rewritten_set)
    valid.rewrite = [
        op for op in plan.rewrite if op.section_id in known and op.section_id not in removed_set
    ]
    valid.rename = [
        op
        for op in plan.rename
        if op.section_id in known
        and op.section_id not in removed_set
        and op.section_id not in rewritten_set
        and op.title.strip()
    ]
    for op in plan.add:
        if not op.title:
            continue
        if op.parent_id is not None and op.parent_id not in known:
            continue
        if op.parent_id in removed_set:
            continue
        if op.after_section_id is not None and op.after_section_id not in known:
            continue
        if op.after_section_id in removed_set:
            continue
        valid.add.append(op)
    return valid


def plan_restructure(
    project_id: str,
    store: StorageService,
    *,
    instruction: str,
) -> RestructurePlan:
    """Propose structural tree edits (rewrite/add/remove) for ``instruction``.

    A single planner call over the section tree; the plan is validated
    against the live tree before being returned. When the planner call
    fails or returns nothing, an empty plan is returned (the caller then
    falls back to rewriting every generated section).
    """
    sections = store.get_sections(project_id)
    raw = _plan_complete(_plan_prompt(instruction, sections))
    plan = _validate_plan(_parse_plan(raw), sections)
    if not (plan.rewrite or plan.add or plan.remove or plan.rename):
        logger.info(
            "restructure planner returned no edits for %s; falling back to plain rewrite",
            project_id,
        )
    return plan


def _section_delta(
    section_id: str,
    on_delta: Callable[[str, str], None] | None,
) -> Callable[[str], None] | None:
    """Bind a section id onto ``on_delta`` (``None``-safe passthrough).

    Mirrors ``orchestrator._delta_for``; defined here so ``restructure``
    can stream per-section fragments without importing the orchestrator
    (the two modules cannot import each other).
    """
    if on_delta is None:
        return None
    return lambda text: on_delta(section_id, text)


def restructure(
    project_id: str,
    store: StorageService,
    *,
    instruction: str,
    cancel: Callable[[], bool] | None = None,
    references: list[tuple[str, str]] = (),
    progress_cb: Callable[[str, str, float], None] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> RestructureOutcome:
    """Apply a structural rewrite: remove/add/rename/rewrite sections per the plan.

    Tree edits are persisted immediately (added sections must exist in the
    tree before retrieval can resolve them); every changed section is then
    regenerated through :func:`rewrite_section`. The returned generations
    are NOT persisted — the orchestrator owns that, as usual.
    """
    sections = store.get_sections(project_id)
    plan = plan_restructure(project_id, store, instruction=instruction)

    removed: list[str] = []
    for section_id in plan.remove:
        if remove_section(sections, section_id):
            removed.append(section_id)

    added: list[str] = []
    for op in plan.add:
        parent = find_section(sections, op.parent_id) if op.parent_id else None
        level = op.level if op.level is not None else (parent.level + 1 if parent else 1)
        section = new_section(
            op.title,
            level=level,
            order=0,
            parent_id=op.parent_id,
            description=op.description,
        )
        if insert_section(
            sections, section, parent_id=op.parent_id, after_section_id=op.after_section_id
        ):
            added.append(section.section_id)

    renamed: list[str] = []
    if plan.rename:
        for op in plan.rename:
            section = find_section(sections, op.section_id)
            if section is not None:
                section.title = op.title
                renamed.append(op.section_id)

    if removed or added or renamed:
        store.save_sections(project_id, sections)

    rewritten: dict[str, GenerationResult] = {}

    def rewrite_target(section_id: str, target_instruction: str, done: int, total: int) -> None:
        if progress_cb is not None:
            progress_cb(section_id, "generating", done / total)
        rewritten[section_id] = rewrite_section(
            project_id,
            section_id,
            store,
            instruction=target_instruction,
            cancel=cancel,
            references=references,
            on_delta=_section_delta(section_id, on_delta),
        )

    rewrite_targets: list[tuple[str, str]] = [
        (op.section_id, op.instruction) for op in plan.rewrite
    ] + [(section_id, instruction) for section_id in added]
    total = max(1, len(rewrite_targets))
    done = 0
    for section_id, target_instruction in rewrite_targets:
        if cancel is not None and cancel():
            break
        rewrite_target(section_id, target_instruction, done, total)
        done += 1

    return RestructureOutcome(
        rewritten=rewritten, added=added, removed=removed, renamed=renamed
    )
