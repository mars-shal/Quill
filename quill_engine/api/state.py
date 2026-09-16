"""Server-side state: open projects, run manager, worker threads.

The engine is fully synchronous, so every long call (run / rewrite /
merge) executes on a daemon thread and reports through the event hub.
``engine`` is any duck-typed module exposing the orchestrator surface
(``ingest``, ``run``, ``rewrite``, ``merge_similar_sections``) — tests
substitute a fake the same way the TUI swaps in ``FakeRunner``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .. import config, section_parser, validation_service
from ..models import (
    ContentUnit,
    GenerationResult,
    Section,
    count_words,
    find_section,
    new_section,
    renumber_orders,
    walk_sections,
)
from ..orchestrator import _project_id_for
from ..writing_service import GenerationCancelled
from .events import EventHub

logger = logging.getLogger(__name__)

# Pseudo-section id for the whole-document draft view (plain text, NOT a tree
# section). Draft saves persist the raw markdown here; the section tree is
# never rebuilt from draft content.
DRAFT_ID = "__draft__"


class EngineLike(Protocol):
    def ingest(
        self, file_path: str, store: Any, *, embed: bool = True, structure_only: bool = False
    ) -> str: ...
    def run(self, project_id: str, store: Any, **kwargs: Any) -> dict[str, GenerationResult]: ...
    def rewrite(
        self, project_id: str, store: Any, section_ids: list[str] | None, **kwargs: Any
    ) -> dict[str, GenerationResult]: ...
    def merge_similar_sections(self, project_id: str, store: Any, **kwargs: Any) -> list: ...


@dataclass
class ProjectState:
    project_id: str
    title: str
    file_path: str | None = None
    opened_at: float = field(default_factory=time.time)


class Registry:
    """Open projects (id -> metadata) over a shared storage backend."""

    def __init__(self, store: Any, engine: EngineLike) -> None:
        self.store = store
        self.engine = engine
        self.projects: dict[str, ProjectState] = {}

    def open(self, file_path: str, *, embed: bool = True) -> ProjectState:
        """Register ``file_path``'s project, ingesting only when new.

        Section ids are random per ingest, so a re-ingest would orphan any
        persisted generations. When the store already has sections for the
        deterministic project id, the project resumes as-is (the same
        contract the TUI relies on: a re-opened document is rewritten, not
        regenerated). The GUI keeps the source prose (``structure_only``
        off) so opened sections show the extracted text, not just the
        heading skeleton.
        """
        project_id = _project_id_for(file_path)
        if not self.store.get_sections(project_id):
            project_id = self.engine.ingest(
                file_path, self.store, embed=embed, structure_only=False
            )
        title = os.path.splitext(os.path.basename(file_path))[0]
        state = ProjectState(project_id=project_id, title=title, file_path=file_path)
        self.projects[project_id] = state
        return state

    def create(self, title: str) -> ProjectState:
        """Blank project: a single level-1 section the user renames/grows."""
        project_id = "proj_" + hashlib.sha256(
            f"{title}:{uuid.uuid4()}".encode("utf-8")
        ).hexdigest()[:16]
        section = new_section(
            title=title or "Untitled", level=1, order=1, parent_id=None
        )
        self.store.save_sections(project_id, [section])
        state = ProjectState(project_id=project_id, title=title or "Untitled")
        self.projects[project_id] = state
        return state

    def update_title(self, project_id: str, title: str) -> bool:
        state = self.get(project_id)
        if state is None:
            return False
        state.title = title.strip() or state.title
        return True

    def get(self, project_id: str) -> ProjectState | None:
        state = self.projects.get(project_id)
        if state is not None:
            return state
        # Disk-backed store: project persisted by an earlier session.
        sections = self.store.get_sections(project_id)
        if not sections:
            return None
        state = ProjectState(project_id=project_id, title=sections[0].title)
        self.projects[project_id] = state
        return state

    def list_recent(self, limit: int = 20) -> list[dict[str, Any]]:
        """Projects from this session plus anything persisted on disk."""
        seen: dict[str, dict[str, Any]] = {}
        for project_id, state in self.projects.items():
            seen[project_id] = self._recent_entry(
                project_id, state.title, state.file_path
            )
        try:
            names = sorted(os.listdir(config.PERSIST_DIR), reverse=True)
        except OSError:
            names = []
        for name in names:
            if not name.endswith(".json") or len(seen) >= limit:
                continue
            project_id = name[: -len(".json")]
            if project_id in seen:
                continue
            sections = self.store.get_sections(project_id)
            if not sections:
                continue
            seen[project_id] = self._recent_entry(
                project_id, sections[0].title, None
            )
        return list(seen.values())[:limit]

    def _recent_entry(
        self, project_id: str, title: str, file_path: str | None
    ) -> dict[str, Any]:
        sections = self.store.get_sections(project_id)
        return {
            "project_id": project_id,
            "title": title,
            "file_path": file_path,
            "section_count": sum(1 for _ in walk_sections(sections)),
            "total_words": sum(section.word_count for section in walk_sections(sections)),
        }


# ---------------------------------------------------------------------------
# Tree/status helpers shared by routes and the run manager
# ---------------------------------------------------------------------------


def section_status(result: GenerationResult | None) -> str:
    if result is None:
        return "pending"
    return result.status if result.status in {"generated", "blocked", "failed"} else "pending"


def build_tree(sections: list[Section], store: Any, project_id: str) -> list[dict[str, Any]]:
    def node(section: Section) -> dict[str, Any]:
        result = store.get_generation(project_id, section.section_id)
        text = result.text if result is not None and result.text else ""
        current = text if text else _template_words(section)
        warnings = result.warnings if result is not None else []
        return {
            "section_id": section.section_id,
            "title": section.title,
            "level": section.level,
            "order": section.order,
            "status": section_status(result),
            "word_count": len(current.split()),
            "target_words": section.word_count,
            "warning_count": len(warnings),
            "children": [node(child) for child in section.children],
        }

    return [node(section) for section in sections]


def _template_words(section: Section) -> str:
    return " ".join(unit.text for unit in section.content)


def count_statuses(
    sections: list[Section], store: Any, project_id: str
) -> dict[str, int]:
    counts = {"generated": 0, "blocked": 0, "failed": 0, "pending": 0, "total_words": 0}
    for section in walk_sections(sections):
        result = store.get_generation(project_id, section.section_id)
        counts[section_status(result)] += 1
        if result is not None and result.text:
            counts["total_words"] += len(result.text.split())
    return counts


def save_manual_text(
    store: Any, project_id: str, section_id: str, text: str
) -> GenerationResult:
    """Persist a hand-edited section body as a manual generation."""
    warnings = validation_service.check(section_id, text)
    result = GenerationResult(
        section_id=section_id,
        text=text,
        warnings=warnings,
        status="generated",
        model="manual",
    )
    store.save_generation(project_id, section_id, result)
    return result


# ---------------------------------------------------------------------------
# Version history (restore points before AI runs and manual overwrites)
# ---------------------------------------------------------------------------

HISTORY_CAP = 20


def _history_path(project_id: str):
    from pathlib import Path

    return Path(config.PERSIST_DIR) / f"{project_id}.history.json"


def snapshot_history(
    store: Any, project_id: str, label: str
) -> int:
    """Record the current text of every written section as a restore point.

    Called before AI runs and manual overwrites so anything the pipeline
    replaces can be brought back. Returns the number of sections captured.
    """
    import json
    from time import time

    entries: list[dict] = []
    for section in walk_sections(store.get_sections(project_id)):
        result = store.get_generation(project_id, section.section_id)
        if result is None or not result.text or result.status == "deleted":
            continue
        entries.append(
            {
                "section_id": section.section_id,
                "title": section.title,
                "text": result.text,
                "model": result.model,
                "ts": time(),
            }
        )
    if not entries:
        return 0

    history: list[dict] = []
    try:
        history = json.loads(_history_path(project_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    history.insert(0, {"label": label, "ts": time(), "sections": entries})
    del history[HISTORY_CAP:]
    try:
        _history_path(project_id).write_text(
            json.dumps(history), encoding="utf-8"
        )
    except OSError as exc:
        logger.warning("history write failed: %s", exc)
    return len(entries)


def read_history(project_id: str) -> list[dict]:
    import json

    try:
        return json.loads(_history_path(project_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def restore_history_entry(store: Any, project_id: str, ts: float, section_id: str | None) -> bool:
    """Restore one section (or the whole snapshot when ``section_id`` is None)."""
    import json
    from time import time

    for entry in read_history(project_id):
        if abs(entry.get("ts", 0) - ts) > 1e-6:
            continue
        for item in entry["sections"]:
            if section_id is not None and item["section_id"] != section_id:
                continue
            result = GenerationResult(
                section_id=item["section_id"],
                text=item["text"],
                status="generated",
                model=f"restored/{item.get('model', '')}".rstrip("/"),
            )
            store.save_generation(project_id, item["section_id"], result)
            if section_id is None:
                continue
            return True
        if section_id is None:
            # snapshot the just-restored state so restore itself is undoable
            snapshot_history(store, project_id, "restore")
            _ = json, time  # keep imports referenced
            return True
        return False
    return False


# ---------------------------------------------------------------------------
# Section tree mutations (GUI "start my own document" flow)
# ---------------------------------------------------------------------------


def create_section(
    store: Any,
    project_id: str,
    *,
    title: str,
    parent_id: str | None = None,
    after_section_id: str | None = None,
) -> Section:
    """Append a section to the tree (child of ``parent_id`` or a new chapter)."""
    sections = store.get_sections(project_id)
    parent = find_section(sections, parent_id) if parent_id else None

    if parent is not None:
        section = new_section(
            title=title,
            level=min(6, parent.level + 1),
            order=len(parent.children) + 1,
            parent_id=parent.section_id,
        )
        parent.children.append(section)
    else:
        siblings = sections
        order = len(siblings) + 1
        if after_section_id:
            for index, chapter in enumerate(siblings):
                if chapter.section_id == after_section_id:
                    order = index + 2
                    break
        section = new_section(title=title, level=1, order=order, parent_id=None)
        siblings.insert(order - 1, section)

    renumber_orders(sections)
    store.save_sections(project_id, sections)
    return section


def rename_section(store: Any, project_id: str, section_id: str, title: str) -> Section | None:
    sections = store.get_sections(project_id)
    section = find_section(sections, section_id)
    if section is None:
        return None
    section.title = title.strip() or section.title
    store.save_sections(project_id, sections)
    return section


def delete_section(store: Any, project_id: str, section_id: str) -> bool:
    """Remove a section (and its subtree's generations) from the tree."""
    sections = store.get_sections(project_id)
    target = find_section(sections, section_id)
    if target is None:
        return False

    def prune(nodes: list[Section]) -> list[Section]:
        kept: list[Section] = []
        for node in nodes:
            if node.section_id == section_id:
                continue
            node.children = prune(node.children)
            kept.append(node)
        return kept

    sections = prune(sections)
    renumber_orders(sections)
    store.save_sections(project_id, sections)
    for doomed in walk_sections([target]):
        result = store.get_generation(project_id, doomed.section_id)
        if result is not None:
            orphaned = GenerationResult(
                section_id=doomed.section_id,
                text="",
                status="deleted",
            )
            store.save_generation(project_id, doomed.section_id, orphaned)
    return True


# ---------------------------------------------------------------------------
# Freewrite (whole-document draft -> section tree)
# ---------------------------------------------------------------------------


_ATX_HEADING_RE = re.compile(r"^\s*(#{1,6})\s+(.+)\s*$")


def _draft_blocks(markdown: str) -> list[tuple[str, str]]:
    """Split a whole-document draft into (title, body) blocks.

    ATX headings delimit each block; the body keeps its exact characters so
    markdown formatting survives the round trip. Prose before the first
    heading has no section to attach to and is dropped.
    """
    blocks: list[tuple[str, str]] = []
    title = ""
    body: list[str] = []
    for line in markdown.splitlines():
        match = _ATX_HEADING_RE.match(line)
        if match:
            if title:
                blocks.append((title, "\n".join(body).strip()))
            title, body = match.group(2).strip(), []
        elif title:
            body.append(line)
    if title:
        blocks.append((title, "\n".join(body).strip()))
    return blocks


def _norm_title(text: str) -> str:
    """Heading/section titles in comparable form: fold case + whitespace."""
    return " ".join(text.replace("**", "").split()).casefold()


def _norm_text(text: str) -> str:
    """Body text in comparable form: collapse all whitespace runs."""
    return " ".join(text.split())


def _section_body(store: Any, project_id: str, section: Section) -> str:
    """A section's current prose: stored manual generation, else parsed text."""
    result = store.get_generation(project_id, section.section_id)
    if result is not None and result.text:
        return result.text
    parts = [section.description] if section.description else []
    parts.extend(unit.text for unit in section.content if unit.text)
    return "\n\n".join(parts)


def is_draft_skeleton(markdown: str) -> bool:
    """True when a saved draft has no body text (only ATX heading lines).

    A heading-only blob is treated as a stale skeleton: the section tree
    usually carries the real body, so the whole-document route prefers the
    assembled tree document over it.
    """
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped and not _ATX_HEADING_RE.match(stripped):
            return False
    return bool(markdown.strip())


def sync_draft_writeback(store: Any, project_id: str, markdown: str) -> int:
    """Persist a whole-document draft's prose back onto the section tree.

    The blob under ``DRAFT_ID`` stays the WYSIWYG source of the draft view;
    this mirrors each ATX heading's body onto the matching tree section
    (paired by normalized title, matched greedily in document order, each
    section written at most once) as a manual generation, so text written
    under a header in the whole-document mode lands in that section. The
    draft blob remains the canonical draft text — unrecognized headings and
    content that matches no section are kept only there. Empty bodies never
    overwrite existing tree text (autosave must not blank a section). Returns
    the number of sections updated.
    """
    sections = store.get_sections(project_id)
    ordered = walk_sections(sections)
    blocks = _draft_blocks(markdown)
    if not ordered or not blocks:
        return 0

    pool = list(ordered)  # sections still open to receive a draft body
    norms = [_norm_title(section.title) for section in pool]
    matched_blocks = [False] * len(blocks)
    updated = 0
    for idx, (title, body) in enumerate(blocks):
        if not body:
            continue
        match = next((i for i, norm in enumerate(norms) if norm == _norm_title(title)), None)
        if match is None:
            continue  # unrecognized heading stays draft-only text
        matched_blocks[idx] = True
        section = pool.pop(match)
        norms.pop(match)
        result = store.get_generation(project_id, section.section_id)
        if result is not None and (result.text or "").strip() == body:
            continue  # already mirrors the draft — no churn
        save_manual_text(store, project_id, section.section_id, body)
        updated += 1

    # Rename pass: headings that still match no section may have been
    # retitled in the draft — pair them to unmatched sections by normalized
    # body text and retitle the section before writing the body.
    for idx, (title, body) in enumerate(blocks):
        if matched_blocks[idx] or not body:
            continue
        body_match = next(
            (i for i, section in enumerate(pool) if _norm_text(_section_body(store, project_id, section)) == _norm_text(body)),
            None,
        )
        if body_match is None:
            continue  # unrecognized heading stays draft-only text
        section = pool.pop(body_match)
        norms.pop(body_match)
        if _norm_title(section.title) != _norm_title(title):
            rename_section(store, project_id, section.section_id, title)
            updated += 1
        result = store.get_generation(project_id, section.section_id)
        if result is not None and (result.text or "").strip() == body:
            continue
        save_manual_text(store, project_id, section.section_id, body)
        updated += 1
    return updated


def parse_freewrite(markdown: str) -> list[Section]:
    """Parse a freewritten markdown draft into a section tree.

    ``section_parser.parse`` understands the report dialect (CHAPTER /
    numbered subheadings); plain documents ("# Title" + prose) fall back
    to a generic ATX-heading parse so any markdown draft yields a tree —
    headings nest by their ``#`` depth and paragraphs become content units.
    """
    sections = section_parser.parse(markdown, include_content=True)
    if sections:
        return sections

    roots: list[Section] = []
    stack: list[tuple[int, Section]] = []  # open headings, shallowest first
    order = 0
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if match:
            level = len(match.group(1))
            parent_id = None
            for depth, node in reversed(stack):
                if depth < level:
                    parent_id = node.section_id
                    break
            order += 1
            section = new_section(
                title=match.group(2).strip(),
                level=min(6, level),
                order=order,
                parent_id=parent_id,
            )
            while stack and stack[-1][0] >= level:
                stack.pop()
            (stack[-1][1].children if stack else roots).append(section)
            stack.append((level, section))
        elif stack:
            stack[-1][1].content.append(
                ContentUnit(kind="paragraph", text=stripped)
            )

    for root in roots:
        count_words(root)
    return roots


# ---------------------------------------------------------------------------
# RunManager — engine calls on daemon threads with cancellation
# ---------------------------------------------------------------------------


@dataclass
class RunHandle:
    run_id: str
    project_id: str
    kind: str  # run | rewrite | merge
    status: str = "running"  # running | done | cancelled | error
    error: str | None = None
    summary: dict = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None

    def cancel(self) -> bool:
        if self.status != "running":
            return False
        self.cancel_event.set()
        return True


class RunManager:
    """Tracks in-flight engine runs; one run per project at a time."""

    def __init__(self, store: Any, engine: EngineLike, hub: EventHub) -> None:
        self.store = store
        self.engine = engine
        self.hub = hub
        self.runs: dict[str, RunHandle] = {}
        self._project_runs: dict[str, str] = {}  # project_id -> active run_id
        self._lock = threading.Lock()

    def get(self, run_id: str) -> RunHandle | None:
        return self.runs.get(run_id)

    def active_for(self, project_id: str) -> RunHandle | None:
        run_id = self._project_runs.get(project_id)
        handle = self.runs.get(run_id) if run_id else None
        return handle if handle is not None and handle.status == "running" else None

    def start(
        self,
        project_id: str,
        kind: str,
        *,
        prompt: str = "",
        section_ids: list[str] | None = None,
        references: list[tuple[str, str]] = (),
        threshold: float | None = None,
    ) -> RunHandle:
        with self._lock:
            active = self.active_for(project_id)
            if active is not None:
                raise RunConflictError(f"project already has a running {active.kind}")
            handle = RunHandle(
                run_id=uuid.uuid4().hex[:12],
                project_id=project_id,
                kind=kind,
            )
            self.runs[handle.run_id] = handle
            self._project_runs[project_id] = handle.run_id

        thread = threading.Thread(
            target=self._worker,
            args=(handle, prompt, section_ids, references, threshold),
            name=f"quill-run-{handle.run_id}",
            daemon=True,
        )
        handle.thread = thread
        self.hub.publish(
            {"type": "run_started", "run_id": handle.run_id, "project_id": project_id, "kind": kind}
        )
        thread.start()
        return handle

    def _worker(
        self,
        handle: RunHandle,
        prompt: str,
        section_ids: list[str] | None,
        references: list[tuple[str, str]],
        threshold: float | None,
    ) -> None:
        project_id = handle.project_id

        def progress(section_id: str, status: str, ratio: float) -> None:
            self.hub.publish(
                {
                    "type": "progress",
                    "run_id": handle.run_id,
                    "project_id": project_id,
                    "section_id": section_id,
                    "status": status,
                    "ratio": round(ratio, 4),
                }
            )

        def stream(section_id: str, text: str) -> None:
            self.hub.publish(
                {
                    "type": "section",
                    "run_id": handle.run_id,
                    "project_id": project_id,
                    "section_id": section_id,
                    "text": text,
                }
            )

        def delta(section_id: str, text: str) -> None:
            self.hub.publish(
                {
                    "type": "delta",
                    "run_id": handle.run_id,
                    "project_id": project_id,
                    "section_id": section_id,
                    "text": text,
                }
            )

        cancel: Callable[[], bool] = handle.cancel_event.is_set
        try:
            if handle.kind == "merge":
                merges = self.engine.merge_similar_sections(
                    project_id,
                    self.store,
                    threshold=threshold,
                    cancel=cancel,
                    progress_cb=progress,
                )
                handle.summary = {"merged": len(merges)}
            elif handle.kind == "restructure":
                before = {
                    s.section_id: s.title
                    for s in walk_sections(self.store.get_sections(project_id))
                }
                results = self.engine.rewrite(
                    project_id,
                    self.store,
                    None,  # no explicit selection -> structural mode
                    prompt=prompt,
                    stream=stream,
                    progress_cb=progress,
                    cancel=cancel,
                    references=references,
                    on_delta=delta,
                )
                after = {
                    s.section_id: s.title
                    for s in walk_sections(self.store.get_sections(project_id))
                }
                summary = _summarize(results)
                summary["added"] = len(set(after) - set(before))
                summary["removed"] = len(set(before) - set(after))
                summary["renamed"] = sum(
                    1 for sid in set(before) & set(after) if before[sid] != after[sid]
                )
                handle.summary = summary
            elif handle.kind == "rewrite":
                results = self.engine.rewrite(
                    project_id,
                    self.store,
                    section_ids or None,
                    prompt=prompt,
                    stream=stream,
                    progress_cb=progress,
                    cancel=cancel,
                    references=references,
                    on_delta=delta,
                )
                handle.summary = _summarize(results)
            elif handle.kind == "format":
                results = self.engine.format_document(
                    project_id,
                    self.store,
                    stream=stream,
                    progress_cb=progress,
                    cancel=cancel,
                    on_delta=delta,
                )
                handle.summary = _summarize(results)
            else:
                results = self.engine.run(
                    project_id,
                    self.store,
                    prompt=prompt,
                    stream=stream,
                    progress_cb=progress,
                    cancel=cancel,
                    references=references,
                    on_delta=delta,
                )
                handle.summary = _summarize(results)
            handle.status = "cancelled" if handle.cancel_event.is_set() else "done"
        except GenerationCancelled:
            handle.status = "cancelled"
        except Exception as exc:  # engine bugs must not kill the server
            logger.exception("run %s failed", handle.run_id)
            handle.status = "error"
            handle.error = str(exc)
        finally:
            self.hub.publish(
                {
                    "type": "run_done",
                    "run_id": handle.run_id,
                    "project_id": project_id,
                    "kind": handle.kind,
                    "status": handle.status,
                    "summary": handle.summary,
                    "error": handle.error,
                }
            )


def _summarize(results: dict[str, GenerationResult]) -> dict[str, int]:
    summary = {"generated": 0, "blocked": 0, "failed": 0, "skipped": 0, "sections": len(results)}
    for result in results.values():
        if result.status == "generated":
            summary["generated"] += 1
        elif result.status == "blocked":
            summary["blocked"] += 1
        elif result.status == "failed":
            summary["failed"] += 1
        else:
            summary["skipped"] += 1
    return summary


class RunConflictError(RuntimeError):
    """Raised when a project already has a run in flight."""
