"""Tests for the GUI API sidecar (quill_engine.api).

Hermetic by construction: an in-memory store plus a fake engine
(same seam the TUI tests use via ``FakeRunner``), so no LLM, embedding
model, or filesystem ingest is ever touched.
"""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from quill_engine.api.server import create_app
from quill_engine.models import ContentUnit, GenerationResult, new_section, walk_sections
from quill_engine.orchestrator import _project_id_for
from quill_engine.storage import InMemoryStore


class FakeEngine:
    """Deterministic orchestrator stand-in.

    ``run`` writes a generated result per section, emits progress + stream
    callbacks, and blocks on ``gate`` so tests can exercise cancel/conflict
    paths deterministically.
    """

    def __init__(self) -> None:
        self.gate = threading.Event()
        self.gate.set()
        self.ran = threading.Event()

    def ingest(self, file_path, store, *, embed=True, structure_only=False):
        project_id = _project_id_for(file_path)
        chapter = new_section("Chapter One", level=1, order=1, parent_id=None)
        chapter.content = [ContentUnit(text="template body words")]
        chapter.children = [
            new_section(
                "1.1 Background",
                level=2,
                order=1,
                parent_id=chapter.section_id,
            )
        ]
        store.save_sections(project_id, [chapter])
        return project_id

    def run(self, project_id, store, **kwargs):
        self.ran.set()
        assert self.gate.wait(timeout=5), "gate never opened"
        for section in walk_sections(store.get_sections(project_id)):
            result = GenerationResult(
                section_id=section.section_id,
                text=f"Generated: {section.title}",
                status="generated",
                model="fake/model",
            )
            store.save_generation(project_id, section.section_id, result)
            if kwargs.get("progress_cb"):
                kwargs["progress_cb"](section.section_id, "generated", 1.0)
            if kwargs.get("on_delta"):
                kwargs["on_delta"](section.section_id, "chunk ")
            if kwargs.get("stream"):
                kwargs["stream"](section.section_id, result.text)
        return {
            section.section_id: store.get_generation(project_id, section.section_id)
            for section in walk_sections(store.get_sections(project_id))
        }

    def rewrite(self, project_id, store, section_ids, **kwargs):
        return {}

    def format_document(self, project_id, store, **kwargs):
        results = {}
        for section in walk_sections(store.get_sections(project_id)):
            result = GenerationResult(
                section_id=section.section_id,
                text=f"Formatted: {section.title}",
                status="generated",
                model="fake/model",
            )
            store.save_generation(project_id, section.section_id, result)
            results[section.section_id] = result
        return results

    def merge_similar_sections(self, project_id, store, **kwargs):
        return []


@pytest.fixture()
def engine():
    return FakeEngine()


@pytest.fixture()
def client(engine):
    app = create_app(store=InMemoryStore(), engine=engine)
    with TestClient(app) as http:
        yield http


@pytest.fixture()
def source_file(tmp_path):
    path = tmp_path / "sample.md"
    path.write_text("# Chapter One\n\ntemplate body words\n", encoding="utf-8")
    return str(path)


def _open_project(client: TestClient, source_file: str) -> tuple[str, list[dict]]:
    response = client.post("/api/projects/open", json={"file_path": source_file})
    assert response.status_code == 200, response.text
    body = response.json()
    return body["meta"]["project_id"], body["tree"]


def _leaf(tree: list[dict]) -> dict:
    return tree[0]["children"][0]


# -- health / projects -------------------------------------------------------


def test_health_lists_providers(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["store"] == "InMemoryStore"
    assert any(p["name"] == "ollama" for p in body["providers"])


def test_models_live_fetch_builtin_providers(client, monkeypatch):
    """Built-in providers must be live-fetched like BYOK ones, not pinned.

    Regression test: list_models() used to short-circuit PROVIDER_DEFS
    entries to their single configured model, so openrouter/groq/google
    never showed their real model catalogs."""
    from quill_engine import config as cfg
    from quill_engine import providers as providers_module

    monkeypatch.setattr(cfg, "LLM_PROVIDERS", ["ollama", "openai"])
    monkeypatch.setattr(providers_module, "file_chain", lambda: None)
    monkeypatch.setattr(providers_module, "file_providers", lambda: {})
    providers_module.reload_config_file()

    monkeypatch.setattr(
        providers_module,
        "fetch_provider_models",
        lambda base_url, api_key, timeout=8.0: ["fake-a", "fake-b"],
    )
    body = client.get("/api/models").json()
    assert body["current"] is not None

    by_name = {entry["name"]: entry for entry in body["providers"]}
    assert "ollama" in by_name and "openai" in by_name
    assert by_name["openai"]["models"] == ["fake-a", "fake-b"]
    for entry in body["providers"]:
        assert entry["models"]
        assert entry["base_url"].startswith(("http://", "https://"))
        assert "api_key" not in entry


def test_delete_custom_provider_removes_from_file(client, monkeypatch, tmp_path):
    from quill_engine import providers as providers_module
    from quill_engine import config as cfg

    path = tmp_path / "providers.json"
    path.write_text(
        '{"providers": {"custom-x": {"base_url": "https://x.example.com/v1",'
        ' "api_key": "sk", "model": "m", "requires_key": true}},'
        ' "chain": ["custom-x", "ollama"]}',
        encoding="utf-8",
    )
    monkeypatch.setattr(cfg, "LLM_PROVIDERS", ["ollama"])
    monkeypatch.setattr(providers_module, "providers_file_path", lambda: str(path))
    providers_module.reload_config_file()
    assert "custom-x" in providers_module.all_providers()

    resp = client.delete("/api/models/custom-x")
    assert resp.status_code == 200
    assert resp.json()["name"] == "custom-x"
    assert "custom-x" not in providers_module.all_providers()


def test_delete_builtin_with_no_saved_entry_returns_404(client, monkeypatch):
    from quill_engine import providers as providers_module
    from quill_engine import config as cfg

    monkeypatch.setattr(cfg, "LLM_PROVIDERS", ["ollama"])
    monkeypatch.setattr(providers_module, "file_chain", lambda: None)
    monkeypatch.setattr(providers_module, "file_providers", lambda: {})
    providers_module.reload_config_file()

    resp = client.delete("/api/models/openrouter")
    assert resp.status_code == 404
    assert "no saved provider entry" in resp.json()["detail"]


def test_delete_builtin_with_saved_entry_removes_entry(client, monkeypatch, tmp_path):
    """A built-in name saved to the config file can be un-connected via DELETE;
    it falls back to its hard-coded definition instead of disappearing."""
    from quill_engine import providers as providers_module
    from quill_engine import config as cfg

    path = tmp_path / "providers.json"
    path.write_text(
        '{"providers": {"openrouter": {"base_url": "https://openrouter.ai/api/v1/chat/completions",'
        ' "api_key": "sk", "model": "default", "requires_key": true}},'
        ' "chain": ["openrouter", "ollama"]}',
        encoding="utf-8",
    )
    monkeypatch.setattr(cfg, "LLM_PROVIDERS", ["ollama"])
    monkeypatch.setattr(providers_module, "providers_file_path", lambda: str(path))
    providers_module.reload_config_file()
    assert "openrouter" in providers_module.file_providers()

    resp = client.delete("/api/models/openrouter")
    assert resp.status_code == 200
    assert resp.json()["name"] == "openrouter"
    assert "openrouter" not in providers_module.file_providers()
    assert "openrouter" in providers_module.all_providers()


def test_open_rejects_missing_file(client):
    response = client.post("/api/projects/open", json={"file_path": "/no/such.md"})
    assert response.status_code == 400


def test_new_project_creates_single_section(client):
    body = client.post("/api/projects/new", json={"title": "Blank"}).json()
    assert body["meta"]["pending"] == 1
    assert body["tree"][0]["title"] == "Blank"
    assert body["meta"]["project_id"].startswith("proj_")


def test_open_is_idempotent(client, source_file):
    first = client.post("/api/projects/open", json={"file_path": source_file}).json()
    second = client.post("/api/projects/open", json={"file_path": source_file}).json()
    assert first["meta"]["project_id"] == second["meta"]["project_id"]
    assert first["tree"] == second["tree"]


def test_unknown_project_404(client):
    assert client.get("/api/projects/proj_none").status_code == 404


# -- sections ----------------------------------------------------------------


def test_get_section_returns_template_text(client, source_file):
    project_id, tree = _open_project(client, source_file)
    leaf = _leaf(tree)
    detail = client.get(f"/api/projects/{project_id}/sections/{leaf['section_id']}").json()
    assert detail["title"] == "1.1 Background"
    assert detail["status"] == "pending"


def test_save_section_persists_and_recomputes_warnings(client, source_file):
    project_id, tree = _open_project(client, source_file)
    leaf = _leaf(tree)
    saved = client.put(
        f"/api/projects/{project_id}/sections/{leaf['section_id']}",
        json={"text": "Hand-written opener. " + "padding sentence for length. " * 12},
    ).json()
    assert saved["status"] == "generated"
    detail = client.get(f"/api/projects/{project_id}/sections/{leaf['section_id']}").json()
    assert detail["text"].startswith("Hand-written")
    assert all(w["code"] != "too_short" for w in detail["warnings"])


def test_save_section_missing_404(client, source_file):
    project_id, _ = _open_project(client, source_file)
    response = client.put(
        f"/api/projects/{project_id}/sections/sec_none", json={"text": "words"}
    )
    assert response.status_code == 404


def test_validate_flags_short_text(client):
    warnings = client.post(
        "/api/validate", json={"section_id": "s", "text": "tiny"}
    ).json()
    assert any(w["code"] == "too_short" for w in warnings)


# -- runs ----------------------------------------------------------------------


def _wait_for_run(client: TestClient, run_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        handle = client.get(f"/api/runs/{run_id}").json()
        if handle["status"] != "running":
            return handle
        time.sleep(0.02)
    raise AssertionError("run did not finish in time")


def test_run_completes_and_updates_project(client, engine, source_file):
    project_id, _ = _open_project(client, source_file)
    response = client.post(f"/api/projects/{project_id}/run", json={"prompt": "go"})
    assert response.status_code == 202
    handle = _wait_for_run(client, response.json()["run_id"])
    assert handle["status"] == "done"
    assert handle["summary"]["sections"] == 2
    meta = client.get(f"/api/projects/{project_id}").json()["meta"]
    assert meta["generated"] == 2
    assert meta["total_words"] > 0


def test_run_cancel(client, engine, source_file):
    engine.gate.clear()
    project_id, _ = _open_project(client, source_file)
    response = client.post(f"/api/projects/{project_id}/run", json={})
    run_id = response.json()["run_id"]
    assert client.post(f"/api/runs/{run_id}/cancel").json() == {"ok": True}
    engine.gate.set()
    handle = _wait_for_run(client, run_id)
    assert handle["status"] == "cancelled"


def test_format_run_formats_all_sections(client, engine, source_file):
    project_id, _ = _open_project(client, source_file)
    response = client.post(f"/api/projects/{project_id}/format")
    assert response.status_code == 202
    assert response.json()["kind"] == "format"
    handle = _wait_for_run(client, response.json()["run_id"])
    assert handle["status"] == "done"
    assert handle["summary"]["sections"] == 2
    assert handle["summary"]["generated"] == 2
    meta = client.get(f"/api/projects/{project_id}").json()["meta"]
    assert meta["generated"] == 2


def test_restructure_run_summarizes_structure_changes(client, engine, source_file):
    """The restructure kind routes through the structural rewrite branch and
    reports added/removed/renamed sections via a before/after tree diff."""
    project_id, tree = _open_project(client, source_file)
    leaf = _leaf(tree)
    leaf_id = leaf["section_id"]

    def structural_rewrite(project_id, store, section_ids, **kwargs):
        sections = store.get_sections(project_id)
        for section in walk_sections(sections):
            if section.section_id == leaf_id:
                section.title = "Renamed Background"
        extra = new_section("Methods", level=2, order=2, parent_id=tree[0]["section_id"])
        sections[0].children.append(extra)
        store.save_sections(project_id, sections)
        return {}

    engine.rewrite = structural_rewrite

    response = client.post(
        f"/api/projects/{project_id}/restructure", json={"instruction": "reorganize"}
    )
    assert response.status_code == 202
    assert response.json()["kind"] == "restructure"
    handle = _wait_for_run(client, response.json()["run_id"])
    assert handle["status"] == "done"
    assert handle["summary"]["renamed"] == 1
    assert handle["summary"]["added"] == 1
    assert handle["summary"]["removed"] == 0
    assert handle["summary"]["generated"] == 0


def test_conflicting_run_rejected_with_409(client, engine, source_file):
    engine.gate.clear()
    project_id, _ = _open_project(client, source_file)
    first = client.post(f"/api/projects/{project_id}/run", json={})
    second = client.post(f"/api/projects/{project_id}/rewrite", json={"section_ids": []})
    assert second.status_code == 409
    engine.gate.set()
    _wait_for_run(client, first.json()["run_id"])


def test_cancel_unknown_run_404(client):
    assert client.post("/api/runs/nope/cancel").status_code == 404


# -- section tree mutations ---------------------------------------------------


def test_add_rename_delete_section_roundtrip(client, source_file):
    project_id, _ = _open_project(client, source_file)

    added = client.post(
        f"/api/projects/{project_id}/sections",
        json={"title": "Methods"},
    ).json()
    assert added["section_id"]
    titles = [node["title"] for node in added["project"]["tree"]]
    assert titles == ["Chapter One", "Methods"]

    child = client.post(
        f"/api/projects/{project_id}/sections",
        json={"title": "1.2 Setup", "parent_id": added["project"]["tree"][0]["section_id"]},
    ).json()
    assert child["project"]["tree"][0]["children"][-1]["title"] == "1.2 Setup"

    renamed = client.put(
        f"/api/projects/{project_id}/sections/{added['section_id']}/rename",
        json={"title": "Methodology"},
    ).json()
    assert "Methodology" in [node["title"] for node in renamed["project"]["tree"]]

    removed = client.delete(
        f"/api/projects/{project_id}/sections/{added['section_id']}"
    ).json()
    assert "Methodology" not in [node["title"] for node in removed["project"]["tree"]]


def test_add_section_rejects_unknown_parent(client, source_file):
    project_id, _ = _open_project(client, source_file)
    response = client.post(
        f"/api/projects/{project_id}/sections",
        json={"title": "X", "parent_id": "sec_none"},
    )
    # unknown parent falls back to a top-level chapter, not an error
    assert response.status_code == 200
    assert response.json()["section_id"]


# -- evidence / export ----------------------------------------------------------


def test_evidence_roundtrip(client, source_file):
    project_id, _ = _open_project(client, source_file)
    saved = client.post(
        f"/api/projects/{project_id}/evidence", json={"answers": {"supervisor": "Dr. X"}}
    ).json()
    assert saved == {"ok": True, "count": 1}
    assert client.get(f"/api/projects/{project_id}/evidence").json() == {
        "supervisor": "Dr. X"
    }


def test_export_and_preview_render_saved_text(client, engine, source_file, tmp_path, monkeypatch):
    import quill_engine.api.routes as routes

    monkeypatch.setattr(routes.config, "EXPORT_DIR", str(tmp_path))
    project_id, _ = _open_project(client, source_file)
    client.post(f"/api/projects/{project_id}/run", json={})
    preview = client.get(f"/api/projects/{project_id}/preview").json()["markdown"]
    assert "Generated: Chapter One" in preview
    assert preview.startswith("# ")
    exported = client.get(f"/api/projects/{project_id}/export?fmt=md").json()
    assert exported["format"] == "md"
    assert (tmp_path / f"{project_id}.md").exists()


def test_export_pdf_renders_valid_file(client, engine, source_file, tmp_path, monkeypatch):
    import quill_engine.api.routes as routes

    monkeypatch.setattr(routes.config, "EXPORT_DIR", str(tmp_path))
    project_id, _ = _open_project(client, source_file)
    client.post(f"/api/projects/{project_id}/run", json={})
    exported = client.get(f"/api/projects/{project_id}/export?fmt=pdf").json()
    assert exported["format"] == "pdf"
    pdf_path = tmp_path / f"{project_id}.pdf"
    assert pdf_path.exists()
    assert pdf_path.stat().st_size > 1000
    assert pdf_path.read_bytes()[:5] == b"%PDF-"


# -- websocket -------------------------------------------------------------------


def test_ws_streams_progress_and_section_events(client, engine, source_file):
    project_id, _ = _open_project(client, source_file)
    with client.websocket_connect("/ws") as ws:
        response = client.post(f"/api/projects/{project_id}/run", json={})
        run_id = response.json()["run_id"]
        events = []
        while True:
            event = ws.receive_json()
            events.append(event)
            if event["type"] == "run_done":
                break
        kinds = {event["type"] for event in events}
        assert {"progress", "section", "delta", "run_started", "run_done"} <= kinds
        done = events[-1]
        assert done["run_id"] == run_id
        assert done["status"] == "done"
        deltas = [event for event in events if event["type"] == "delta"]
        assert deltas
        assert deltas[0]["section_id"]
        assert deltas[0]["text"] == "chunk "
        assert deltas[0]["project_id"] == project_id


def test_freewrite_saves_draft_text_without_rebuilding_tree(client, source_file):
    project_id, _ = _open_project(client, source_file)
    original = client.get(f"/api/projects/{project_id}").json()
    original_titles = [node["title"] for node in original["tree"]]

    response = client.put(
        f"/api/projects/{project_id}/freewrite",
        json={"markdown": "# New Head\n\nsome text\n\n## Sub Head\n\nmore text"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    titles = [node["title"] for node in body["project"]["tree"]]
    assert titles == original_titles  # tree untouched — headings stay text

    draft = client.get(f"/api/projects/{project_id}/draft")
    assert draft.status_code == 200, draft.text
    assert draft.json()["markdown"] == "# New Head\n\nsome text\n\n## Sub Head\n\nmore text"


def test_freewrite_writeback_lands_text_in_matching_sections(client, source_file):
    project_id, tree = _open_project(client, source_file)
    chapter_id = tree[0]["section_id"]
    child_id = _leaf(tree)["section_id"]

    response = client.put(
        f"/api/projects/{project_id}/freewrite",
        json={
            "markdown": (
                "# Chapter One\n\nfirst body text\n\n"
                "## 1.1 Background\n\nsecond body text"
            )
        },
    )
    assert response.status_code == 200, response.text
    # Structure is untouched; the write-back only fills section bodies.
    titles = [node["title"] for node in response.json()["project"]["tree"]]
    assert titles == ["Chapter One"]

    chapter = client.get(f"/api/projects/{project_id}/sections/{chapter_id}").json()
    assert chapter["text"] == "first body text"
    child = client.get(f"/api/projects/{project_id}/sections/{child_id}").json()
    assert child["text"] == "second body text"

    # The blob itself remains the verbatim draft source.
    draft = client.get(f"/api/projects/{project_id}/draft").json()["markdown"]
    assert draft == "# Chapter One\n\nfirst body text\n\n## 1.1 Background\n\nsecond body text"


def test_freewrite_ignores_headings_without_a_section(client, source_file):
    project_id, tree = _open_project(client, source_file)
    chapter_id = tree[0]["section_id"]

    response = client.put(
        f"/api/projects/{project_id}/freewrite",
        json={"markdown": "# Brand New Heading\n\ntext without a section"},
    )
    assert response.status_code == 200, response.text
    detail = client.get(f"/api/projects/{project_id}/sections/{chapter_id}").json()
    assert detail["status"] == "pending"  # untouched — no matching section


def test_freewrite_renamed_heading_retitles_the_section(client, source_file):
    project_id, tree = _open_project(client, source_file)
    child_id = _leaf(tree)["section_id"]

    first = client.put(
        f"/api/projects/{project_id}/freewrite",
        json={
            "markdown": (
                "# Chapter One\n\nfirst body text\n\n"
                "## 1.1 Background\n\nsecond body text"
            )
        },
    )
    assert first.status_code == 200, first.text

    renamed = client.put(
        f"/api/projects/{project_id}/freewrite",
        json={
            "markdown": (
                "# Chapter One\n\nfirst body text\n\n"
                "## 1.2 Context Rewritten\n\nsecond body text"
            )
        },
    )
    assert renamed.status_code == 200, renamed.text
    titles = [
        node["title"] for node in renamed.json()["project"]["tree"][0]["children"]
    ]
    assert titles == ["1.2 Context Rewritten"]

    child = client.get(f"/api/projects/{project_id}/sections/{child_id}").json()
    assert child["title"] == "1.2 Context Rewritten"
    assert child["text"] == "second body text"


def test_draft_prefers_assembled_tree_over_skeleton_blob(client, source_file):
    project_id, tree = _open_project(client, source_file)
    leaf = _leaf(tree)

    saved = client.put(
        f"/api/projects/{project_id}/sections/{leaf['section_id']}",
        json={"text": "Real body saved in the section tree."},
    )
    assert saved.status_code == 200, saved.text

    # A heading-only blob is stale — the tree holds the actual content.
    response = client.put(
        f"/api/projects/{project_id}/freewrite",
        json={"markdown": "# Chapter One\n\n## 1.1 Background"},
    )
    assert response.status_code == 200, response.text

    draft = client.get(f"/api/projects/{project_id}/draft").json()["markdown"]
    assert "Real body saved in the section tree." in draft
