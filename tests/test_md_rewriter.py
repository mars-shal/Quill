"""Unit tests for md_rewriter + orchestrator.rewrite (rewrite mode)."""

import pytest

from quill_engine import config, context_builder, md_rewriter, orchestrator
from quill_engine.models import (
    ContentUnit,
    EvidencePacket,
    GenerationResult,
    PromptPackage,
    ScoredChunk,
    Section,
    SourceRef,
    Warning,
)
from quill_engine.storage import InMemoryStore


def _section(section_id: str, title: str) -> Section:
    return Section(
        section_id=section_id,
        title=title,
        level=1,
        order=1,
        parent_id=None,
        word_count=40,
    )


def _result(section_id: str, text: str, status: str = "generated") -> GenerationResult:
    return GenerationResult(
        section_id=section_id,
        text=text,
        status=status,
        missing_fields=[],
    )


def _seed_store(sections: list[Section]) -> InMemoryStore:
    store = InMemoryStore()
    store.save_sections("proj", sections)
    return store


class FakePacket:
    section_id = "s1"
    section_title = "Week One"
    target_words = 40
    style_profile = {}
    chunks = []
    query = ""
    missing_fields = []
    user_notes = ""
    section_summaries = []


# -- context_builder.build_rewrite ---------------------------------------


def test_build_rewrite_threads_existing_text_and_instruction():
    packet = EvidencePacket(
        section_id="s1",
        section_title="Week One",
        target_words=40,
        style_profile={},
        chunks=[],
    )
    package = context_builder.build_rewrite(
        packet, existing_text="OLD BODY", instruction="make it formal"
    )
    assert "Task instruction: make it formal" in package.template
    assert "OLD BODY" in package.template
    assert "Section: Week One" in package.template
    assert "make it formal" not in package.system_instructions


def test_build_rewrite_appends_humanizer_rules_when_enabled(monkeypatch):
    monkeypatch.setattr(config, "HUMANIZER_ENABLED", True)
    packet = EvidencePacket(
        section_id="s1",
        section_title="Week One",
        target_words=40,
        style_profile={},
        chunks=[],
    )
    package = context_builder.build_rewrite(packet, existing_text="OLD", instruction="x")
    assert "write like a human" in package.system_instructions
    assert "moreover" in package.system_instructions  # banned transition words
    assert "TELLS TO AVOID" in package.system_instructions  # AI-tell block
    assert "Significance inflation" in package.system_instructions


def test_build_rewrite_omits_humanizer_rules_when_disabled(monkeypatch):
    monkeypatch.setattr(config, "HUMANIZER_ENABLED", False)
    packet = EvidencePacket(
        section_id="s1",
        section_title="Week One",
        target_words=40,
        style_profile={},
        chunks=[],
    )
    package = context_builder.build_rewrite(packet, existing_text="OLD", instruction="x")
    assert "write like a human" not in package.system_instructions
    assert "TELLS TO AVOID" not in package.system_instructions


# -- md_rewriter.rewrite_section -----------------------------------------


def test_rewrite_section_regenerates_from_existing_text(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "OLD BODY"))

    captured: dict = {}

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        captured["query"] = query
        return FakePacket()

    def fake_build_rewrite(packet, *, existing_text, instruction):
        captured["existing_text"] = existing_text
        captured["instruction"] = instruction
        from quill_engine.models import PromptPackage

        return PromptPackage(
            system_instructions="sys",
            template="tpl",
            style_profile={},
            evidence=[],
            target_words=40,
        )

    def fake_generate(package, *, cancel=None):
        return "REWRITTEN BODY"

    def fake_check(section_id, text, **kwargs):
        return []

    monkeypatch.setattr(md_rewriter.retrieval_service, "retrieve", fake_retrieve)
    monkeypatch.setattr(context_builder, "build_rewrite", fake_build_rewrite)
    monkeypatch.setattr(md_rewriter.writing_service, "generate", fake_generate)
    monkeypatch.setattr(md_rewriter.validation_service, "check", fake_check)

    result = md_rewriter.rewrite_section("proj", "s1", store, instruction="be concise")

    assert result.status == "generated"
    assert result.text == "REWRITTEN BODY"
    assert captured["existing_text"] == "OLD BODY"
    assert captured["instruction"] == "be concise"
    assert captured["query"] == "be concise"
    # the service does not persist — the orchestrator owns that
    assert store.get_generation("proj", "s1").text == "OLD BODY"


def test_rewrite_section_falls_back_to_title_query(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])

    captured: dict = {}

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        captured["query"] = query
        return FakePacket()

    monkeypatch.setattr(md_rewriter.retrieval_service, "retrieve", fake_retrieve)

    def fake_generate(package, *, cancel=None):
        return "BODY"

    monkeypatch.setattr(md_rewriter.writing_service, "generate", fake_generate)

    result = md_rewriter.rewrite_section("proj", "s1", store)
    assert result.status == "generated"
    assert captured["query"] == "Week One"


def test_rewrite_section_attaches_sources(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "OLD BODY"))

    packet = EvidencePacket(
        section_id="s1",
        section_title="Week One",
        target_words=40,
        style_profile={},
        chunks=[
            ScoredChunk(
                chunk_id="c1",
                section_id="s1",
                text="body",
                similarity=0.5,
                tokens=1,
                source_type="web",
                source_title="A source page",
                source_url="https://example.com/a",
            ),
            ScoredChunk(
                chunk_id="c2",
                section_id="s1",
                text="body",
                similarity=0.5,
                tokens=1,
                source_type="memory",
                source_title="A memory note",
                source_url="",
            ),
        ],
    )

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        return packet

    monkeypatch.setattr(md_rewriter.retrieval_service, "retrieve", fake_retrieve)
    monkeypatch.setattr(
        md_rewriter.writing_service, "generate", lambda package, *, cancel=None: "REWRITTEN BODY"
    )
    monkeypatch.setattr(md_rewriter.validation_service, "check", lambda sid, text, **kwargs: [])

    result = md_rewriter.rewrite_section("proj", "s1", store, instruction="add sources")

    assert result.status == "generated"
    assert result.sources == [
        SourceRef(title="A source page", url="https://example.com/a", kind="web"),
        SourceRef(title="A memory note", url="", kind="memory"),
    ]


def test_rewrite_section_attaches_model(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "OLD BODY"))
    monkeypatch.setattr(md_rewriter.providers, "_last_used", None)

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        return FakePacket()

    def fake_generate(package, *, cancel=None):
        # simulate writing_service recording the successful provider/model
        md_rewriter.providers.record_success("groq", "llama-3.3-70b-versatile")
        return "REWRITTEN BODY"

    monkeypatch.setattr(md_rewriter.retrieval_service, "retrieve", fake_retrieve)
    monkeypatch.setattr(md_rewriter.writing_service, "generate", fake_generate)
    monkeypatch.setattr(md_rewriter.validation_service, "check", lambda sid, text, **kwargs: [])

    result = md_rewriter.rewrite_section("proj", "s1", store, instruction="be concise")

    assert result.status == "generated"
    assert result.model == "groq/llama-3.3-70b-versatile"


def test_rewrite_section_model_empty_before_any_success(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "OLD BODY"))
    monkeypatch.setattr(md_rewriter.providers, "_last_used", None)

    monkeypatch.setattr(
        md_rewriter.retrieval_service, "retrieve", lambda *a, **k: FakePacket()
    )
    monkeypatch.setattr(md_rewriter.writing_service, "generate", lambda package, *, cancel=None: "BODY")
    monkeypatch.setattr(md_rewriter.validation_service, "check", lambda sid, text, **kwargs: [])

    result = md_rewriter.rewrite_section("proj", "s1", store)

    assert result.status == "generated"
    assert result.model == ""


def test_rewrite_section_failure_marks_failed(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        raise RuntimeError("boom")

    monkeypatch.setattr(md_rewriter.retrieval_service, "retrieve", fake_retrieve)

    result = md_rewriter.rewrite_section("proj", "s1", store, instruction="x")

    assert result.status == "failed"
    assert result.error == "boom"
    assert result.warnings[0].code == "rewrite_failed"


# -- orchestrator.rewrite ------------------------------------------------


@pytest.fixture(autouse=True)
def _no_research(monkeypatch):
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    monkeypatch.setattr(orchestrator, "research", lambda *a, **k: None)


def test_rewrite_overwrites_selected_sections(monkeypatch):
    store = _seed_store(
        [_section("s1", "Week One"), _section("s2", "Week Two")]
    )
    store.save_generation("proj", "s1", _result("s1", "old s1"))
    store.save_generation("proj", "s2", _result("s2", "old s2"))

    calls: list[str] = []

    def fake_rewrite_section(project_id, section_id, store, *, instruction, cancel=None, references=()):
        calls.append(section_id)
        return _result(section_id, f"new {section_id}")

    monkeypatch.setattr(orchestrator.md_rewriter, "rewrite_section", fake_rewrite_section)

    progress: list[tuple] = []
    results = orchestrator.rewrite(
        "proj", store, ["s2"], prompt="tighten it up",
        progress_cb=lambda *args: progress.append(args),
    )

    assert calls == ["s2"]
    assert set(results) == {"s2"}
    assert results["s2"].text == "new s2"
    # overwritten in the store, not skipped
    assert store.get_generation("proj", "s2").text == "new s2"
    assert store.get_generation("proj", "s1").text == "old s1"
    assert ("s2", "generating", 0.0) in progress
    assert ("s2", "generated", 1.0) in progress


def test_rewrite_empty_targets_falls_back_to_all_generated(monkeypatch):
    store = _seed_store(
        [_section("s1", "Week One"), _section("s2", "Week Two")]
    )
    store.save_generation("proj", "s1", _result("s1", "old s1"))
    store.save_generation("proj", "s2", _result("s2", "", status="blocked"))

    monkeypatch.setattr(config, "REWRITE_STRUCTURE_ENABLED", False)

    calls: list[str] = []

    def fake_rewrite_section(project_id, section_id, store, *, instruction, cancel=None, references=()):
        calls.append(section_id)
        return _result(section_id, f"new {section_id}")

    monkeypatch.setattr(orchestrator.md_rewriter, "rewrite_section", fake_rewrite_section)

    results = orchestrator.rewrite("proj", store, [], prompt="fix it")

    assert calls == ["s1"]  # blocked s2 is not rewritten
    assert set(results) == {"s1"}


def test_rewrite_structural_mode_when_prompt_and_no_selection(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "old s1"))

    def fake_restructure(project_id, store, *, instruction, cancel=None, references=(), progress_cb=None, on_delta=None):
        from quill_engine.models import RestructureOutcome

        return RestructureOutcome(
            rewritten={"s1": _result("s1", "new s1"), "s2": _result("s2", "added s2")},
            added=["s2"],
            removed=[],
        )

    monkeypatch.setattr(orchestrator.md_rewriter, "restructure", fake_restructure)

    progress: list[tuple] = []
    results = orchestrator.rewrite(
        "proj", store, [], prompt="restructure it",
        progress_cb=lambda *args: progress.append(args),
    )

    assert set(results) == {"s1", "s2"}
    assert store.get_generation("proj", "s1").text == "new s1"
    assert store.get_generation("proj", "s2").text == "added s2"
    assert ("s2", "generated", 1.0) in progress


def test_rewrite_explicit_selection_skips_structural_mode(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "old s1"))

    called = {"restructure": False}

    def fake_restructure(*a, **k):
        called["restructure"] = True
        from quill_engine.models import RestructureOutcome

        return RestructureOutcome()

    monkeypatch.setattr(orchestrator.md_rewriter, "restructure", fake_restructure)
    monkeypatch.setattr(
        orchestrator.md_rewriter,
        "rewrite_section",
        lambda *a, **k: _result("s1", "new s1"),
    )

    results = orchestrator.rewrite("proj", store, ["s1"], prompt="restructure it")

    assert not called["restructure"]
    assert results["s1"].text == "new s1"


def test_rewrite_runs_research_when_enabled(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "old s1"))

    monkeypatch.setattr(config, "RESEARCH_ENABLED", True)
    researched: list[str] = []
    monkeypatch.setattr(
        orchestrator, "research", lambda project_id, *, prompt, progress_cb=None: researched.append(prompt)
    )
    monkeypatch.setattr(
        orchestrator.md_rewriter,
        "rewrite_section",
        lambda *a, **k: _result("s1", "new s1"),
    )

    progress: list[tuple] = []
    orchestrator.rewrite(
        "proj", store, ["s1"], prompt="redo",
        progress_cb=lambda *args: progress.append(args),
    )

    assert researched == ["redo"]
    assert ("", "research", 0.0) in progress


def test_research_emits_searching_and_researching_phases(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])

    monkeypatch.setattr(config, "RESEARCH_ENABLED", True)

    def fake_research(project_id, *, prompt, progress_cb=None):
        if progress_cb is not None:
            progress_cb("", "searching", 0.2)
            progress_cb("", "researching", 0.8)

    monkeypatch.setattr(orchestrator, "research", fake_research)
    monkeypatch.setattr(
        orchestrator.md_rewriter,
        "rewrite_section",
        lambda *a, **k: _result("s1", "new s1"),
    )

    progress: list[tuple] = []
    orchestrator.rewrite(
        "proj", store, ["s1"], prompt="redo",
        progress_cb=lambda *args: progress.append(args),
    )

    assert ("", "research", 0.0) in progress
    assert ("", "searching", 0.2) in progress
    assert ("", "researching", 0.8) in progress


def test_run_emits_thinking_writing_proofreading_phases(monkeypatch):
    store = _seed_store([_section("s1", "Conclusion")])
    monkeypatch.setattr(config, "STRUCTURE_ONLY", True)
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    monkeypatch.setattr(config, "RELATION_ENABLED", False)

    monkeypatch.setattr(
        orchestrator.retrieval_service, "retrieve",
        lambda *a, **k: _research_packet("s1", "Conclusion", "memory"),
    )
    monkeypatch.setattr(orchestrator.context_builder, "build", lambda p: _prompt_package())
    monkeypatch.setattr(
        orchestrator.writing_service, "generate",
        lambda p, cancel=None, on_delta=None: "GOOD BODY",
    )
    monkeypatch.setattr(orchestrator.validation_service, "check", lambda *a, **k: [])

    phases: list[tuple] = []
    results = orchestrator.run(
        "proj", store, prompt="write",
        progress_cb=lambda section_id, status, ratio: phases.append((section_id, status)),
    )

    assert results["s1"].status == "generated"
    phase_statuses = [s for _, s in phases]
    assert "thinking" in phase_statuses
    assert "writing" in phase_statuses
    assert "proofreading" in phase_statuses


# -- validation cascade (rewrite on severe warnings) ----------------------


def _packet() -> EvidencePacket:
    return EvidencePacket(
        section_id="s1",
        section_title="Week One",
        target_words=40,
        style_profile={},
        chunks=[],
    )


def _prompt_package() -> PromptPackage:
    return PromptPackage(
        system_instructions="sys",
        template="tpl",
        style_profile={},
        evidence=[],
        target_words=40,
    )


def test_rewrite_section_retries_on_severe_warnings(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "OLD BODY"))

    monkeypatch.setattr(
        md_rewriter.retrieval_service, "retrieve", lambda *a, **k: _packet()
    )
    monkeypatch.setattr(
        context_builder, "build_rewrite", lambda *a, **k: _prompt_package()
    )

    calls: list[str] = []

    def fake_generate(package, *, cancel=None):
        calls.append(package)
        return "BAD COPY" if len(calls) == 1 else "GOOD BODY"

    def fake_check(section_id, text, **kwargs):
        if text == "BAD COPY":
            return [Warning(code="verbatim_copy", message="copy", location=section_id)]
        return []

    monkeypatch.setattr(md_rewriter.writing_service, "generate", fake_generate)
    monkeypatch.setattr(md_rewriter.validation_service, "check", fake_check)

    result = md_rewriter.rewrite_section("proj", "s1", store, instruction="x")

    assert result.status == "generated"
    assert result.text == "GOOD BODY"
    assert result.warnings == []
    assert len(calls) == 2


def test_rewrite_section_retry_instruction_threaded_to_build_rewrite(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "OLD BODY"))

    monkeypatch.setattr(
        md_rewriter.retrieval_service, "retrieve", lambda *a, **k: _packet()
    )
    captured: dict = {}

    def fake_build_rewrite(packet, *, existing_text, instruction):
        captured["existing_text"] = existing_text
        captured["instruction"] = instruction
        return _prompt_package()

    def fake_generate(package, *, cancel=None):
        return "BAD COPY"

    def fake_check(section_id, text, **kwargs):
        return [Warning(code="verbatim_copy", message="copy", location=section_id)]

    monkeypatch.setattr(context_builder, "build_rewrite", fake_build_rewrite)
    monkeypatch.setattr(md_rewriter.writing_service, "generate", fake_generate)
    monkeypatch.setattr(md_rewriter.validation_service, "check", fake_check)

    md_rewriter.rewrite_section("proj", "s1", store, instruction="x")

    assert captured["existing_text"] == "BAD COPY"
    assert "your own words" in captured["instruction"]


def test_rewrite_section_stops_after_max_retries(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "OLD BODY"))
    monkeypatch.setattr(config, "GENERATION_MAX_RETRIES", 2)
    monkeypatch.setattr(
        md_rewriter.retrieval_service, "retrieve", lambda *a, **k: _packet()
    )
    monkeypatch.setattr(
        context_builder, "build_rewrite", lambda *a, **k: _prompt_package()
    )

    calls: list[int] = []
    monkeypatch.setattr(
        md_rewriter.writing_service,
        "generate",
        lambda package, *, cancel=None: calls.append(1) or "STILL BAD",
    )

    def fake_check(section_id, text, **kwargs):
        return [Warning(code="repeated_paragraph", message="loop", location=section_id)]

    monkeypatch.setattr(md_rewriter.validation_service, "check", fake_check)

    result = md_rewriter.rewrite_section("proj", "s1", store)

    assert len(calls) == 1 + config.GENERATION_MAX_RETRIES
    assert result.text == "STILL BAD"
    assert any(w.code == "repeated_paragraph" for w in result.warnings)


def test_generate_one_retries_until_clean(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    monkeypatch.setattr(
        orchestrator.retrieval_service, "retrieve", lambda *a, **k: _packet()
    )
    monkeypatch.setattr(orchestrator.context_builder, "build", lambda p: _prompt_package())
    monkeypatch.setattr(
        orchestrator.context_builder, "build_rewrite", lambda *a, **k: _prompt_package()
    )

    calls: list[str] = []

    def fake_generate(package, *, cancel=None):
        calls.append(package)
        return "BAD COPY" if len(calls) == 1 else "GOOD BODY"

    def fake_check(section_id, text, **kwargs):
        if text == "BAD COPY":
            return [Warning(code="verbatim_copy", message="copy", location=section_id)]
        return []

    monkeypatch.setattr(orchestrator.writing_service, "generate", fake_generate)
    monkeypatch.setattr(orchestrator.validation_service, "check", fake_check)

    result = orchestrator._generate_one("proj", "s1", store, query="q")

    assert result.status != "failed"
    assert result.text == "GOOD BODY"
    assert result.warnings == []
    assert len(calls) == 2


def test_generate_one_failure_still_marks_failed(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        raise RuntimeError("boom")

    monkeypatch.setattr(orchestrator.retrieval_service, "retrieve", fake_retrieve)

    result = orchestrator._generate_one("proj", "s1", store, query="q")

    assert result.status == "failed"
    assert result.error == "boom"
    assert result.warnings[0].code == "generation_failed"


# -- orchestrator.run (structure-only evidence gate) ----------------------


def _research_packet(section_id: str, title: str, source_type: str) -> EvidencePacket:
    tag = "[RESEARCH - from knowledge-graph memory - background only]"
    return EvidencePacket(
        section_id=section_id,
        section_title=title,
        target_words=40,
        style_profile={},
        chunks=[
            ScoredChunk(
                chunk_id="sup_1",
                section_id=section_id,
                text=f"{tag}\n" + ("research findings and recommendations " * 30),
                similarity=0.0,
                tokens=100,
                source_type=source_type,
                source_title="note",
                source_url="",
            )
        ],
    )


def test_run_structure_only_gates_on_research_and_passes_packet(monkeypatch):
    store = _seed_store([_section("s1", "Conclusion")])
    monkeypatch.setattr(config, "STRUCTURE_ONLY", True)
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    monkeypatch.setattr(config, "RELATION_ENABLED", False)

    retrieved: list[str] = []

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        retrieved.append(section_id)
        return _research_packet(section_id, "Conclusion", "memory")

    monkeypatch.setattr(orchestrator.retrieval_service, "retrieve", fake_retrieve)
    monkeypatch.setattr(orchestrator.context_builder, "build", lambda p: _prompt_package())
    monkeypatch.setattr(orchestrator.writing_service, "generate", lambda p, cancel=None: "GOOD BODY")
    monkeypatch.setattr(orchestrator.validation_service, "check", lambda *a, **k: [])

    results = orchestrator.run("proj", store, prompt="rewrite the report")

    assert results["s1"].status == "generated"
    assert results["s1"].text == "GOOD BODY"
    assert retrieved == ["s1"]  # retrieved exactly once (packet passed through)


def test_run_structure_only_fact_fields_still_block_without_answers(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    monkeypatch.setattr(config, "STRUCTURE_ONLY", True)
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    monkeypatch.setattr(config, "RELATION_ENABLED", False)

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        return _research_packet(section_id, "Week One", "web")

    monkeypatch.setattr(orchestrator.retrieval_service, "retrieve", fake_retrieve)
    generate_calls: list = []
    monkeypatch.setattr(
        orchestrator.writing_service, "generate", lambda p: generate_calls.append(p) or "X"
    )

    results = orchestrator.run("proj", store, prompt="rewrite")

    assert results["s1"].status == "blocked"
    assert set(results["s1"].missing_fields) == {"dates", "locations", "supervisors"}
    assert generate_calls == []


def test_run_binds_on_delta_to_section_id(monkeypatch):
    """run() must bind section_id onto on_delta before the writing service.

    providers.complete() invokes on_delta with a single text argument
    (Callable[[str], None]); the RunManager supplies a (section_id, text)
    StreamFn, so orchestrator.run must wrap it with _delta_for — otherwise
    every section dies with ``TypeError: delta() missing 1 required
    positional argument: 'text'``.
    """
    store = _seed_store([_section("s1", "Conclusion")])
    monkeypatch.setattr(config, "STRUCTURE_ONLY", True)
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    monkeypatch.setattr(config, "RELATION_ENABLED", False)

    def fake_retrieve(project_id, query, store, *, section_id, references=()):
        return _research_packet(section_id, "Conclusion", "memory")

    monkeypatch.setattr(orchestrator.retrieval_service, "retrieve", fake_retrieve)
    monkeypatch.setattr(orchestrator.context_builder, "build", lambda p: _prompt_package())

    deltas: list[tuple[str, str]] = []

    def fake_generate(package, *, cancel=None, on_delta=None):
        # mirrors what providers.complete does: one bare text arg
        on_delta("token part ")
        on_delta("token part 2")
        return "GOOD BODY"

    monkeypatch.setattr(orchestrator.writing_service, "generate", fake_generate)
    monkeypatch.setattr(orchestrator.validation_service, "check", lambda *a, **k: [])

    def on_delta(section_id: str, text: str) -> None:
        deltas.append((section_id, text))

    results = orchestrator.run("proj", store, prompt="rewrite the report", on_delta=on_delta)

    assert results["s1"].status == "generated"
    assert deltas == [("s1", "token part "), ("s1", "token part 2")]


# -- md_rewriter.format_section (auto-format path) ------------------------


def test_format_section_regenerates_body_in_place(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_sections("proj", [_section("s1", "Week One")])
    s = store.get_sections("proj")[0]
    s.content = [ContentUnit(text="Draft paragraph one.", kind="paragraph")]
    store.save_sections("proj", [s])

    captured: dict = {}

    def fake_generate(package, *, cancel=None, on_delta=None):
        captured["has_original"] = "Draft paragraph one." in package.template
        return "## Clean Heading\n\nReformatted body."

    monkeypatch.setattr(md_rewriter.writing_service, "generate", fake_generate)
    monkeypatch.setattr(md_rewriter.validation_service, "check", lambda sid, text, **kw: [])

    result = md_rewriter.format_section("proj", "s1", store)

    assert result.status == "generated"
    assert result.text == "## Clean Heading\n\nReformatted body."
    assert captured["has_original"] is True


def test_format_section_uses_stored_generation_when_present(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])
    store.save_generation("proj", "s1", _result("s1", "OLD GENERATED BODY"))

    seen_texts: list[str] = []

    def fake_generate(package, *, cancel=None, on_delta=None):
        seen_texts.append(package.template)
        return "## Clean Heading\n\nReformatted."

    monkeypatch.setattr(md_rewriter.writing_service, "generate", fake_generate)
    monkeypatch.setattr(md_rewriter.validation_service, "check", lambda sid, text, **kw: [])

    result = md_rewriter.format_section("proj", "s1", store)

    assert result.status == "generated"
    assert "OLD GENERATED BODY" in seen_texts[0]


def test_format_section_fails_with_warning_when_no_text(monkeypatch):
    store = _seed_store([_section("s1", "Week One")])

    result = md_rewriter.format_section("proj", "s1", store)

    assert result.status == "failed"
    assert result.error == "section has no text to format"
    assert result.text == ""
