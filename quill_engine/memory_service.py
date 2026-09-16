"""Service — MemoryService: knowledge-graph memory for research (features 2 + 6).

Research notes are persisted as basic-memory-format markdown entities —
YAML frontmatter (title, tags, source URL, authority flag) plus ``[[wikilink]]``
relations — under ``config.MEMORY_DATA_DIR``. This is basic-memory's native
on-disk format, so every note is a first-class entity in a basic-memory
workspace (openable/queryable there); this wrapper provides the sync,
never-raising bridge the pipeline needs without depending on basic-memory's
FastAPI/async DI container.

Layout: ``<MEMORY_DATA_DIR>/<project_id>/<slug>.md`` plus a ``_plan.md``
memo per project recording the run's unique angle.

Every public function degrades gracefully: when memory is disabled,
unwritable, or broken, saves become no-ops (return 0 / False) and searches
return empty lists — the research phase never fails because of memory.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

from . import config
from .models import ResearchNote, ResearchPlan

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"[^A-Za-z0-9_-]+")
_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
    "is", "are", "was", "were", "what", "how", "why", "as", "at", "by",
    "from", "it", "its", "this", "that", "these", "those", "about", "their",
}


def enabled() -> bool:
    """Whether the knowledge-graph memory is switched on."""
    return config.MEMORY_ENABLED


def _memory_root() -> Path | None:
    """Resolve (and create) the memory root dir; None when unavailable."""
    if not enabled():
        return None
    try:
        root = Path(os.path.expanduser(config.MEMORY_DATA_DIR))
        root.mkdir(parents=True, exist_ok=True)
        return root
    except OSError as exc:
        logger.warning("memory root unavailable (%s): %s", config.MEMORY_DATA_DIR, exc)
        return None


def _project_dir(project_id: str) -> Path | None:
    root = _memory_root()
    if root is None:
        return None
    project_dir = root / project_id
    try:
        project_dir.mkdir(parents=True, exist_ok=True)
        return project_dir
    except OSError as exc:
        logger.warning("memory project dir unavailable: %s", exc)
        return None


def _slug(title: str) -> str:
    slug = _SLUG_RE.sub("-", title.strip().lower()).strip("-")
    return slug[:80] or "note"


def _frontmatter(note: ResearchNote, project_id: str) -> str:
    tags = ", ".join(note.tags) or "research"
    return (
        "---\n"
        f"title: {note.title}\n"
        f"type: research-note\n"
        f"project: {project_id}\n"
        f"tags: [{tags}]\n"
        f"source_url: {note.source_url}\n"
        f"authoritative: {'true' if note.authoritative else 'false'}\n"
        "---\n"
    )


def save_research(project_id: str, plan: ResearchPlan, notes: list[ResearchNote]) -> int:
    """Persist a plan + notes to the knowledge graph; returns count written.

    Writes one markdown entity per note and a ``_plan.md`` memo (topic +
    unique angle). Never raises — counts only the notes actually written.
    """
    project_dir = _project_dir(project_id)
    if project_dir is None:
        return 0

    written = 0
    for note in notes:
        try:
            path = project_dir / f"{_slug(note.title)}.md"
            body = _frontmatter(note, project_id) + "\n" + note.content.strip() + "\n"
            if note.tags:
                body += "\n" + "".join(f"[[{tag}]] " for tag in note.tags).strip() + "\n"
            path.write_text(body, encoding="utf-8")
            written += 1
        except OSError as exc:
            logger.warning("memory write failed for %r: %s", note.title, exc)

    try:
        memo = (
            "---\ntitle: Research Plan Memo\ntype: plan-memo\n"
            f"project: {project_id}\n---\n\n"
            f"# {plan.topic}\n\n- angle: {plan.angle}\n"
            f"- queries: {len(plan.queries)}\n- links: {len(plan.prompt_links)}\n"
        )
        (project_dir / "_plan.md").write_text(memo, encoding="utf-8")
    except OSError as exc:
        logger.warning("memory plan memo write failed: %s", exc)

    logger.info("memory: saved %d/%d research notes for project %s", written, len(notes), project_id)
    return written


def search_context(query: str, limit: int = 5, project_id: str | None = None) -> list[str]:
    """Contents of the notes :func:`search_notes` finds (API compat)."""
    return [note.content for note in search_notes(query, limit=limit, project_id=project_id)]


def search_notes(
    query: str, limit: int = 5, project_id: str | None = None
) -> list[ResearchNote]:
    """Keyword-rank notes by relevance to ``query``; returns full notes.

    Same scoring as the old :func:`search_context` (>= 2 matching terms,
    title hits count double, scoped to ``project_id`` when given) but
    parses each note's frontmatter back so callers keep provenance
    (title + source URL) for the TUI sources display. The ``_plan.md``
    memo is not a research note and is skipped. Never raises.
    """
    root = _memory_root()
    if root is None or not query:
        return []

    terms = [t for t in re.split(r"[^A-Za-z0-9]+", query.lower()) if t and t not in _STOPWORDS]
    if not terms:
        return []

    if project_id:
        search_dir = root / project_id
        if not search_dir.is_dir():
            return []
    else:
        search_dir = root

    scored: list[tuple[float, ResearchNote]] = []
    try:
        files = list(search_dir.rglob("*.md"))
    except OSError as exc:
        logger.warning("memory search failed: %s", exc)
        return []

    for path in files:
        if path.stem == "_plan":
            continue
        note = _read_note(path)
        if note is None or not note.content.strip():
            continue
        hay = note.content.lower()
        score = sum(1 for t in terms if t in hay)
        # Title hits count double (title line is repeated in frontmatter too,
        # but we already stripped it — re-check the filename for the title).
        if any(t in path.stem.lower() for t in terms):
            score += 2
        if score >= 2:
            scored.append((float(score), note))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [note for _, note in scored[:limit]]


def _read_note(path: Path) -> ResearchNote | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    title, source_url, authoritative = "", "", False
    tags: list[str] = []
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            body = parts[2]
            for line in parts[1].splitlines():
                if line.startswith("title:"):
                    title = line.split(":", 1)[1].strip()
                elif line.startswith("source_url:"):
                    source_url = line.split(":", 1)[1].strip()
                elif line.startswith("authoritative:"):
                    authoritative = line.split(":", 1)[1].strip().lower() == "true"
                elif line.startswith("tags:"):
                    raw = line.split(":", 1)[1].strip().strip("[]")
                    tags = [t.strip() for t in raw.split(",") if t.strip()]
    return ResearchNote(
        title=title or path.stem,
        content=body.strip(),
        source_url=source_url,
        authoritative=authoritative,
        tags=tags,
    )


def remember_angle(project_id: str, angle: str) -> bool:
    """Persist the run's unique angle for later recall (feature 7 continuity).

    Writes ``<project>/_angle.txt``. Returns False when memory is off or
    the write fails — callers treat that as "no memoization".
    """
    project_dir = _project_dir(project_id)
    if project_dir is None or not angle:
        return False
    try:
        (project_dir / "_angle.txt").write_text(angle, encoding="utf-8")
        return True
    except OSError as exc:
        logger.warning("memory angle memo write failed: %s", exc)
        return False


def recall_angle(project_id: str) -> str:
    """Recall the angle remembered for a project ("" when none/unavailable)."""
    project_dir = _project_dir(project_id)
    if project_dir is None:
        return ""
    try:
        path = project_dir / "_angle.txt"
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except OSError:
        return ""


def _strip_frontmatter(text: str) -> str:
    """Remove a leading ``---`` YAML block from a note's markdown."""
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            return parts[2]
    return text
