"""Unit tests for the Textual TUI (quill_engine.tui) using a fake runner."""

import logging
import time
from collections import deque

import pytest
from textual.widgets import Button, Input, OptionList, Static, TextArea

from quill_engine import config, orchestrator, thinking_service
from quill_engine.models import GenerationResult, MergeResult, Section, SourceRef
from quill_engine.thinking_service import FollowUpQuestion, TemplateSection
from quill_engine.tui import (
    BusySpinner,
    ChatScreen,
    CommandsScreen,
    PreviewScreen,
    QuillTuiApp,
    RealPipelineRunner,
    SectionEditModal,
    StartScreen,
)


def _section(section_id: str, title: str) -> Section:
    return Section(
        section_id=section_id,
        title=title,
        level=1,
        order=1,
        parent_id=None,
        word_count=40,
    )


def _result(
    section_id: str,
    status: str = "generated",
    sources: list[SourceRef] | None = None,
    model: str = "",
) -> GenerationResult:
    return GenerationResult(
        section_id=section_id,
        text=f"text of {section_id}" if status == "generated" else "",
        status=status,
        missing_fields=[],
        sources=sources or [],
        model=model,
    )


class FakeRunner:
    """RealPipelineRunner stand-in; deterministic, instant, no I/O."""

    def __init__(self, sections, result_sets, run_delay: float = 0.0):
        self.project_id = "proj_test"
        self.store = orchestrator.new_store()
        self.store.save_sections(self.project_id, sections)
        self._sections = sections
        self._result_sets = deque(result_sets)
        self.run_delay = run_delay
        self.run_calls = 0
        self.run_prompts: list[str] = []
        self.run_references: list[list[tuple[str, str]]] = []
        self.rewrite_calls = 0
        self.rewrite_prompts: list[str] = []
        self.rewrite_targets: list[list[str]] = []
        self.rewrite_references: list[list[tuple[str, str]]] = []
        self.merge_calls = 0
        self.merge_thresholds: list[float | None] = []
        self.evidence_saved: list[dict[str, str]] = []
        self.export_called = False
        self.export_path = "/tmp/out/report.md"
        self.preview_calls = 0
        self.template_added: list[str] = []

    def ingest(self) -> str:
        return self.project_id

    def sections(self):
        return self._sections

    def append_template(self, template) -> int:
        added = 0
        for item in template:
            title = item.title.strip()
            if not title or any(s.title == title for s in self._sections):
                continue
            self._sections.append(
                _section(f"tmpl_{len(self.template_added)}", title)
            )
            self.template_added.append(title)
            added += 1
        return added

    def run(self, prompt, on_progress, on_stream, *, cancel=None, references=()):
        self.run_calls += 1
        self.run_prompts.append(prompt)
        self.run_references.append(list(references))
        if self.run_delay:
            time.sleep(self.run_delay)
        if len(self._result_sets) > 1:
            results = self._result_sets.popleft()
        else:
            results = self._result_sets[0]
        partial = {}
        total = max(1, len(results))
        for i, (section_id, result) in enumerate(results.items()):
            if cancel is not None and cancel():
                break
            partial[section_id] = result
            on_progress(section_id, result.status, (i + 1) / total)
            if result.status == "generated":
                on_stream(section_id, result.text)
        return partial

    def rewrite(self, prompt, section_ids, on_progress, on_stream, *, cancel=None, references=()):
        self.rewrite_calls += 1
        self.rewrite_prompts.append(prompt)
        self.rewrite_targets.append(list(section_ids))
        self.rewrite_references.append(list(references))
        partial = {}
        total = max(1, len(section_ids))
        for i, section_id in enumerate(section_ids):
            if cancel is not None and cancel():
                break
            result = _result(section_id, "generated")
            partial[section_id] = result
            on_progress(section_id, "generated", (i + 1) / total)
            on_stream(section_id, result.text)
        return partial

    def merge_similar_sections(self, on_progress, *, threshold=None, cancel=None):
        self.merge_calls += 1
        self.merge_thresholds.append(threshold)
        results = []
        total = max(1, len(self._sections))
        for i, section in enumerate(self._sections):
            if cancel is not None and cancel():
                break
            on_progress(section.section_id, "merging", (i + 1) / total)
            if i + 1 < len(self._sections):
                results.append(
                    MergeResult(section.section_id, self._sections[i + 1].section_id, 0.9)
                )
                break
        return results

    def save_evidence(self, answers):
        self.evidence_saved.append(answers)

    def get_evidence(self):
        return {}

    def export(self) -> str:
        self.export_called = True
        return self.export_path

    def preview(self) -> str:
        self.preview_calls += 1
        return "# Week One\n\npreview body"


async def _wait_until(pilot, predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        await pilot.pause(0.02)
        if predicate():
            return True
    return False


def _success_bodies(app) -> list[str]:
    return [str(m.content) for m in app.screen.query("#chat_log .msg-success .msg-body")]


def _system_bodies(app) -> list[str]:
    return [str(m.content) for m in app.screen.query("#chat_log .msg-system .msg-body")]


def _has_evidence_form(app) -> bool:
    return len(list(app.screen.query("#evidence_form"))) > 0


async def _press_button(pilot, selector: str) -> None:
    pilot.app.screen.query_one(selector, Button).focus()
    await pilot.pause()
    await pilot.press("enter")


@pytest.mark.asyncio
async def test_mounts_chat_screen_with_file_path():
    app = QuillTuiApp("sample.md", runner=FakeRunner([], []))
    async with app.run_test() as pilot:
        await pilot.pause()
        assert isinstance(app.screen, ChatScreen)
        assert app.screen.file_path == "sample.md"
        assert app.screen.query_one("#chat_log") is not None
        assert app.screen.query_one("#prompt_input", TextArea) is not None
        assert app.screen.query_one("#sections_pane") is not None
        assert app.screen.query_one("#inspector_pane") is not None
        assert app.screen.query_one("#input_bar") is not None


@pytest.mark.asyncio
async def test_mounts_start_screen_without_file_path():
    app = QuillTuiApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        assert isinstance(app.screen, StartScreen)
        assert app.screen.query_one("#file_list", OptionList) is not None
        assert app.screen.query_one("#path_input", Input) is not None


@pytest.mark.asyncio
async def test_start_screen_highlights_first_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "report.md").write_text("# Week One\n")
    app = QuillTuiApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        assert isinstance(app.screen, StartScreen)
        options = app.screen.query_one("#file_list", OptionList)
        assert options.option_count == 1
        assert options.highlighted == 0
        assert options.has_focus


@pytest.mark.asyncio
async def test_start_screen_opens_file_into_chat(tmp_path):
    report = tmp_path / "report.md"
    report.write_text("# Week One\n")
    app = QuillTuiApp(runner=FakeRunner([], []))
    async with app.run_test(size=(90, 35)) as pilot:
        await pilot.pause()
        assert isinstance(app.screen, StartScreen)
        app.screen.query_one("#path_input", Input).value = str(report)
        await pilot.click("#open_button")
        assert await _wait_until(
            pilot, lambda: isinstance(app.screen, ChatScreen)
        ), f"screen={app.screen!r}"


@pytest.mark.asyncio
async def test_start_screen_enter_selects_highlighted_option(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "report.md").write_text("# Week One\n")
    app = QuillTuiApp(runner=FakeRunner([], []))
    async with app.run_test() as pilot:
        await pilot.pause()
        assert isinstance(app.screen, StartScreen)
        await pilot.press("enter")
        assert await _wait_until(
            pilot, lambda: isinstance(app.screen, ChatScreen)
        ), f"screen={app.screen!r}"
        assert app.screen.file_path == str(tmp_path / "report.md")


@pytest.mark.asyncio
async def test_full_generation_reaches_results():
    sections = [_section("s1", "Week One"), _section("s2", "Week Two")]
    results = {"s1": _result("s1"), "s2": _result("s2")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "test task"
        await pilot.press("enter")
        assert await _wait_until(
            pilot,
            lambda: any(
                "Generated 2 sections, 0 blocked, 0 failed" in body for body in _success_bodies(app)
            ),
        ), f"bodies={_success_bodies(app)}"
        assert runner.run_calls == 1
        assert runner.export_called
        assert any("Exported: /tmp/out/report.md" in body for body in _success_bodies(app))
        assert len(app.screen.query_one("#sections_tree").root.children) == 2


@pytest.mark.asyncio
async def test_blocked_section_shows_form_then_retries():
    sections = [_section("s1", "Week One")]
    first_pass = {"s1": _result("s1", status="blocked")}
    second_pass = {"s1": _result("s1")}
    runner = FakeRunner(sections, [first_pass, second_pass])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: _has_evidence_form(app)), "evidence form never appeared"
        form = app.screen.query_one("#evidence_form")
        # "Week One" rule needs dates, activities, locations, supervisors.
        assert len(list(form.query("Input"))) == 4
        form.query_one("#ev_dates", Input).value = "Monday 3 March"
        await _press_button(pilot, "#submit_evidence")
        assert runner.evidence_saved == [{"dates": "Monday 3 March"}]
        assert runner.run_calls == 2
        assert await _wait_until(
            pilot,
            lambda: any(
                "Generated 1 sections, 0 blocked, 0 failed" in body for body in _success_bodies(app)
            ),
        ), f"bodies={_success_bodies(app)}"


@pytest.mark.asyncio
async def test_skip_evidence_goes_to_results():
    sections = [_section("s1", "Week One")]
    first_pass = {"s1": _result("s1", status="blocked")}
    runner = FakeRunner(sections, [first_pass])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: _has_evidence_form(app)), "evidence form never appeared"
        await _press_button(pilot, "#skip_evidence")
        assert await _wait_until(
            pilot,
            lambda: any("Exported: /tmp/out/report.md" in body for body in _success_bodies(app)),
        ), f"bodies={_success_bodies(app)}"
        assert runner.run_calls == 1
        assert runner.export_called


@pytest.mark.asyncio
async def test_evidence_form_dedupes_shared_fields():
    # Two blocked sections both require "context": the form must render a
    # single input for the shared field or widget ids collide (MountError).
    sections = [_section("s1", "Introduction"), _section("s2", "Background")]
    blocked = {
        "s1": _result("s1", status="blocked"),
        "s2": _result("s2", status="blocked"),
    }
    runner = FakeRunner(sections, [blocked])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: _has_evidence_form(app)), "evidence form never appeared"
        form = app.screen.query_one("#evidence_form")
        inputs = list(form.query("Input"))
        assert len(inputs) == 1
        assert inputs[0].id == "ev_context"
        inputs[0].value = "SWEP context"
        await _press_button(pilot, "#submit_evidence")
        assert runner.evidence_saved == [{"context": "SWEP context"}]
        assert runner.run_calls == 2


@pytest.mark.asyncio
async def test_three_pane_layout_mounts():
    app = QuillTuiApp("sample.md", runner=FakeRunner([], []))
    async with app.run_test(size=(160, 40)) as pilot:
        await pilot.pause()
        assert app.screen.query_one("#sections_pane") is not None
        assert app.screen.query_one("#main_pane") is not None
        assert app.screen.query_one("#inspector_pane") is not None
        # wide terminals show both side panes via the responsive class
        assert "auto" in app.screen.query_one("#sections_pane").classes
        assert "auto" in app.screen.query_one("#inspector_pane").classes
        # the command bar spans the full app, outside the chat pane
        input_bar = app.screen.query_one("#input_bar")
        assert input_bar.parent is not None
        assert input_bar.parent.id == "app_root"
        # the sections tree lives inside the left pane
        tree = app.screen.query_one("#sections_tree")
        assert tree.parent is not None
        assert tree.parent.id == "sections_pane"


@pytest.mark.asyncio
async def test_roles_render_you_ai():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(
            pilot,
            lambda: any("Exported: /tmp/out/report.md" in body for body in _success_bodies(app)),
        ), f"bodies={_success_bodies(app)}"
        roles = [str(m.content) for m in app.screen.query("#chat_log .msg-role")]
        assert "You" in roles, f"roles={roles}"
        assert "Quill" in roles, f"roles={roles}"


# -- modes: generate / rewrite -------------------------------------------


def _mode_chip(app) -> str:
    return app.screen.query_one("#input_mode").content


@pytest.mark.asyncio
async def test_tab_toggles_mode():
    app = QuillTuiApp("sample.md", runner=FakeRunner([], []))
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.mode == "generate"
        assert "mode: generate" in _mode_chip(app)
        await pilot.press("tab")
        assert app.mode == "rewrite"
        assert "mode: rewrite" in _mode_chip(app)
        await pilot.press("tab")
        assert app.mode == "generate"


@pytest.mark.asyncio
async def test_status_label_shows_during_run_then_clears():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results], run_delay=0.15)
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(
            pilot, lambda: len(list(app.screen.query(".msg-status"))) == 1
        ), "status label never appeared"
        assert "thinking…" in app.screen.query_one(".msg-status .msg-body").content
        assert await _wait_until(
            pilot, lambda: any("Exported" in body for body in _success_bodies(app))
        ), f"bodies={_success_bodies(app)}"
        assert len(list(app.screen.query(".msg-status"))) == 0, "status label not cleared"


@pytest.mark.asyncio
async def test_generate_auto_switches_to_rewrite():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "first task"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: app.mode == "rewrite"), "no auto-switch"
        assert "mode: rewrite" in _mode_chip(app)
        assert runner.rewrite_calls == 0


@pytest.mark.asyncio
async def test_rewrite_mode_rewrites_selected_section():
    sections = [_section("s1", "Week One"), _section("s2", "Week Two")]
    results = {"s1": _result("s1"), "s2": _result("s2")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        # generate first: populates the tree and auto-switches to rewrite
        app.screen.query_one("#prompt_input", TextArea).text = "first task"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: app.mode == "rewrite"), "no auto-switch"
        # select s1 in the tree, then rewrite it
        tree = app.screen.query_one("#sections_tree")
        tree.move_cursor(tree.root.children[0])
        app.screen.query_one("#prompt_input", TextArea).text = "make it formal"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: runner.rewrite_calls == 1), "rewrite never ran"
        assert runner.rewrite_prompts == ["make it formal"]
        assert runner.rewrite_targets == [["s1"]]
        assert await _wait_until(
            pilot,
            lambda: any("Generated 1 sections" in body for body in _success_bodies(app)),
        ), f"bodies={_success_bodies(app)}"
        assert app.mode == "rewrite"  # rewrite stays in rewrite mode


@pytest.mark.asyncio
async def test_rewrite_without_selection_passes_empty_targets():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "first task"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: app.mode == "rewrite"), "no auto-switch"
        # no tree selection: the TUI passes [] and the orchestrator falls back
        app.screen.query_one("#prompt_input", TextArea).text = "tighten it up"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: runner.rewrite_calls == 1), "rewrite never ran"
        assert runner.rewrite_targets == [[]]


# -- section editing (rename / add / replace) -----------------------------


async def _run_to_rewrite(app, pilot, runner, sections):
    """Generate once (populates tree), then return the tree."""
    app.screen.query_one("#prompt_input", TextArea).text = "first task"
    await pilot.press("enter")
    assert await _wait_until(pilot, lambda: app.mode == "rewrite"), "no auto-switch"
    return app.screen.query_one("#sections_tree")


@pytest.mark.asyncio
async def test_rename_section_retitles_and_rewrites():
    sections = [_section("s1", "Week One"), _section("s2", "Week Two")]
    results = {"s1": _result("s1"), "s2": _result("s2")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        tree = await _run_to_rewrite(app, pilot, runner, sections)
        tree.move_cursor(tree.root.children[0])
        await pilot.press("ctrl+r")
        assert isinstance(app.screen, SectionEditModal), "modal did not open"
        inp = app.screen.query_one("#section_edit_input", Input)
        inp.value = "Week One Revised"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: runner.rewrite_calls == 1), "rewrite never ran"
        stored = runner.store.get_sections("proj_test")
        assert stored[0].title == "Week One Revised"
        assert runner.rewrite_targets == [["s1"]]


@pytest.mark.asyncio
async def test_add_section_inserts_and_rewrites():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        await _run_to_rewrite(app, pilot, runner, sections)
        await pilot.press("ctrl+a")
        assert isinstance(app.screen, SectionEditModal), "modal did not open"
        inp = app.screen.query_one("#section_edit_input", Input)
        inp.value = "Week Three"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: runner.rewrite_calls == 1), "rewrite never ran"
        stored = runner.store.get_sections("proj_test")
        assert len(stored) == 2
        assert stored[1].title == "Week Three"
        assert len(runner.rewrite_targets[0]) == 1
        assert runner.rewrite_targets[0][0] != "s1"


@pytest.mark.asyncio
async def test_replace_section_targets_selected_leaves():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        tree = await _run_to_rewrite(app, pilot, runner, sections)
        tree.move_cursor(tree.root.children[0])
        await pilot.press("ctrl+t")
        assert isinstance(app.screen, SectionEditModal), "modal did not open"
        inp = app.screen.query_one("#section_edit_input", Input)
        inp.value = "focus on safety"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: runner.rewrite_calls == 1), "rewrite never ran"
        assert runner.rewrite_prompts == ["focus on safety"]
        assert runner.rewrite_targets == [["s1"]]


@pytest.mark.asyncio
async def test_edit_modal_escape_cancels_without_rewrite():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        tree = await _run_to_rewrite(app, pilot, runner, sections)
        tree.move_cursor(tree.root.children[0])
        await pilot.press("ctrl+r")
        assert isinstance(app.screen, SectionEditModal), "modal did not open"
        await pilot.press("escape")
        assert not isinstance(app.screen, SectionEditModal), "modal did not close"
        assert runner.rewrite_calls == 0


# -- sources + preview modal ---------------------------------------------


def _with_sources():
    return [
        SourceRef(title="Example page", url="https://example.com/a", kind="web"),
        SourceRef(title="Memory note", url="", kind="memory"),
    ]


@pytest.mark.asyncio
async def test_run_appends_sources_message_and_inspector():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1", sources=_with_sources())}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(
            pilot,
            lambda: any("Sources:" in body for body in _success_bodies(app))
            or any(
                "Sources:" in str(m.content)
                for m in app.screen.query("#chat_log .msg-system .msg-body")
            ),
        ), "sources message never appeared"
        insp = app.screen.query_one("#insp_sources")
        assert "Example page" in str(insp.content)
        assert "Memory note" in str(insp.content)


@pytest.mark.asyncio
async def test_preview_keybinding_opens_preview_screen():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        # no results yet: preview is guarded
        await pilot.press("ctrl+o")
        assert isinstance(app.screen, ChatScreen)
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(
            pilot, lambda: any("Exported" in body for body in _success_bodies(app))
        ), f"bodies={_success_bodies(app)}"
        await pilot.press("ctrl+o")
        assert isinstance(app.screen, PreviewScreen), f"screen={app.screen!r}"
        body = app.screen.query_one("#preview_content")
        assert "Week One" in body.content
        assert runner.preview_calls == 1
        await pilot.press("escape")
        assert isinstance(app.screen, ChatScreen)


@pytest.mark.asyncio
async def test_command_palette_opens_preview_screen():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(
            pilot, lambda: any("Exported" in body for body in _success_bodies(app))
        ), f"bodies={_success_bodies(app)}"
        await pilot.press("ctrl+p")
        assert isinstance(app.screen, CommandsScreen), f"screen={app.screen!r}"
        palette = app.screen.query_one("#commands_list", OptionList)
        palette.highlighted = 5  # "Preview document (ctrl+o)"
        await pilot.press("enter")
        assert isinstance(app.screen, PreviewScreen), f"screen={app.screen!r}"
        await _press_button(pilot, "#close_preview")
        assert isinstance(app.screen, ChatScreen)


@pytest.mark.asyncio
async def test_command_palette_opens_and_closes():
    app = QuillTuiApp("sample.md", runner=FakeRunner([], []))
    async with app.run_test() as pilot:
        await pilot.pause()
        assert isinstance(app.screen, ChatScreen)
        await pilot.press("ctrl+p")
        assert isinstance(app.screen, CommandsScreen), f"screen={app.screen!r}"
        await pilot.press("escape")
        assert isinstance(app.screen, ChatScreen), f"screen={app.screen!r}"


@pytest.mark.asyncio
async def test_command_palette_select_runs_action():
    app = QuillTuiApp("sample.md", runner=FakeRunner([], []))
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.mode == "generate"
        await pilot.press("ctrl+p")
        palette = app.screen.query_one("#commands_list", OptionList)
        palette.highlighted = 2  # "Toggle mode (tab)"
        await pilot.press("enter")
        assert isinstance(app.screen, ChatScreen), f"screen={app.screen!r}"
        assert app.mode == "rewrite"


@pytest.mark.asyncio
async def test_multiline_input_shift_enter_newline_then_enter_submits():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        prompt = app.screen.query_one("#prompt_input", TextArea)
        prompt.focus()
        await pilot.press("a")
        await pilot.press("shift+enter")
        await pilot.press("b")
        assert prompt.text == "a\nb"
        assert runner.run_calls == 0  # shift+enter inserts a newline, does not submit
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: runner.run_calls == 1), "enter never submitted"
        assert runner.run_prompts == ["a\nb"]


@pytest.mark.asyncio
async def test_ctrl_s_legacy_submit_alias():
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        prompt = app.screen.query_one("#prompt_input", TextArea)
        prompt.focus()
        await pilot.press("a")
        await pilot.press("ctrl+s")
        assert await _wait_until(pilot, lambda: runner.run_calls == 1), "ctrl+s never submitted"
        assert runner.run_prompts == ["a"]


# -- session + model ------------------------------------------------------


@pytest.mark.asyncio
async def test_inspector_shows_session_at_mount():
    app = QuillTuiApp("sample.md", runner=FakeRunner([], []))
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.session_id
        session_line = str(app.screen.query_one("#side_session").content)
        assert session_line.startswith("session:")
        assert app.session_id in session_line
        started = time.strftime("%H:%M:%S", time.localtime(app.started_at))
        assert started in session_line
        model_line = str(app.screen.query_one("#input_model").content)
        assert model_line.startswith("model:")
        assert model_line != "model: —"


@pytest.mark.asyncio
async def test_run_updates_inspector_model_from_results():
    sections = [_section("s1", "Week One"), _section("s2", "Week Two")]
    results = {
        "s1": _result("s1", model="groq/llama-3.3-70b-versatile"),
        "s2": _result("s2", model="groq/llama-3.3-70b-versatile"),
    }
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        assert await _wait_until(
            pilot, lambda: any("Exported" in body for body in _success_bodies(app))
        ), f"bodies={_success_bodies(app)}"
        model_line = str(app.screen.query_one("#input_model").content)
        assert "groq/llama-3.3-70b-versatile" in model_line


@pytest.mark.asyncio
async def test_opening_new_file_starts_new_session(tmp_path):
    report = tmp_path / "report.md"
    report.write_text("# Week One\n")
    app = QuillTuiApp(runner=FakeRunner([], []))
    async with app.run_test(size=(90, 35)) as pilot:
        await pilot.pause()
        assert isinstance(app.screen, StartScreen)
        first_id = app.session_id
        app.screen.query_one("#path_input", Input).value = str(report)
        await pilot.click("#open_button")
        assert await _wait_until(
            pilot, lambda: isinstance(app.screen, ChatScreen)
        ), f"screen={app.screen!r}"
        assert app.session_id != first_id


# -- stop button + chat logs -----------------------------------------------


@pytest.mark.asyncio
async def test_escape_stops_run_and_reenables_input():
    sections = [_section("s1", "Week One"), _section("s2", "Week Two")]
    results = {"s1": _result("s1"), "s2": _result("s2")}
    runner = FakeRunner(sections, [results], run_delay=1.0)
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "task"
        await pilot.press("enter")
        busy = app.screen.query_one("#busy_indicator", BusySpinner)
        assert await _wait_until(pilot, lambda: busy.display), "busy indicator never appeared"
        await pilot.press("escape")
        assert await _wait_until(pilot, lambda: app._stop_requested), "stop flag never set"
        assert await _wait_until(
            pilot,
            lambda: any(
                "stopped" in str(m.content)
                for m in app.screen.query("#chat_log .msg-status .msg-body")
            ),
        ), "no stopped message"
        assert not app._pipeline_running
        assert not app.screen.query_one("#prompt_input", TextArea).disabled
        assert not runner.export_called


@pytest.mark.asyncio
async def test_quill_engine_logs_appear_in_chat():
    app = QuillTuiApp("sample.md", runner=FakeRunner([], []))
    async with app.run_test() as pilot:
        await pilot.pause()
        logging.getLogger("quill_engine").info("chat log marker")
        await pilot.pause()
        bodies = [str(m.content) for m in app.screen.query("#chat_log .msg-log .msg-body")]
        assert any("chat log marker" in body for body in bodies), f"bodies={bodies}"


# -- interview (pause before generation) -----------------------------------


def _template_bodies(app) -> list[str]:
    return [str(m.content) for m in app.screen.query("#chat_log .msg-template .msg-body")]


def _question_bodies(app) -> list[str]:
    return [str(m.content) for m in app.screen.query("#chat_log .msg-question .msg-body")]


@pytest.mark.asyncio
async def test_interview_template_confirm_adds_sections(monkeypatch):
    monkeypatch.setattr(thinking_service, "build_followups", lambda prompt, sections: [])
    monkeypatch.setattr(
        thinking_service,
        "extract_template",
        lambda prompt, sections: [
            TemplateSection("Budget Overview", "quarterly budget"),
            TemplateSection("Risk Register", "key risks"),
        ],
    )
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "add budget and risks"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: _template_bodies(app)), "template message never appeared"
        app.screen.query_one("#prompt_input", TextArea).text = "yes"
        await pilot.press("enter")
        assert await _wait_until(
            pilot,
            lambda: any("Exported:" in body for body in _success_bodies(app)),
        ), f"bodies={_success_bodies(app)}"
        assert runner.template_added == ["Budget Overview", "Risk Register"]
        assert runner.run_calls == 1


@pytest.mark.asyncio
async def test_interview_template_subset_selection(monkeypatch):
    monkeypatch.setattr(thinking_service, "build_followups", lambda prompt, sections: [])
    monkeypatch.setattr(
        thinking_service,
        "extract_template",
        lambda prompt, sections: [
            TemplateSection("Budget Overview", "quarterly budget"),
            TemplateSection("Risk Register", "key risks"),
            TemplateSection("Timeline", "delivery dates"),
        ],
    )
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "add sections"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: _template_bodies(app)), "template message never appeared"
        app.screen.query_one("#prompt_input", TextArea).text = "1,3"
        await pilot.press("enter")
        assert await _wait_until(
            pilot,
            lambda: any("Exported:" in body for body in _success_bodies(app)),
        ), f"bodies={_success_bodies(app)}"
        assert runner.template_added == ["Budget Overview", "Timeline"]
        assert runner.run_calls == 1


@pytest.mark.asyncio
async def test_interview_template_declined_adds_nothing(monkeypatch):
    monkeypatch.setattr(thinking_service, "build_followups", lambda prompt, sections: [])
    monkeypatch.setattr(
        thinking_service,
        "extract_template",
        lambda prompt, sections: [TemplateSection("Budget Overview", "quarterly budget")],
    )
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "add a budget"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: _template_bodies(app)), "template message never appeared"
        app.screen.query_one("#prompt_input", TextArea).text = "no"
        await pilot.press("enter")
        assert await _wait_until(
            pilot,
            lambda: any("Exported:" in body for body in _success_bodies(app)),
        ), f"bodies={_success_bodies(app)}"
        assert runner.template_added == []
        assert runner.run_calls == 1


@pytest.mark.asyncio
async def test_interview_answer_merged_into_prompt(monkeypatch):
    monkeypatch.setattr(
        thinking_service,
        "build_followups",
        lambda prompt, sections: [
            FollowUpQuestion(field="tone", question="What tone should the report use?", kind="text")
        ],
    )
    monkeypatch.setattr(thinking_service, "extract_template", lambda prompt, sections: [])
    sections = [_section("s1", "Week One")]
    results = {"s1": _result("s1")}
    runner = FakeRunner(sections, [results])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "rewrite the report"
        await pilot.press("enter")
        assert await _wait_until(pilot, lambda: _question_bodies(app)), "question never appeared"
        app.screen.query_one("#prompt_input", TextArea).text = "professional"
        await pilot.press("enter")
        assert await _wait_until(
            pilot,
            lambda: any("Exported:" in body for body in _success_bodies(app)),
        ), f"bodies={_success_bodies(app)}"
        assert runner.run_prompts and "professional" in runner.run_prompts[0], (
            f"prompts={runner.run_prompts}"
        )
        assert runner.run_calls == 1


def test_chapter_number_parses_arabic_roman_and_words():
    from quill_engine.tui import _chapter_number

    assert _chapter_number("CHAPTER THREE: – MATERIALS AND SUPPLIES") == 3
    assert _chapter_number("CHAPTER 3") == 3
    assert _chapter_number("CHAPTER V") == 5
    assert _chapter_number("3: Introduction") == 3
    assert _chapter_number("3.1 ORIENTATION OF MATERIALS") == 3
    assert _chapter_number("Work Experience") is None


def test_is_subsection_matches_numbered_titles():
    from quill_engine.tui import _is_subsection

    assert _is_subsection("3.1 ORIENTATION OF MATERIALS") is True
    assert _is_subsection("CHAPTER THREE") is False
    assert _is_subsection("Work Experience") is False


def test_append_template_nests_subsections_under_chapters():
    from quill_engine.storage import InMemoryStore
    from quill_engine.tui import RealPipelineRunner

    store = InMemoryStore()
    store.save_sections(
        "proj_t",
        [
            Section(
                section_id="c1",
                title="CHAPTER ONE",
                level=1,
                order=1,
                parent_id=None,
            )
        ],
    )
    runner = RealPipelineRunner("sample.md", store=store)
    runner.project_id = "proj_t"
    added = runner.append_template(
        [
            TemplateSection("CHAPTER THREE: – MATERIALS AND SUPPLIES", "materials"),
            TemplateSection("3.1 ORIENTATION OF MATERIALS", "orientation"),
            TemplateSection("3.2 SUPPLY CHAIN MANAGEMENT", "chain"),
        ]
    )
    assert added == 3
    sections = store.get_sections("proj_t")
    chapter_three = next(s for s in sections if "CHAPTER THREE" in s.title)
    assert len(chapter_three.children) == 2
    assert [c.title for c in chapter_three.children] == [
        "3.1 ORIENTATION OF MATERIALS",
        "3.2 SUPPLY CHAIN MANAGEMENT",
    ]
    assert all(c.parent_id == chapter_three.section_id for c in chapter_three.children)


# -- /merge command ----------------------------------------------------------


@pytest.mark.asyncio
async def test_merge_command_runs_project_wide_pass():
    sections = [_section("s1", "Week One"), _section("s2", "Week One")]
    runner = FakeRunner(sections, [])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "/merge"
        await pilot.press("enter")
        assert await _wait_until(
            pilot, lambda: runner.merge_calls == 1
        ), "merge never ran"
        bodies = _system_bodies(app)
        assert any("Merge complete" in b for b in bodies)


@pytest.mark.asyncio
async def test_merge_command_with_threshold_arg():
    sections = [_section("s1", "Week One"), _section("s2", "Week One")]
    runner = FakeRunner(sections, [])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "/merge 0.9"
        await pilot.press("enter")
        assert await _wait_until(
            pilot, lambda: runner.merge_calls == 1
        ), "merge never ran"
        assert runner.merge_thresholds == [0.9]


@pytest.mark.asyncio
async def test_merge_command_rejects_invalid_threshold():
    sections = [_section("s1", "Week One")]
    runner = FakeRunner(sections, [])
    app = QuillTuiApp("sample.md", runner=runner)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.query_one("#prompt_input", TextArea).text = "/merge banana"
        await pilot.press("enter")
        await pilot.pause(0.05)
        assert runner.merge_calls == 0
        assert not app._pipeline_running
