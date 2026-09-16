"""Shared data contracts for all quill_engine services.

Single source of truth for the shapes exchanged between services
(see .agent/agent.md "Shared Data Contracts"). No service imports
another service's module for its data types — only these.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any


def _new_id(prefix: str) -> str:
    """Generate a namespaced id like ``sec_<32 hex>``."""
    return f"{prefix}_{uuid.uuid4().hex}"


# ---------------------------------------------------------------------------
# Pipeline artifacts
# ---------------------------------------------------------------------------


@dataclass
class Document:
    """Output of DocumentProcessor."""

    markdown_text: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ContentUnit:
    """One raw unit of leaf content: a paragraph or a structured table row.

    ``text`` is the embedding-ready rendering. ``table_data`` is populated
    only when ``kind == "table_row"``.
    """

    text: str
    kind: str = "paragraph"  # "paragraph" | "table_row"
    table_data: dict[str, str] | None = None


@dataclass
class Section:
    """A chapter/subheading node in the parsed document tree.

    Chapters are ``level == 1``, subheadings ``level == 2``. Only leaf
    sections carry ``content``; every section may carry ``description``
    (intro text appearing before its first child).

    ``word_count`` is the total word count of the section's whole subtree
    (description + own content + descendants), computed at parse time. It
    lets the template drive target lengths: a section is rewritten to be
    roughly as long as it was in the source.
    """

    section_id: str
    title: str
    level: int
    order: int
    parent_id: str | None
    description: str = ""
    content: list[ContentUnit] = field(default_factory=list)
    children: list["Section"] = field(default_factory=list)
    word_count: int = 0
    summary: str = ""

    def leaves(self) -> list["Section"]:
        """Yield descendant leaves (including self when already a leaf)."""
        if not self.children:
            return [self]
        out: list[Section] = []
        for child in self.children:
            out.extend(child.leaves())
        return out


@dataclass
class Chunk:
    """A token-bounded slice of a section's content (ChunkingService output)."""

    chunk_id: str
    section_id: str
    text: str
    tokens: int
    kind: str = "paragraph"  # "paragraph" | "table_row"
    table_data: dict[str, str] | None = None


@dataclass
class VectorRecord:
    """An embedding + its origin, ready for persistence.

    ``chunk_id`` is ``None`` for section-header embeddings (used as query
    vectors); ``kind`` distinguishes ``"header"`` from ``"chunk"`` records.
    """

    vector_id: str
    section_id: str
    embedding: list[float]
    model: str
    dim: int
    chunk_id: str | None = None
    kind: str = "chunk"  # "header" | "chunk"


@dataclass
class MergeResult:
    """One merged sibling pair: ``kept`` absorbed ``removed``.

    ``score`` is the header-embedding cosine similarity that triggered the
    merge (kept >= ``config.MERGE_MIN_SIMILARITY``).
    """

    kept_section_id: str
    removed_section_id: str
    score: float


@dataclass
class ScoredChunk:
    """A chunk paired with its similarity score (RetrievalService output).

    ``source_type``/``source_title``/``source_url`` carry provenance for
    every chunk (``"source"`` for the report's own text, ``"web"`` for web
    search, ``"memory"`` for knowledge-graph notes, ``"relation"`` for
    related sections) so the TUI can show where a fact came from.
    """

    chunk_id: str
    section_id: str
    text: str
    similarity: float
    tokens: int
    source_type: str = ""  # "web" | "memory" | "relation" | ""
    source_title: str = ""
    source_url: str = ""


@dataclass
class EvidencePacket:
    """Retrieval result handed to ContextBuilder.

    ``query`` is the task instruction that drove retrieval (the user's
    prompt or the section title); ContextBuilder threads it into the prompt
    so the request drives what gets written.
    """

    section_id: str
    section_title: str
    target_words: int
    style_profile: dict[str, Any]
    chunks: list[ScoredChunk]
    user_notes: str = ""
    query: str = ""
    missing_fields: list[str] = field(default_factory=list)
    section_summaries: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class PromptPackage:
    """Everything WritingService needs — nothing more (no storage/FS)."""

    system_instructions: str
    template: str
    style_profile: dict[str, Any]
    evidence: list[ScoredChunk]
    target_words: int
    missing_fields: list[str] = field(default_factory=list)


@dataclass
class Warning:
    """A structured validation finding. Never raised — always collected."""

    code: str  # "too_short" | "missing_heading" | "placeholder" | "repeated_paragraph" | "ai_tell"
    message: str
    location: str | None = None


@dataclass
class SourceRef:
    """One provenance reference attached to a generation (TUI sources list).

    ``kind`` is where the material came from: ``"web"`` (agentic web
    search), ``"memory"`` (knowledge-graph research notes), or
    ``"relation"`` (a sibling section the relation layer matched).
    """

    title: str
    url: str = ""
    kind: str = ""


@dataclass
class RewriteOp:
    """One rewrite target in a :class:`RestructurePlan`.

    ``section_id`` names an existing section (or a section being added in
    the same plan); ``instruction`` is the per-section rewrite directive,
    falling back to the plan-level instruction when empty.
    """

    section_id: str
    instruction: str = ""


@dataclass
class AddOp:
    """One section to insert in a :class:`RestructurePlan`.

    ``parent_id`` is ``None`` for a top-level chapter; ``after_section_id``
    anchors the new sibling (``None`` appends at the end of that level).
    ``level`` is derived from the parent when omitted.
    """

    title: str
    parent_id: str | None = None
    after_section_id: str | None = None
    level: int | None = None
    description: str = ""
    instruction: str = ""


@dataclass
class RenameOp:
    """Retitle an existing section to fit the topic."""

    section_id: str
    title: str


@dataclass
class RestructurePlan:
    """Structural rewrite plan: which sections to rewrite/add/remove.

    Produced by :func:`md_rewriter.plan_restructure` from a single LLM
    call; validated against the live tree before it is applied. A section
    may appear in at most one list.
    """

    rewrite: list[RewriteOp] = field(default_factory=list)
    add: list[AddOp] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    rename: list[RenameOp] = field(default_factory=list)


@dataclass
class RestructureOutcome:
    """Result of applying a :class:`RestructurePlan`.

    ``rewritten`` maps every changed section (rewritten or newly added) to
    its new generation; ``added``/``removed``/``renamed`` record the
    structural edits so the caller can report them.
    """

    rewritten: dict[str, "GenerationResult"] = field(default_factory=dict)
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    renamed: list[str] = field(default_factory=list)


@dataclass
class GenerationResult:
    """Persisted output of one section (Orchestrator saves these).

    ``status`` is ``"generated"`` on success, ``"blocked"`` when the
    evidence gate rejected the section (missing required fields — never
    written), or ``"failed"`` when the section raised. Orchestrator keeps
    the partial text + error for per-section retry; blocked sections carry
    the missing fields in ``missing_fields`` so the questionnaire can fill
    them and the section can be retried.
    """

    section_id: str
    text: str
    warnings: list[Warning] = field(default_factory=list)
    status: str = "generated"  # "generated" | "blocked" | "failed"
    error: str | None = None
    missing_fields: list[str] = field(default_factory=list)
    sources: list[SourceRef] = field(default_factory=list)
    model: str = ""  # "provider/model" that generated this section


@dataclass
class EvidenceRequirement:
    """One required evidence field for a section (RequirementService).

    ``present`` is True when the source document already covers the field;
    ``answer`` is the user-supplied value (from evidence file or wizard).
    A field is satisfied when ``present`` or ``answer`` is non-empty.
    """

    field: str
    label: str
    present: bool = False
    answer: str = ""


@dataclass
class SearchResult:
    """One web result from the agentic search layer (SearchService).

    ``markdown`` is the fetched page content converted to markdown (when
    the URL was fetched); ``authoritative`` is False for web-sourced
    material so the writer never treats it as a personal fact.
    """

    title: str
    url: str
    snippet: str
    markdown: str = ""
    authoritative: bool = False


@dataclass
class ResearchQuery:
    """One curated search query produced by the Query Curator.

    ``region`` is one of ``config.RESEARCH_REGIONS`` (Nigeria, Africa,
    Europe, America) or "global"; ``kind`` is the question type (what,
    how, why, challenges, ...) so the writing engine can see the shape
    of the research behind a section.
    """

    query: str
    region: str = "global"
    kind: str = "general"


@dataclass
class ResearchPlan:
    """Output of the Query Curator: topic + search queries for a prompt.

    ``angle`` is the per-run unique facet picked from
    ``config.RESEARCH_ANGLES`` (feature 7); ``prompt_links`` are URLs
    extracted from the user's prompt text and merged into the research
    link list (features 3 + 5).
    """

    topic: str
    queries: list[ResearchQuery] = field(default_factory=list)
    angle: str = ""
    prompt_links: list[str] = field(default_factory=list)


@dataclass
class ResearchNote:
    """One knowledge-graph note persisted via basic-memory (features 2 + 6).

    ``content`` is markdown with observations/relations lines; ``source_url``
    records provenance (prompt-supplied link or web-search result) so the writing
    engine can cite where a fact came from.
    """

    title: str
    content: str
    source_url: str = ""
    authoritative: bool = False
    tags: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Construction helpers
# ---------------------------------------------------------------------------


def new_document(markdown_text: str, **metadata: Any) -> Document:
    return Document(markdown_text=markdown_text, metadata=metadata)


def new_section(
    title: str,
    *,
    level: int,
    order: int,
    parent_id: str | None,
    description: str = "",
    content: list[ContentUnit] | None = None,
    children: list[Section] | None = None,
    summary: str = "",
) -> Section:
    return Section(
        section_id=_new_id("sec"),
        title=title,
        level=level,
        order=order,
        parent_id=parent_id,
        description=description,
        content=content or [],
        children=children or [],
        summary=summary,
    )


def new_chunk(section_id: str, text: str, tokens: int, *, kind: str = "paragraph", table_data: dict[str, str] | None = None) -> Chunk:
    return Chunk(
        chunk_id=_new_id("chk"),
        section_id=section_id,
        text=text,
        tokens=tokens,
        kind=kind,
        table_data=table_data,
    )


def new_vector_record(
    section_id: str,
    embedding: list[float],
    *,
    model: str,
    dim: int,
    chunk_id: str | None = None,
    kind: str = "chunk",
) -> VectorRecord:
    return VectorRecord(
        vector_id=_new_id("vec"),
        section_id=section_id,
        embedding=embedding,
        model=model,
        dim=dim,
        chunk_id=chunk_id,
        kind=kind,
    )


# ---------------------------------------------------------------------------
# Tree helpers
# ---------------------------------------------------------------------------


def walk_sections(sections: list[Section]) -> list[Section]:
    """All sections (chapters and descendants) in document order."""
    out: list[Section] = []
    for section in sections:
        out.append(section)
        out.extend(walk_sections(section.children))
    return out


def _extractive_summary(text: str, max_words: int = 60) -> str:
    """First sentences of ``text`` up to ``max_words`` (deterministic)."""
    words: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        for word in sentence.split():
            words.append(word)
            if len(words) >= max_words:
                break
        if len(words) >= max_words:
            break
    return " ".join(words).strip()


def summarize_sections(sections: list[Section], max_words: int = 60) -> None:
    """Fill ``summary`` on every section (mutates in place, no LLM calls).

    Leaf sections summarize their own prose; parents summarize their
    description plus each child's summary, so a chapter's summary reflects
    what its whole subtree covers. Children are summarized before parents
    (reversed pre-order), so a parent's summary can include them.
    Deterministic — safe for tests.
    """
    for section in reversed(walk_sections(sections)):
        parts = [section.description] if section.description.strip() else []
        for unit in section.content:
            if unit.kind == "paragraph" and unit.text.strip():
                parts.append(unit.text)
        for child in section.children:
            if child.summary:
                parts.append(child.summary)
        text = " ".join(parts)
        section.summary = _extractive_summary(text, max_words=max_words) if text.strip() else ""


def count_words(section: Section) -> int:
    """Set ``word_count`` on every node of ``section``'s subtree (bottom-up).

    Returns the total for ``section`` itself (its own words plus every
    descendant). Leaf word counts are the sum of description + content
    units; a chapter's count is the whole chapter, so the template's
    per-section length is preserved for the rewrite.
    """
    total = len(section.description.split())
    for unit in section.content:
        total += len(unit.text.split())
    for child in section.children:
        total += count_words(child)
    section.word_count = total
    return total


def find_section(sections: list[Section], section_id: str) -> Section | None:
    """Look up a section by id anywhere in the tree."""
    for section in walk_sections(sections):
        if section.section_id == section_id:
            return section
    return None


def renumber_orders(sections: list[Section]) -> None:
    """Assign sequential ``order`` to every sibling group, in place."""
    for index, section in enumerate(sections):
        section.order = index + 1
        renumber_orders(section.children)


def remove_section(sections: list[Section], section_id: str) -> bool:
    """Remove ``section_id`` (with its subtree) from the tree; returns True
    when found. Renumbers orders afterwards. Mutates ``sections`` in place.
    """
    for index, section in enumerate(sections):
        if section.section_id == section_id:
            del sections[index]
            renumber_orders(sections)
            return True
        if remove_section(section.children, section_id):
            renumber_orders(section.children)
            return True
    return False


def insert_section(
    sections: list[Section],
    section: Section,
    *,
    parent_id: str | None = None,
    after_section_id: str | None = None,
) -> bool:
    """Insert ``section`` under ``parent_id`` (None = top level), after
    ``after_section_id`` (None = append). Returns False when the parent or
    anchor is unknown. Renumbers orders afterwards. Mutates in place.
    """
    if parent_id is None:
        siblings = sections
    else:
        parent = find_section(sections, parent_id)
        if parent is None:
            return False
        siblings = parent.children

    if after_section_id is None:
        siblings.append(section)
    else:
        for index, sibling in enumerate(siblings):
            if sibling.section_id == after_section_id:
                siblings.insert(index + 1, section)
                break
        else:
            return False

    renumber_orders(siblings)
    return True
