"""Pydantic mirrors of the engine dataclasses sent over the API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class WarningOut(BaseModel):
    code: str
    message: str
    location: str = ""


class SourceRefOut(BaseModel):
    title: str
    url: str = ""
    kind: str = ""


class SectionNode(BaseModel):
    """One node of the section tree shown in the GUI sidebar."""

    section_id: str
    title: str
    level: int
    order: int
    status: str = "pending"  # generated | blocked | failed | pending
    word_count: int = 0  # words of the current text (generation or template)
    target_words: int = 0  # template's subtree word count (length target)
    warning_count: int = 0
    children: list[SectionNode] = Field(default_factory=list)


class SectionDetail(BaseModel):
    """Full payload for one opened section (editor pane)."""

    section_id: str
    title: str
    level: int
    description: str = ""
    text: str = ""
    status: str = "pending"
    warnings: list[WarningOut] = Field(default_factory=list)
    sources: list[SourceRefOut] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
    model: str = ""


class ProjectMeta(BaseModel):
    project_id: str
    title: str
    file_path: str | None = None
    section_count: int = 0
    generated: int = 0
    blocked: int = 0
    failed: int = 0
    pending: int = 0
    total_words: int = 0


class ProjectOut(BaseModel):
    meta: ProjectMeta
    tree: list[SectionNode]


class SectionSave(BaseModel):
    text: str


class ValidateRequest(BaseModel):
    section_id: str = ""
    text: str
    min_words: int | None = None


class OpenRequest(BaseModel):
    file_path: str


class NewProjectRequest(BaseModel):
    title: str = "Untitled"


class RunRequest(BaseModel):
    prompt: str = ""
    section_ids: list[str] | None = None
    references: list[tuple[str, str]] = Field(default_factory=list)


class RewriteRequest(BaseModel):
    instruction: str = ""
    section_ids: list[str] = Field(default_factory=list)
    references: list[tuple[str, str]] = Field(default_factory=list)


class RestructureRequest(BaseModel):
    """Structural rewrite: the planner may add/rename/remove sections, not
    just rewrite existing ones — driven solely by the instruction."""

    instruction: str = ""
    references: list[tuple[str, str]] = Field(default_factory=list)


class MergeRequest(BaseModel):
    threshold: float | None = None


class RunHandleOut(BaseModel):
    run_id: str
    project_id: str
    kind: str  # run | rewrite | merge | restructure | format
    status: str  # running | done | cancelled | error
    error: str | None = None
    summary: dict = Field(default_factory=dict)


class EvidenceSave(BaseModel):
    answers: dict[str, str]


class SectionCreate(BaseModel):
    title: str
    parent_id: str | None = None
    after_section_id: str | None = None


class SectionRename(BaseModel):
    title: str


class FreewriteRequest(BaseModel):
    """Whole-document markdown draft (Google-Docs style freewrite)."""

    markdown: str


class TreeOut(BaseModel):
    project_id: str
    section_id: str | None = None
    project: ProjectOut


class ModelSelect(BaseModel):
    name: str
    model: str | None = None


class CompleteRequest(BaseModel):
    text_before: str
    text_after: str = ""
    max_tokens: int = 48


class CompleteOut(BaseModel):
    completion: str


class ExportOut(BaseModel):
    path: str
    format: str


class PreviewOut(BaseModel):
    markdown: str


class ProviderOut(BaseModel):
    name: str
    model: str
    ready: bool  # has a key when required / is local


class ProviderConfigure(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    model: str | None = None


class HealthOut(BaseModel):
    status: str = "ok"
    store: str
    research_enabled: bool
    providers: list[ProviderOut] = Field(default_factory=list)
