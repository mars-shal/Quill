"""Tests for deterministic project ids and the disk-backed store."""

from __future__ import annotations

from quill_engine import config
from quill_engine import orchestrator
from quill_engine.models import (
    Chunk,
    GenerationResult,
    Section,
    new_vector_record,
)
from quill_engine.opensearch_store import JsonFileStore, new_store
from quill_engine.storage import InMemoryStore


# -- helpers ---------------------------------------------------------------


def _section(section_id: str, title: str) -> Section:
    return Section(
        section_id=section_id,
        title=title,
        level=2,
        order=1,
        parent_id=None,
        description="",
        content=[],
    )


def _result(section_id: str, text: str) -> GenerationResult:
    return GenerationResult(section_id=section_id, text=text, status="generated", missing_fields=[])


# -- deterministic project_id ----------------------------------------------


def test_project_id_deterministic_for_same_path():
    assert orchestrator._project_id_for("/tmp/one.md") == orchestrator._project_id_for("/tmp/one.md")


def test_project_id_differs_for_different_paths():
    assert orchestrator._project_id_for("/tmp/one.md") != orchestrator._project_id_for("/tmp/two.md")


def test_project_id_is_prefixed_and_stable_prefix():
    pid = orchestrator._project_id_for("/tmp/one.md")
    assert pid.startswith("proj_")
    assert len(pid) == len("proj_") + 16


# -- JsonFileStore roundtrip -----------------------------------------------


def test_json_file_store_roundtrips_all_buckets(tmp_path):
    store = JsonFileStore(directory=str(tmp_path))
    store.save_sections("p1", [_section("s1", "Alpha")])
    store.save_chunks(
        "p1", [Chunk(chunk_id="c1", section_id="s1", text="body", tokens=5)]
    )
    store.save_vectors(
        "p1",
        [
            new_vector_record(
                section_id="s1",
                embedding=[1.0, 0.0],
                model="test",
                dim=2,
                chunk_id="c1",
                kind="chunk",
            )
        ],
    )
    store.save_generation("p1", "s1", _result("s1", "GENERATED"))
    store.save_evidence("p1", {"q1": "answer"})
    store.save_style("p1", "s1", {"tone": "formal"})

    fresh = JsonFileStore(directory=str(tmp_path))
    assert [s.section_id for s in fresh.get_sections("p1")] == ["s1"]
    assert fresh.get_generation("p1", "s1").text == "GENERATED"
    assert fresh.get_evidence("p1") == {"q1": "answer"}
    assert fresh.get_style("p1", "s1") == {"tone": "formal"}
    hits = fresh.search_vectors("p1", [1.0, 0.0], section_ids=["s1"], top_k=1)
    assert hits and hits[0].chunk_id == "c1"
    assert fresh.get_header_embedding("p1", "s1") is None


def test_json_file_store_isolates_projects(tmp_path):
    store = JsonFileStore(directory=str(tmp_path))
    store.save_sections("p1", [_section("s1", "Alpha")])
    store.save_sections("p2", [_section("s2", "Beta")])
    fresh = JsonFileStore(directory=str(tmp_path))
    assert [s.section_id for s in fresh.get_sections("p1")] == ["s1"]
    assert [s.section_id for s in fresh.get_sections("p2")] == ["s2"]


def test_new_store_routes_disk_backend(monkeypatch):
    monkeypatch.setattr(config, "STORE_BACKEND", "disk")
    assert isinstance(new_store(), JsonFileStore)


def test_new_store_defaults_to_in_memory(monkeypatch):
    monkeypatch.setattr(config, "STORE_BACKEND", "unknown")
    assert isinstance(new_store(), InMemoryStore)
