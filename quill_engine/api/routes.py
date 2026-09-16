"""REST endpoints for the GUI (mounted under /api)."""

from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from .. import config, providers, validation_service
from ..export_service import ExportError, export, preview, render_document
from ..models import GenerationResult, find_section, walk_sections
from . import schemas
from .state import (
    DRAFT_ID,
    RunConflictError,
    RunManager,
    Registry,
    build_tree,
    count_statuses,
    create_section,
    delete_section,
    is_draft_skeleton,
    read_history,
    rename_section,
    restore_history_entry,
    save_manual_text,
    snapshot_history,
    sync_draft_writeback,
)

api_router = APIRouter(prefix="/api")


def _state(request: Request) -> tuple[Registry, RunManager]:
    return request.app.state.registry, request.app.state.runs


def _require_project(registry: Registry, project_id: str):
    state = registry.get(project_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"unknown project: {project_id}")
    return state


# -- health ---------------------------------------------------------------


@api_router.get("/health", response_model=schemas.HealthOut)
def health(request: Request) -> schemas.HealthOut:
    registry, _ = _state(request)
    provider_out = []
    for provider in providers.chain():
        ready = bool(provider.api_key) or not getattr(provider, "requires_key", True)
        provider_out.append(
            schemas.ProviderOut(name=provider.name, model=provider.model, ready=ready)
        )
    return schemas.HealthOut(
        store=type(registry.store).__name__,
        research_enabled=config.RESEARCH_ENABLED,
        providers=provider_out,
    )


# -- projects --------------------------------------------------------------


@api_router.get("/projects")
def list_projects(request: Request) -> list[dict]:
    registry, _ = _state(request)
    return registry.list_recent()


@api_router.post("/projects/open", response_model=schemas.ProjectOut)
async def open_project(body: schemas.OpenRequest, request: Request) -> schemas.ProjectOut:
    registry, _ = _state(request)
    if not os.path.isfile(body.file_path):
        raise HTTPException(status_code=400, detail=f"file not found: {body.file_path}")
    try:
        # Ingest loads the embedding model on first use; keep it off the loop.
        state = await run_in_threadpool(registry.open, body.file_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"ingest failed: {exc}") from exc
    request.app.state.hub.publish(
        {"type": "ingest_done", "project_id": state.project_id}
    )
    return _project_out(registry, state.project_id)


@api_router.post("/projects/new", response_model=schemas.ProjectOut)
def new_project(body: schemas.NewProjectRequest, request: Request) -> schemas.ProjectOut:
    registry, _ = _state(request)
    state = registry.create(body.title)
    return _project_out(registry, state.project_id)


@api_router.patch("/projects/{project_id}/rename", response_model=schemas.ProjectOut)
def rename_project(project_id: str, body: schemas.SectionRename, request: Request):
    registry, _ = _state(request)
    _require_project(registry, project_id)
    if not registry.update_title(project_id, body.title):
        raise HTTPException(status_code=404, detail=f"unknown project: {project_id}")
    request.app.state.hub.publish(
        {"type": "tree_changed", "project_id": project_id}
    )
    return _project_out(registry, project_id)


@api_router.get("/projects/{project_id}", response_model=schemas.ProjectOut)
def get_project(project_id: str, request: Request) -> schemas.ProjectOut:
    registry, _ = _state(request)
    _require_project(registry, project_id)
    return _project_out(registry, project_id)


@api_router.delete("/projects/{project_id}")
def delete_project(project_id: str, request: Request) -> dict:
    registry, _ = _state(request)
    _require_project(registry, project_id)
    registry.store.delete_project(project_id)
    registry.projects.pop(project_id, None)
    request.app.state.hub.publish({"type": "project_deleted", "project_id": project_id})
    return {"ok": True}


def _project_out(registry: Registry, project_id: str) -> schemas.ProjectOut:
    state = registry.get(project_id)
    sections = registry.store.get_sections(project_id)
    counts = count_statuses(sections, registry.store, project_id)
    meta = schemas.ProjectMeta(
        project_id=project_id,
        title=state.title,
        file_path=state.file_path,
        section_count=sum(1 for _ in walk_sections(sections)),
        generated=counts["generated"],
        blocked=counts["blocked"],
        failed=counts["failed"],
        pending=counts["pending"],
        total_words=counts["total_words"],
    )
    return schemas.ProjectOut(meta=meta, tree=build_tree(sections, registry.store, project_id))


# -- sections ---------------------------------------------------------------


@api_router.get(
    "/projects/{project_id}/sections/{section_id}", response_model=schemas.SectionDetail
)
def get_section(project_id: str, section_id: str, request: Request) -> schemas.SectionDetail:
    registry, _ = _state(request)
    _require_project(registry, project_id)
    section = find_section(registry.store.get_sections(project_id), section_id)
    if section is None:
        raise HTTPException(status_code=404, detail=f"unknown section: {section_id}")
    return _section_detail(registry, project_id, section)


def _section_detail(registry: Registry, project_id: str, section) -> schemas.SectionDetail:
    result = registry.store.get_generation(project_id, section.section_id)
    text = result.text if result is not None and result.text else " ".join(
        unit.text for unit in section.content
    )
    return schemas.SectionDetail(
        section_id=section.section_id,
        title=section.title,
        level=section.level,
        description=section.description,
        text=text,
        status="pending" if result is None else result.status,
        warnings=[
            schemas.WarningOut(code=w.code, message=w.message, location=w.location)
            for w in (result.warnings if result is not None else [])
        ],
        sources=[
            schemas.SourceRefOut(title=s.title, url=s.url, kind=s.kind)
            for s in (result.sources if result is not None else [])
        ],
        missing_fields=list(result.missing_fields) if result is not None else [],
        model=result.model if result is not None else "",
    )


@api_router.put(
    "/projects/{project_id}/sections/{section_id}", response_model=schemas.SectionDetail
)
def save_section(
    project_id: str,
    section_id: str,
    body: schemas.SectionSave,
    request: Request,
) -> schemas.SectionDetail:
    registry, _ = _state(request)
    _require_project(registry, project_id)
    section = find_section(registry.store.get_sections(project_id), section_id)
    if section is None:
        raise HTTPException(status_code=404, detail=f"unknown section: {section_id}")
    snapshot_history(registry.store, project_id, "before manual edit")
    result = save_manual_text(registry.store, project_id, section_id, body.text)
    request.app.state.hub.publish(
        {"type": "section_saved", "project_id": project_id, "section_id": section_id}
    )
    return schemas.SectionDetail(
        section_id=section.section_id,
        title=section.title,
        level=section.level,
        description=section.description,
        text=result.text,
        status=result.status,
        warnings=[
            schemas.WarningOut(code=w.code, message=w.message, location=w.location)
            for w in result.warnings
        ],
        model=result.model,
    )


@api_router.post("/validate", response_model=list[schemas.WarningOut])
def validate(body: schemas.ValidateRequest) -> list[schemas.WarningOut]:
    warnings = validation_service.check(
        body.section_id, body.text, min_words=body.min_words or config.MIN_SECTION_WORDS
    )
    return [
        schemas.WarningOut(code=w.code, message=w.message, location=w.location)
        for w in warnings
    ]


# -- section tree mutations ---------------------------------------------------


@api_router.post("/projects/{project_id}/sections", response_model=schemas.TreeOut)
def add_section(
    project_id: str, body: schemas.SectionCreate, request: Request
) -> schemas.TreeOut:
    registry, runs = _state(request)
    _require_project(registry, project_id)
    if runs.active_for(project_id) is not None:
        raise HTTPException(status_code=409, detail="cannot edit the outline during a run")
    section = create_section(
        registry.store,
        project_id,
        title=body.title.strip() or "Untitled section",
        parent_id=body.parent_id,
        after_section_id=body.after_section_id,
    )
    request.app.state.hub.publish(
        {"type": "tree_changed", "project_id": project_id, "section_id": section.section_id}
    )
    return schemas.TreeOut(
        project_id=project_id,
        section_id=section.section_id,
        project=_project_out(registry, project_id),
    )


@api_router.put("/projects/{project_id}/freewrite", response_model=schemas.TreeOut)
def freewrite(
    project_id: str, body: schemas.FreewriteRequest, request: Request
) -> schemas.TreeOut:
    """Persist the whole-document draft as plain text.

    The markdown is stored verbatim under the ``__draft__`` pseudo-section
    (the draft view's WYSIWYG source) and synced back onto the section tree
    via ``sync_draft_writeback``: each heading's body lands in the matching
    tree section, so prose written under a header in the whole-document mode
    appears in that section. Headings that match no section stay draft-only
    text. Returns the project with the updated tree.
    """
    registry, runs = _state(request)
    _require_project(registry, project_id)
    if runs.active_for(project_id) is not None:
        raise HTTPException(status_code=409, detail="cannot edit the draft during a run")

    registry.store.save_generation(
        project_id,
        DRAFT_ID,
        GenerationResult(
            section_id=DRAFT_ID,
            text=body.markdown,
            status="generated",
            model="manual",
        ),
    )
    sync_draft_writeback(registry.store, project_id, body.markdown)
    request.app.state.hub.publish({"type": "draft_changed", "project_id": project_id})
    return schemas.TreeOut(project_id=project_id, project=_project_out(registry, project_id))


@api_router.get("/projects/{project_id}/draft", response_model=schemas.PreviewOut)
async def draft(
    project_id: str, request: Request
) -> schemas.PreviewOut:
    """Return the whole-document draft text.

    Prefers the saved ``__draft__`` blob; when none has ever been saved (a
    project built from imports/AI runs), falls back to the assembled preview
    so the whole-document view still shows the full text. A blob that is
    only a heading skeleton (no body lines) is stale — the live tree holds
    the real content, so it is assembled instead.
    """
    registry, _ = _state(request)
    state = _require_project(registry, project_id)
    result = registry.store.get_generation(project_id, DRAFT_ID)
    if result is not None and result.text:
        if is_draft_skeleton(result.text):
            markdown = await run_in_threadpool(render_document, project_id, registry.store)
            if len(markdown) > len(result.text):
                return schemas.PreviewOut(markdown=markdown)
        return schemas.PreviewOut(markdown=result.text)
    try:
        markdown = await run_in_threadpool(preview, project_id, registry.store, title=None)
    except ExportError:
        markdown = ""
    return schemas.PreviewOut(markdown=markdown)


@api_router.put(
    "/projects/{project_id}/sections/{section_id}/rename", response_model=schemas.TreeOut
)
def rename(project_id: str, section_id: str, body: schemas.SectionRename, request: Request):
    registry, runs = _state(request)
    _require_project(registry, project_id)
    if runs.active_for(project_id) is not None:
        raise HTTPException(status_code=409, detail="cannot edit the outline during a run")
    if rename_section(registry.store, project_id, section_id, body.title) is None:
        raise HTTPException(status_code=404, detail=f"unknown section: {section_id}")
    request.app.state.hub.publish(
        {"type": "tree_changed", "project_id": project_id, "section_id": section_id}
    )
    return schemas.TreeOut(project_id=project_id, project=_project_out(registry, project_id))


@api_router.delete("/projects/{project_id}/sections/{section_id}", response_model=schemas.TreeOut)
def remove(project_id: str, section_id: str, request: Request):
    registry, runs = _state(request)
    _require_project(registry, project_id)
    if runs.active_for(project_id) is not None:
        raise HTTPException(status_code=409, detail="cannot edit the outline during a run")
    if not delete_section(registry.store, project_id, section_id):
        raise HTTPException(status_code=404, detail=f"unknown section: {section_id}")
    request.app.state.hub.publish(
        {"type": "tree_changed", "project_id": project_id, "section_id": section_id}
    )
    return schemas.TreeOut(project_id=project_id, project=_project_out(registry, project_id))


# -- version history ------------------------------------------------------------


@api_router.get("/projects/{project_id}/history")
def get_history(project_id: str, request: Request):
    registry, _ = _state(request)
    _require_project(registry, project_id)
    history = read_history(project_id)
    # lean payload: no full texts in the list view
    return [
        {
            "ts": entry["ts"],
            "label": entry["label"],
            "sections": [
                {"section_id": item["section_id"], "title": item["title"], "model": item["model"]}
                for item in entry["sections"]
            ],
        }
        for entry in history
    ]


@api_router.get("/projects/{project_id}/history/entry")
def get_history_entry(project_id: str, request: Request, ts: float):
    registry, _ = _state(request)
    _require_project(registry, project_id)
    for entry in read_history(project_id):
        if abs(entry.get("ts", 0) - ts) <= 1e-6:
            return entry
    raise HTTPException(status_code=404, detail="history entry not found")


@api_router.post("/projects/{project_id}/history/restore")
async def restore_history(project_id: str, request: Request, ts: float, section_id: str | None = None):
    registry, _ = _state(request)
    _require_project(registry, project_id)
    restored = await run_in_threadpool(
        restore_history_entry, registry.store, project_id, ts, section_id
    )
    if not restored:
        raise HTTPException(status_code=404, detail="history entry not found")
    request.app.state.hub.publish(
        {"type": "tree_changed", "project_id": project_id}
    )
    return _project_out(registry, project_id)


# -- model selection ------------------------------------------------------------


@api_router.get("/models")
async def list_models():
    """Selectable models per provider: Ollama's installed tags, and live
    OpenAI-compatible ``/models`` lists for everyone else, falling back to
    the pinned model when an endpoint is unreachable or unauth'd."""
    def _ollama_models() -> list[str]:
        import httpx

        try:
            response = httpx.get(
                "http://localhost:11434/api/tags", timeout=3.0
            )
            data = response.json()
            return sorted(m.get("name", "") for m in data.get("models", []) if m.get("name"))
        except Exception:
            return []

    ollama_tags = await run_in_threadpool(_ollama_models)
    selection = providers.current_selection()
    entries = []
    for provider in providers.chain():
        if provider.name == "ollama":
            models = ollama_tags
        else:
            models = await run_in_threadpool(
                providers.fetch_provider_models,
                provider.base_url,
                provider.api_key or "",
            )
            if not models:
                models = [provider.model]
        entries.append(
            {
                "name": provider.name,
                "base_url": provider.base_url,
                "model": providers._model_overrides.get(provider.name, provider.model),
                "models": models,
                "ready": bool(provider.api_key) or not provider.requires_key,
                "local": provider.name in providers.LOCAL_PROVIDERS,
                "builtin": provider.name in providers.PROVIDER_DEFS,
                "in_file": provider.name in providers.file_providers(),
            }
        )
    return {
        "current": {"name": selection[0], "model": selection[1]} if selection else None,
        "providers": entries,
    }


@api_router.post("/models/select")
async def select_model(body: schemas.ModelSelect):
    if body.name not in providers.all_providers():
        raise HTTPException(status_code=404, detail=f"unknown provider: {body.name}")
    await run_in_threadpool(providers.set_model_selection, body.name, body.model)
    selection = providers.current_selection()
    return {"ok": True, "current": {"name": selection[0], "model": selection[1]}}


@api_router.post("/models/configure")
async def configure_provider(body: schemas.ProviderConfigure):
    """Persist a bring-your-own-key provider and return its live models."""
    name = body.name.strip().lower()
    base_url = body.base_url.strip().rstrip("/")
    if not name or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for ch in name):
        raise HTTPException(status_code=400, detail=f"invalid provider name: {body.name!r}")
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="base_url must be an http(s) URL")
    await run_in_threadpool(
        providers.save_custom_provider, name, base_url, body.api_key, body.model
    )
    models = await run_in_threadpool(
        providers.fetch_provider_models, base_url, body.api_key
    )
    await run_in_threadpool(
        providers.set_model_selection, name, body.model or (models[0] if models else "default")
    )
    return {"ok": True, "name": name, "models": models}


@api_router.delete("/models/{name}")
async def delete_provider(name: str):
    """Remove a provider's saved config-file entry.

    Providers connected via ``/models/configure`` are stored in the
    providers config file; DELETE removes that entry. A built-in name (e.g.
    ``openrouter``) with a saved entry falls back to its hard-coded defaults
    instead of disappearing. 404 when nothing was saved for the name.
    """
    name = name.strip().lower()
    removed = await run_in_threadpool(providers.remove_custom_provider, name)
    if not removed:
        raise HTTPException(status_code=404, detail=f"no saved provider entry: {name}")
    return {"ok": True, "name": name}


# -- AI autocomplete ----------------------------------------------------------


@api_router.post("/complete", response_model=schemas.CompleteOut)
async def complete(body: schemas.CompleteRequest) -> schemas.CompleteOut:
    """Short inline continuation for the editor's ghost suggestions."""
    before = body.text_before[-1200:]

    def _call() -> str:
        last_error: Exception | None = None
        for provider in providers.active_chain():
            try:
                text = providers.complete(
                    provider,
                    [
                        {
                            "role": "system",
                            "content": (
                                "You are a writing autocomplete. Continue the user's "
                                "text with at most one short sentence. Match tone and "
                                "language. Output ONLY the continuation — never repeat "
                                "existing text. No preamble."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                f"{before}\n\n(Cursor is here. Continue naturally.)"
                                if not body.text_after
                                else (
                                    f"<before>\n{before}\n</before>\n"
                                    f"<after>\n{body.text_after[:400]}\n</after>\n\n"
                                    "Write the text that belongs between the markers."
                                )
                            ),
                        },
                    ],
                    temperature=0.4,
                    max_tokens=body.max_tokens,
                )
                text = text.strip().strip('"')
                return text.split("\n")[0].strip()
            except Exception as exc:  # try the next provider in the chain
                last_error = exc
        raise HTTPException(
            status_code=503,
            detail=f"no LLM provider available: {last_error}",
        )

    completion = await run_in_threadpool(_call)
    return schemas.CompleteOut(completion=completion)


# -- runs (generate / rewrite / merge) --------------------------------------


@api_router.post("/projects/{project_id}/run", status_code=202, response_model=schemas.RunHandleOut)
def start_run(body: schemas.RunRequest, project_id: str, request: Request) -> schemas.RunHandleOut:
    _, runs = _state(request)
    handle = _start(request, runs, project_id, "run", prompt=body.prompt,
                    section_ids=body.section_ids, references=body.references)
    return _run_out(handle)


def _run_out(handle) -> schemas.RunHandleOut:
    return schemas.RunHandleOut(
        run_id=handle.run_id,
        project_id=handle.project_id,
        kind=handle.kind,
        status=handle.status,
        error=handle.error,
        summary=handle.summary,
    )


@api_router.post("/projects/{project_id}/rewrite", status_code=202, response_model=schemas.RunHandleOut)
def start_rewrite(body: schemas.RewriteRequest, project_id: str, request: Request) -> schemas.RunHandleOut:
    _, runs = _state(request)
    handle = _start(request, runs, project_id, "rewrite", prompt=body.instruction,
                    section_ids=body.section_ids, references=body.references)
    return _run_out(handle)


@api_router.post("/projects/{project_id}/restructure", status_code=202, response_model=schemas.RunHandleOut)
def start_restructure(body: schemas.RestructureRequest, project_id: str, request: Request) -> schemas.RunHandleOut:
    """Structural rewrite: the planner may add/rename/remove sections, not
    just rewrite existing ones — driven solely by the instruction."""
    _, runs = _state(request)
    handle = _start(request, runs, project_id, "restructure", prompt=body.instruction,
                    references=body.references)
    return _run_out(handle)


@api_router.post("/projects/{project_id}/merge", status_code=202, response_model=schemas.RunHandleOut)
def start_merge(body: schemas.MergeRequest, project_id: str, request: Request) -> schemas.RunHandleOut:
    _, runs = _state(request)
    handle = _start(request, runs, project_id, "merge", threshold=body.threshold)
    return _run_out(handle)


@api_router.post("/projects/{project_id}/format", status_code=202, response_model=schemas.RunHandleOut)
def start_format(project_id: str, request: Request) -> schemas.RunHandleOut:
    """Reformat every section in place (content-preserving, no research)."""
    _, runs = _state(request)
    handle = _start(request, runs, project_id, "format")
    return _run_out(handle)


def _start(request: Request, runs: RunManager, project_id: str, kind: str, **kwargs):
    registry, _ = _state(request)
    _require_project(registry, project_id)
    snapshot_history(registry.store, project_id, f"before {kind}")
    try:
        return runs.start(project_id, kind, **kwargs)
    except RunConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@api_router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str, request: Request) -> dict:
    _, runs = _state(request)
    handle = runs.get(run_id)
    if handle is None:
        raise HTTPException(status_code=404, detail=f"unknown run: {run_id}")
    return {"ok": handle.cancel()}


@api_router.get("/runs/{run_id}", response_model=schemas.RunHandleOut)
def get_run(run_id: str, request: Request) -> schemas.RunHandleOut:
    _, runs = _state(request)
    handle = runs.get(run_id)
    if handle is None:
        raise HTTPException(status_code=404, detail=f"unknown run: {run_id}")
    return _run_out(handle)


# -- evidence ----------------------------------------------------------------


@api_router.get("/projects/{project_id}/evidence")
def get_evidence(project_id: str, request: Request) -> dict:
    registry, _ = _state(request)
    _require_project(registry, project_id)
    return registry.store.get_evidence(project_id)


@api_router.post("/projects/{project_id}/evidence")
def save_evidence(body: schemas.EvidenceSave, project_id: str, request: Request) -> dict:
    registry, _ = _state(request)
    _require_project(registry, project_id)
    registry.store.save_evidence(project_id, body.answers)
    request.app.state.hub.publish({"type": "evidence_saved", "project_id": project_id})
    return {"ok": True, "count": len(body.answers)}


# -- export / preview ----------------------------------------------------------


@api_router.get("/projects/{project_id}/export")
async def export_project(
    project_id: str,
    request: Request,
    fmt: str = "md",
    title: str | None = None,
    download: int = 0,
    out_path: str | None = None,
):
    registry, _ = _state(request)
    state = _require_project(registry, project_id)
    try:
        path = await run_in_threadpool(
            export,
            project_id,
            registry.store,
            fmt="markdown" if fmt in {"md", "markdown"} else fmt,
            title=title or state.title,
            out_path=out_path,
        )
    except ExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not download:
        return schemas.ExportOut(path=path, format=fmt)
    media = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if fmt == "docx"
        else "application/pdf" if fmt == "pdf" else "text/markdown"
    )
    return FileResponse(path, filename=os.path.basename(path), media_type=media)


@api_router.get("/projects/{project_id}/preview", response_model=schemas.PreviewOut)
async def preview_project(
    project_id: str, request: Request, title: str | None = None, with_title: int = 1
):
    registry, _ = _state(request)
    state = _require_project(registry, project_id)
    try:
        markdown = await run_in_threadpool(
            preview,
            project_id,
            registry.store,
            title=(title or state.title) if with_title else None,
        )
    except ExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return schemas.PreviewOut(markdown=markdown)
