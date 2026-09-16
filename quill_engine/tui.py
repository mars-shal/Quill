"""Textual TUI for quill_engine — a WriteLab-style chat workspace.

Three-pane layout: Sections (tree) / Chat / Inspector, with a full-width
command bar, matching the OpenCode design language (near-black base,
monochrome grays, one blue accent used sparingly). The pipeline
(ingest -> generate -> export) renders as chat messages in You:/AI:
turns; blocked sections get an inline evidence form in the chat. Theme
and keybindings come from ``tui.json`` — builtin defaults, then
``~/.config/quill_engine/tui.json``, then the project root, then the
current directory (later overrides earlier); ``"none"`` theme inherits
the terminal's native colors. The pipeline runs in a thread worker;
every UI touch goes through ``call_from_thread``. Never uses
questionary.
"""

from __future__ import annotations

import json
import logging
import multiprocessing
import os
import re
import sys
import textwrap
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.theme import Theme
from textual.widgets import (
    Button,
    Input,
    OptionList,
    ProgressBar,
    Static,
    TextArea,
    Tree,
)
from textual.worker import Worker, WorkerState, get_current_worker

if TYPE_CHECKING:
    from textual.widgets._tree import TreeNode

from . import config, orchestrator, providers, questionnaire, reference_service, requirement_service, thinking_service
from .export_service import export, preview as preview_document
from .logging_setup import log_file_path, setup_file_logging
from .models import (
    GenerationResult,
    MergeResult,
    Section,
    SourceRef,
    count_words,
    find_section,
    insert_section,
    new_section,
    walk_sections,
)
from .thinking_service import TemplateSection
from .writing_service import GenerationCancelled

_STATUS_STYLE = {
    "pending": "",
    "generating": "cyan",
    "generated": "green",
    "blocked": "yellow",
    "failed": "red",
    "skipped": "dim",
    "research": "magenta",
}

_ROLE_LABELS = {
    "prompt": "You",
    "system": "Quill",
    "section": "Quill",
    "stream": "Quill",
    "status": "Quill",
    "error": "Error",
    "log": "log",
    "template": "Quill",
    "question": "Quill",
    "success": "Quill",
}

_SUPPORTED_EXTS = (".docx", ".pdf", ".pptx", ".md", ".txt")

# ---------------------------------------------------------------------------
# tui.json — theme + keybindings (OpenCode design language by default)
# ---------------------------------------------------------------------------

# OpenCode palette: near-black base, monochrome grays, one blue accent used
# sparingly for focus, active elements, and the user prompt marker.
_BUILTIN_THEME = {
    "name": "opencode",
    "mode": "dark",  # dark | light | auto
    "colors": {
        "primary": "#4a9eff",
        "secondary": "#6b7683",
        "accent": "#4a9eff",
        "background": "#0a0a0c",
        "surface": "#101014",
        "panel": "#16161b",
        "foreground": "#a8adb5",
        "text_muted": "#5c6370",
        "error": "#e5484d",
        "success": "#46a758",
        "warning": "#f5a623",
    },
}

_BUILTIN_KEYBINDINGS = {
    "submit": "enter",
    "quit": "ctrl+q",
    "toggle_sidebar": "ctrl+b",
    "toggle_mode": "tab",
    "focus_input": "/",
    "preview": "ctrl+o",
    "export": "ctrl+e",
    "commands": "ctrl+p",
    "stop": "escape",
    "section_rename": "ctrl+r",
    "section_add": "ctrl+a",
    "section_replace": "ctrl+t",
}


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge ``override`` into ``base`` (later wins)."""
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _config_paths() -> list[Path]:
    """Load cascade: user config dir, project root, current directory."""
    home = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    paths = [Path(home) / "quill_engine" / "tui.json", Path.cwd() / "tui.json"]
    # Nearest ancestor holding a pyproject.toml or .git is the project root.
    for parent in Path.cwd().parents:
        if (parent / "pyproject.toml").is_file() or (parent / ".git").exists():
            paths.insert(1, parent / "tui.json")
            break
    return paths


def _load_tui_config() -> dict:
    """Merge every ``tui.json`` over the builtin defaults, later wins."""
    config = {
        "theme": dict(_BUILTIN_THEME),
        "keybindings": dict(_BUILTIN_KEYBINDINGS),
    }
    for path in _config_paths():
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"warning: ignoring {path}: {exc}", file=sys.stderr)
            continue
        config = _deep_merge(config, raw)
    return config


def _detect_dark(mode: str) -> bool:
    """Resolve dark/light: explicit, else COLORFGBG, else dark."""
    if mode == "light":
        return False
    if mode == "dark":
        return True
    bg = os.environ.get("COLORFGBG", "")
    try:
        return int(bg.split(";")[1]) < 7  # bright background => light terminal
    except (IndexError, ValueError):
        return True


def _apply_theme(app: App, theme_cfg: dict) -> None:
    """Register + apply the configured theme; ``none`` inherits the terminal."""
    name = theme_cfg.get("name", "nord")
    dark = _detect_dark(theme_cfg.get("mode", "auto"))
    if name == "none":
        app.dark = dark
        return
    colors = theme_cfg.get("colors") or {}
    theme = Theme(
        name=name,
        primary=colors.get("primary", "#fab283"),
        secondary=colors.get("secondary", "#5c9cf5"),
        accent=colors.get("accent", "#9d7cd8"),
        foreground=colors.get("foreground", "#e6edf3"),
        background=colors.get("background", "#0f1115"),
        surface=colors.get("surface", "#191c22"),
        panel=colors.get("panel", "#21262e"),
        warning=colors.get("warning", "#d29922"),
        error=colors.get("error", "#f85149"),
        success=colors.get("success", "#3fb950"),
        dark=dark,
        variables={
            "text-muted": colors.get("text_muted", "#8b949e"),
            "button-color-foreground": colors.get("surface", "#191c22"),
        },
    )
    app.register_theme(theme)
    app.theme = name


def _scan_supported() -> list[str]:
    """Report files in the working directory the pipeline can ingest."""
    try:
        entries = [
            p for p in Path.cwd().iterdir() if p.is_file() and p.suffix.lower() in _SUPPORTED_EXTS
        ]
    except OSError:
        return []
    return sorted((p.name for p in entries), key=str.lower)


# ---------------------------------------------------------------------------
# Chat widgets
# ---------------------------------------------------------------------------


class Message(Vertical):
    """One chat message: role chip + body (roles carry the palette colors)."""

    def __init__(self, role: str, text: str = "", *, id: str | None = None) -> None:
        super().__init__(id=id, classes=f"msg msg-{role}")
        self.role = role
        self._text = text

    def compose(self) -> ComposeResult:
        yield Static(_ROLE_LABELS.get(self.role, self.role.upper()), classes="msg-role")
        yield Static(self._text, classes="msg-body", markup=False)

    def update_text(self, text: str) -> None:
        self._text = text
        if self.is_mounted:
            self.query_one(".msg-body", Static).update(text)


class EvidenceMessage(Message):
    """Inline evidence form for blocked sections, rendered in the chat."""

    def __init__(self, requirements: list, *, id: str | None = None) -> None:
        super().__init__("system", "", id=id)
        self.requirements = requirements

    def compose(self) -> ComposeResult:
        yield Static(_ROLE_LABELS.get(self.role, self.role.upper()), classes="msg-role")
        # One input per unique field: a single answer (e.g. "context")
        # satisfies every section requiring that field, so duplicate
        # field inputs would collide on widget ids.
        seen: set[str] = set()
        unique: list = []
        for req in self.requirements:
            if req.field not in seen:
                seen.add(req.field)
                unique.append(req)
        yield Static(
            f"{len(unique)} piece(s) of evidence are missing — "
            "sections stay blocked until they are provided:",
            classes="msg-body",
        )
        for req in unique:
            yield Input(
                placeholder=req.label,
                value=req.answer or "",
                id=f"ev_{req.field}",
            )
        with Horizontal(classes="msg-actions"):
            yield Button("Submit & retry", id="submit_evidence", variant="primary")
            yield Button("Skip to results", id="skip_evidence")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "submit_evidence":
            answers = {
                req.field: self.query_one(f"#ev_{req.field}", Input).value.strip()
                for req in self.requirements
                if self.query_one(f"#ev_{req.field}", Input).value.strip()
            }
            self.app.submit_evidence(answers)
        elif event.button.id == "skip_evidence":
            self.app.skip_evidence()


class MessageLog(VerticalScroll):
    """Scrollable chat log; appends messages and follows the tail."""

    def append(self, role: str, text: str = "") -> Message:
        msg = Message(role, text)
        self.mount(msg)
        self.scroll_end(animate=False)
        return msg

    def append_evidence(self, requirements: list) -> EvidenceMessage:
        msg = EvidenceMessage(requirements, id="evidence_form")
        self.mount(msg)
        self.scroll_end(animate=False)
        return msg


class SectionsPane(Vertical):
    """Left pane: section tree with live status glyphs."""

    _TERMINAL_GLYPH = {
        "generated": "✓ ",
        "blocked": "⛔ ",
        "failed": "✕",
        "skipped": "· ",
    }

    def compose(self) -> ComposeResult:
        yield Static("SECTIONS", classes="side-heading")
        tree = Tree("sections", id="sections_tree")
        tree.auto_expand = False
        tree.show_root = False
        yield tree

    def load_sections(self, sections: list[Section], answers: dict[str, str]) -> float | None:
        tree = self.query_one("#sections_tree", Tree)
        tree.clear()
        self._node_refs: dict[str, TreeNode] = {}
        self._titles: dict[str, str] = {}
        nodes_by_id: dict[str, TreeNode] = {}
        ratios: list[float] = []
        for section in walk_sections(sections):
            reqs = requirement_service.build_requirements(section, answers=answers)
            ratios.append(requirement_service.coverage(reqs))
            parent = nodes_by_id.get(section.parent_id)
            node = (
                parent.add(section.title, data=section)
                if parent is not None
                else tree.root.add(section.title, data=section)
            )
            nodes_by_id[section.section_id] = node
            self._node_refs[section.section_id] = node
            self._titles[section.section_id] = section.title
        tree.root.expand()
        return sum(ratios) / len(ratios) if ratios else None

    def title_for(self, section_id: str) -> str:
        return self._titles.get(section_id, section_id)

    def update_section(self, section_id: str, status: str) -> None:
        node = self._node_refs.get(section_id)
        if node is None:
            return
        glyph = self._TERMINAL_GLYPH.get(status, "")
        node.label = Text(
            f"{glyph}{self._titles.get(section_id, section_id)}",
            style=_STATUS_STYLE.get(status, ""),
        )
        self.query_one("#sections_tree", Tree).refresh()


class Inspector(Vertical):
    """Right pane: WriteLab Inspector — status checklist, sources, snapshot."""

    def compose(self) -> ComposeResult:
        yield Static("SESSION", classes="side-heading")
        yield Static("source: —", id="side_file", classes="side-meta")
        yield Static("project: —", id="side_project", classes="side-meta")
        yield Static("session: —", id="side_session", classes="side-meta")
        yield Static("STATUS", classes="side-heading")
        yield Static("Evidence —", id="insp_evidence", classes="side-meta")
        yield Static("Citations —", id="insp_citations", classes="side-meta")
        yield Static("Repetition —", id="insp_repetition", classes="side-meta")
        yield Static("Export pending", id="insp_export", classes="side-meta")
        yield ProgressBar(total=1.0, show_percentage=True, id="pipeline_progress")
        yield Static("SOURCES", classes="side-heading")
        yield Static("—", id="insp_sources", classes="side-meta", markup=False)
        yield Static("SNAPSHOT", classes="side-heading")
        yield Static("v1", id="snapshot", classes="side-meta")

    def set_file(self, path: str) -> None:
        self.query_one("#side_file", Static).update(f"source: {path}")

    def set_project(self, project_id: str) -> None:
        self.query_one("#side_project", Static).update(f"project: {project_id}")

    def set_session(self, session_id: str, started_at: float) -> None:
        started = time.strftime("%H:%M:%S", time.localtime(started_at))
        self.query_one("#side_session", Static).update(f"session: {session_id} · {started}")

    def set_progress(self, ratio: float) -> None:
        self.query_one("#pipeline_progress", ProgressBar).progress = ratio

    def set_coverage(self, ratio: float) -> None:
        self.query_one("#insp_evidence", Static).update(
            Text(f"✓ Evidence {ratio:.0%}", style="green")
        )

    def set_export_ready(self) -> None:
        self.query_one("#insp_export", Static).update(
            Text("✓ Export ready", style="green")
        )

    def set_sources(self, sources: list[SourceRef]) -> None:
        if not sources:
            self.query_one("#insp_sources", Static).update("—")
            return
        def _line(ref: SourceRef) -> str:
            label = f"{ref.kind}: {ref.title}"
            if ref.url:
                url = ref.url if len(ref.url) <= 40 else ref.url[:37] + "…"
                label += f" ({url})"
            return label

        lines = [_line(s) for s in sources[:6]]
        if len(sources) > 6:
            lines.append(f"… +{len(sources) - 6} more")
        self.query_one("#insp_sources", Static).update("\n".join(lines))

    def set_snapshot(self, number: int) -> None:
        self.query_one("#snapshot", Static).update(f"v{number}")


# ---------------------------------------------------------------------------
# Screens
# ---------------------------------------------------------------------------


class StartScreen(Screen[None]):
    """OpenCode-style workspace open: pick the source report."""

    def compose(self) -> ComposeResult:
        with Vertical(id="start_root"):
            yield Static(textwrap.dedent("""
                ::::::::  :::    ::: ::::::::::: :::        :::
               :+:    :+: :+:    :+:     :+:     :+:        :+:
               +:+    +:+ +:+    +:+     +:+     +:+        +:+
               +#+    +:+ +#+    +#+     +#+     +#+        +#+
               +#+  # +#+ +#+    +#+     +#+     +#+        +#+
               #+#   +#+  #+#    #+#     #+#     #+#        #+#
                ###### ### ########  ########### ########## ##########
                """), id="start_title")
            yield Static("Select a source report to generate a corrected write-up", id="start_sub")
            yield Static("", id="start_error")
            with Vertical(id="start_list"):
                yield OptionList(id="file_list")
                yield Static("↑↓ pick · enter open · type a path", id="start_hints")
                with Horizontal(id="start_path_row"):
                    yield Input(placeholder="or type a path…", id="path_input")
                    yield Button(
                        "Open", id="open_button", variant="primary",
                        tooltip="Open selected file",
                    )

    def on_mount(self) -> None:
        options = self.query_one("#file_list", OptionList)
        for name in _scan_supported():
            options.add_option(name)
        if options.option_count:
            options.highlighted = 0
            options.focus()
        else:
            self.query_one("#path_input", Input).focus()

    def on_option_list_option_selected(self, event) -> None:
        self._open(str(event.option.prompt))

    def on_input_submitted(self, event) -> None:
        if event.input.id == "path_input":
            self._open(event.value.strip())

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "open_button":
            self._open(self.query_one("#path_input", Input).value.strip())

    def open_selection(self) -> None:
        """ctrl+s: use the typed path, else the highlighted file."""
        path = self.query_one("#path_input", Input).value.strip()
        if path:
            self._open(path)
            return
        options = self.query_one("#file_list", OptionList)
        if options.highlighted is not None:
            self._open(str(options.get_option(options.highlighted).prompt))

    def _open(self, path: str) -> None:
        if not path:
            return
        resolved = Path(path).expanduser().resolve()
        if not resolved.is_file():
            self.query_one("#start_error", Static).update(f"no such file: {path}")
            return
        self.app.begin(str(resolved))


class BusySpinner(Static):
    """Animated braille spinner shown while the pipeline is running.

    Drop-in replacement for Textual's ``LoadingIndicator``: renders a compact
    braille spinner that only animates while visible, so it does not burn CPU
    when hidden (``display: none`` while idle).
    """

    FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
    INTERVAL = 0.08

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._frame_index = 0
        self._timer = None

    def on_mount(self) -> None:
        self._timer = self.set_interval(self.INTERVAL, self._spin, pause=True)
        if self.display:
            self._timer.resume()

    def on_show(self) -> None:
        if self._timer is not None:
            self._timer.resume()

    def on_hide(self) -> None:
        if self._timer is not None:
            self._timer.pause()

    def _spin(self) -> None:
        self.update(self.FRAMES[self._frame_index % len(self.FRAMES)])
        self._frame_index += 1


class PromptInput(TextArea):
    """Task input: Enter submits, Shift+Enter inserts a newline."""

    BINDINGS = [
        Binding("enter", "submit_prompt", "Send", show=False, priority=True),
        Binding("shift+enter", "insert_newline", "New line", show=False),
    ]

    def action_submit_prompt(self) -> None:
        self.app.action_submit()

    def action_insert_newline(self) -> None:
        self.insert("\n")


class CommandsScreen(Screen[None]):
    """ctrl+p: command palette listing every app action + key hint."""

    BINDINGS = [
        Binding("escape", "close_commands", "Close", priority=True),
    ]

    def compose(self) -> ComposeResult:
        with Vertical(id="commands_root"):
            yield Static("COMMANDS", id="commands_title")
            yield Static("esc to close · enter/click to run", id="commands_hint")
            yield OptionList(
                "Send message (enter)",
                "Stop generation (esc)",
                "Toggle mode (tab)",
                "Toggle panes (ctrl+b)",
                "Focus input (/)",
                "Preview document (ctrl+o)",
                "Export document (ctrl+e)",
                "Rename section (ctrl+r)",
                "Add section (ctrl+a)",
                "Replace section (ctrl+t)",
                "Command palette (ctrl+p)",
                "Quit (ctrl+q)",
                id="commands_list",
            )

    def on_mount(self) -> None:
        self.query_one("#commands_list", OptionList).focus()

    def action_close_commands(self) -> None:
        self.app.pop_screen()

    def _action_for(self, index: int) -> str | None:
        return (
            "submit",
            "stop",
            "toggle_mode",
            "toggle_sidebar",
            "focus_input",
            "preview",
            "export",
            "section_rename",
            "section_add",
            "section_replace",
            "commands",
            "quit",
        )[index]

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        action = self._action_for(event.option_index)
        if action == "quit":
            self.app.exit()
            return
        self.app.pop_screen()
        if action == "submit":
            self.app.action_submit()
        elif action == "stop":
            self.app.action_stop()
        elif action == "toggle_mode":
            self.app.action_toggle_mode()
        elif action == "toggle_sidebar":
            self.app.action_toggle_sidebar()
        elif action == "focus_input":
            self.app.action_focus_input()
        elif action == "preview":
            self.app.action_preview()
        elif action == "export":
            self.app.action_export()
        elif action == "section_rename":
            self.app.action_section_rename()
        elif action == "section_add":
            self.app.action_section_add()
        elif action == "section_replace":
            self.app.action_section_replace()
        elif action == "commands":
            self.app.action_commands()


class ChatScreen(Screen[None]):
    """WriteLab workspace: Sections tree / Chat / Inspector + command bar."""

    def __init__(self, file_path: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self.file_path = file_path

    def compose(self) -> ComposeResult:
        with Vertical(id="app_root"):
            with Horizontal(id="header"):
                yield Static("", id="header_left")
                yield Static("", id="header_right")
            with Horizontal(id="body"):
                yield SectionsPane(id="sections_pane")
                with Vertical(id="main_pane"):
                    yield MessageLog(id="chat_log")
                yield Inspector(id="inspector_pane")
            with Horizontal(id="status_bar"):
                yield Static("", id="status_left")
                yield Static("", id="status_tokens")
                yield Static("", id="status_right")
            with Vertical(id="input_bar"):
                yield PromptInput(
                    placeholder="Describe the report task…", id="prompt_input", soft_wrap=True
                )
                with Horizontal(id="input_meta"):
                    yield Static("", id="input_mode")
                    yield Static("", id="input_model")
                yield BusySpinner(id="busy_indicator")

    def on_mount(self) -> None:
        inspector = self.query_one(Inspector)
        inspector.set_file(self.file_path)
        inspector.set_session(self.app.session_id, self.app.started_at)
        self.app._update_header()
        self.app._update_model_display()
        # priority + app. prefix: beat the seeded Screen tab -> focus_next
        # binding, and resolve the action on the app (not this screen).
        self._bindings.bind(
            self.app.keybindings.get("toggle_mode", "tab"),
            "app.toggle_mode",
            priority=True,
        )
        self.query_one("#prompt_input", TextArea).focus()
        self.app._update_mode_ui()
        self.update_status("ready — enter to send, esc to stop", self.app.status_hints())
        self._sync_panes()
        self.app.call_after_refresh(self.app._load_sections_worker)

    def on_resize(self, event) -> None:
        self._sync_panes()

    def _sync_panes(self) -> None:
        for pane_id in ("#sections_pane", "#inspector_pane"):
            pane = self.query_one(pane_id)
            if "hidden" in pane.classes:
                continue
            if self.app.size.width >= 120:
                pane.add_class("auto")
            else:
                pane.remove_class("auto")

    def update_status(self, left: str, right: str) -> None:
        self.query_one("#status_left", Static).update(left)
        self.query_one("#status_tokens", Static).update(self.app._token_usage_label())
        self.query_one("#status_right", Static).update(right)

    def toggle_sidebar(self) -> None:
        panes = [
            self.query_one("#sections_pane"),
            self.query_one("#inspector_pane"),
        ]
        if "hidden" in panes[0].classes:
            for pane in panes:
                pane.remove_class("hidden")
                pane.add_class("force")
        elif "force" in panes[0].classes or "auto" in panes[0].classes:
            for pane in panes:
                pane.remove_class("force")
                pane.remove_class("auto")
                pane.add_class("hidden")
        else:
            for pane in panes:
                pane.add_class("force")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


class _ChatLogHandler(logging.Handler):
    """Forwards ``quill_engine`` log records into the chat log.

    Attached to the ``quill_engine`` logger in ``QuillTuiApp.on_mount`` and
    removed on unmount, so pipeline modules (orchestrator, search, memory,
    ...) get a live readout in the chat area. Records raised on the main
    thread append directly; records from worker threads are marshalled via
    ``call_from_thread`` (which raises from the main thread).
    """

    def __init__(self, app: QuillTuiApp) -> None:
        super().__init__(level=logging.INFO)
        self._app = app
        self.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        message = self.format(record)
        try:
            self._app.call_from_thread(self._append, message)
        except RuntimeError:
            # call_from_thread raises when called on the app's own thread or
            # after the app stops; in both cases direct append is safe here
            # (the _append guard skips an unmounted screen).
            self._append(message)

    def _append(self, message: str) -> None:
        screen = self._app.screen
        if not isinstance(screen, ChatScreen) or not screen.is_mounted:
            return
        self._app._chat().append("log", message)


class PreviewScreen(Screen[None]):
    """Modal: assembled markdown + cited sources before export.

    Shows the same output :func:`export` would write (``preview_document``
    reuses ``_render_markdown``), plus every source the pipeline cited,
    so the user can check content before it lands on disk.
    """

    def __init__(self, markdown: str, sources: list[SourceRef], **kwargs) -> None:
        super().__init__(**kwargs)
        self.markdown = markdown
        self.sources = sources

    def compose(self) -> ComposeResult:
        with Vertical(id="preview_root"):
            yield Static("PREVIEW", id="preview_title")
            meta = f"{len(self.sources)} source(s)"
            yield Static(meta, id="preview_meta")
            with VerticalScroll(id="preview_body"):
                yield Static(self.markdown, id="preview_content", markup=False)
            with Horizontal(id="preview_actions"):
                yield Button("Close", id="close_preview", variant="primary")

    def on_mount(self) -> None:
        self._bindings.bind("escape", "close_preview", priority=True)
        self.query_one("#preview_body", VerticalScroll).focus()

    def action_close_preview(self) -> None:
        self.app.pop_screen()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "close_preview":
            self.action_close_preview()


class SectionEditModal(Screen[None]):
    """Modal: rename / add / replace a section from the tree selection.

    Collects one text value (new title or replacement instruction) and
    returns it through ``on_submit``; ``escape``/Cancel returns ``None``.
    """

    def __init__(
        self,
        title: str,
        *,
        label: str,
        placeholder: str,
        value: str = "",
        submit_label: str = "Save",
        on_submit,
    ) -> None:
        super().__init__()
        self.modal_title = title
        self.label = label
        self.placeholder = placeholder
        self.value = value
        self.submit_label = submit_label
        self.on_submit = on_submit

    def compose(self) -> ComposeResult:
        with Vertical(id="section_edit_root"):
            yield Static(self.modal_title, id="section_edit_title")
            yield Static(self.label, id="section_edit_label")
            yield Input(
                placeholder=self.placeholder,
                value=self.value,
                id="section_edit_input",
            )
            with Horizontal(id="section_edit_actions"):
                yield Button(self.submit_label, id="section_edit_ok", variant="primary")
                yield Button("Cancel", id="section_edit_cancel")

    def on_mount(self) -> None:
        self._bindings.bind("escape", "cancel_edit", priority=True)
        self.query_one("#section_edit_input", Input).focus()

    def action_cancel_edit(self) -> None:
        self.on_submit(None)
        self.app.pop_screen()

    def _submit(self) -> None:
        value = self.query_one("#section_edit_input", Input).value.strip()
        if value:
            self.on_submit(value)
        self.app.pop_screen()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "section_edit_input":
            self._submit()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "section_edit_ok":
            self._submit()
        elif event.button.id == "section_edit_cancel":
            self.action_cancel_edit()


class QuillTuiApp(App):
    """OpenCode-style Textual app: StartScreen picker + ChatScreen workspace."""

    # We ship our own CommandsScreen on ctrl+p; disable Textual's built-in
    # priority binding so it doesn't shadow ours.
    ENABLE_COMMAND_PALETTE = False

    TITLE = "Quill Engine"
    CSS = """
    /* OpenCode look: near-black base, dim monochrome text, one blue accent
       ($primary = $accent) reserved for focus and the user prompt marker. */

    #app_root { height: 100%; }

    /* minimal header: "◆ quill" + document title, provider/model right */
    #header { height: 1; padding: 0 2; background: $background; }
    #header_left { width: 1fr; color: $text-muted; }
    #header_left .accent { color: $primary; }
    #header_right { width: auto; color: $text-muted; }

    /* body: three-pane workspace, thin dim separators only */
    #body { height: 1fr; }

    #sections_pane, #inspector_pane { height: 100%; display: none;
                                      background: $background; padding: 0 1; }
    #sections_pane { width: 36; border-right: solid $panel; }
    #inspector_pane { width: 40; border-left: solid $panel; }
    #sections_pane.force, #sections_pane.auto,
    #inspector_pane.force, #inspector_pane.auto { display: block; }
    #sections_pane.hidden, #inspector_pane.hidden { display: none; }

    #main_pane { width: 1fr; height: 100%; }
    #chat_log { height: 1fr; padding: 0 2; background: $background; }

    /* full-width command bar: the one bordered element (input focus box) */
    #input_bar { height: auto; padding: 0 2 0 2; }
    /* prompt keeps a minimum width so the input bar can never
       over-commit its fixed children (busy spinner) and collapse
       the text area to zero width. */
    #prompt_input { width: 1fr; height: auto; max-height: 8; min-width: 8;
                    border: round $panel; background: $surface; }
    #prompt_input:focus { border: round $primary; }
    #busy_indicator { width: 10; height: 1; margin-left: 1; display: none; color: $primary; }
    #input_meta { height: 1; color: $text-muted; margin-top: 1; }
    #input_mode { width: auto; }
    #input_model { width: auto; margin-left: 2; }

    /* compact footer/status bar: status left, tokens + hints right */
    #status_bar { height: 1; background: $background; color: $text-muted; padding: 0 2; }
    #status_left { width: 1fr; }
    #status_tokens { width: auto; color: $text-muted; margin-right: 2; }

    /* chat transcript: plain gray lines, roles dim; the user turn carries
       a thin accent marker on the left instead of a colored panel. */
    .msg { margin: 0 0 1 0; height: auto; }
    .msg-role { text-style: none; color: $text-muted; }
    .msg-prompt { border-left: thick $primary; padding-left: 1; }
    .msg-prompt .msg-role { color: $primary; }
    .msg-system .msg-role { color: $text-muted; }
    .msg-section .msg-role { color: $text-muted; }
    .msg-stream .msg-role { color: $text-muted; }
    .msg-error .msg-role { color: $error; }
    .msg-success .msg-role { color: $text-muted; }
    .msg-body { color: $foreground; }
    .msg-stream .msg-body { color: $text-muted; }
    .msg-status .msg-body { color: $text-muted; text-style: none; }
    .msg-log .msg-role { color: $text-muted; }
    .msg-log .msg-body { color: $text-muted; }
    .msg-template .msg-role { color: $text-muted; }
    .msg-question .msg-role { color: $primary; }
    .msg-question .msg-body { color: $foreground; text-style: none; }

    /* evidence form rendered inside the chat */
    #evidence_form { border-left: thick $warning; padding: 0 0 0 1; margin: 0 0 1 0; height: auto; }
    #evidence_form .msg-body { color: $text-muted; }
    .msg-actions { padding-top: 1; height: auto; }

    /* inspector internals */
    .side-heading { color: $text-muted; text-style: bold; padding: 1 0 0 0; }
    .side-meta { color: $text-muted; }
    #pipeline_progress { margin: 1 0; }
    #sections_tree { height: 1fr; background: $background; }

    /* start screen */
    #start_root { height: 100%; align: center middle; background: $background; }
    #start_title { width: auto; text-style: bold; color: $primary; margin: 0 0 1 0; }
    #start_sub { width: auto; color: $text-muted; margin: 0 0 2 0; }
    #start_error { width: auto; color: $error; }
    #start_list { width: 40%; height: 1fr; min-height: 8; border: round $panel; background: $background; padding: 1; }
    #file_list { width: 100%; height: 0.2fr; margin: 0 0; }
    #start_hints { color: $text-muted; width: 100%; text-align: center; padding: 1 0 0 0; }
    #start_path_row { width: 100%; height: auto; }
    #path_input { width: 1fr; max-width: 60; background: $surface; }
    #open_button { width: auto; margin-left: 1; }

    /* preview modal */
    #preview_root { height: 100%; background: $background; padding: 1 2; }
    #preview_title { text-style: bold; color: $primary; padding: 0 0 1 0; }
    #preview_meta { color: $text-muted; padding: 0 0 1 0; }
    #preview_body { height: 1fr; border: round $panel; padding: 1; margin: 0 0 1 0; }
    #preview_actions { height: auto; }
    #close_preview { width: auto; }

    /* section edit modal */
    #section_edit_root { height: auto; margin: 6 8; padding: 1 2; background: $background; border: round $primary; }
    #section_edit_title { text-style: bold; color: $primary; padding: 0 0 1 0; }
    #section_edit_label { color: $text-muted; padding: 0 0 1 0; }
    #section_edit_input { margin: 0 0 1 0; background: $surface; }
    #section_edit_actions { height: auto; }

    /* command palette modal */
    #commands_root { height: 100%; background: $background; padding: 1 2; }
    #commands_title { text-style: bold; color: $primary; padding: 0 0 1 0; }
    #commands_hint { color: $text-muted; padding: 0 0 1 0; }
    #commands_list { height: 1fr; border: round $panel; background: $background; padding: 1; }
    """

    def __init__(
        self,
        file_path: str | None = None,
        *,
        runner: object | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.file_path = file_path
        self.runner = runner
        self._runner_kwargs: dict = {}
        self.prompt = ""
        self.references: list[tuple[str, str]] = []
        self.results: dict[str, GenerationResult] = {}
        self.project_id = ""
        self.mode = "generate"  # "generate" | "rewrite"
        self._snapshot_count = 0
        self._evidence_attempts = 0
        self._pipeline_running = False
        self._stop_requested = False
        self._evidence_form: EvidenceMessage | None = None
        self._stream_msg: Message | None = None
        self._status_msg: Message | None = None
        self._rewrite_target_ids: list[str] = []
        self._log_handler: _ChatLogHandler | None = None
        self._interview: dict | None = None
        self._interview_done = False
        self._sections_loaded = False
        self._preview_dirty = False
        self.session_id = uuid.uuid4().hex[:8]
        self.started_at = time.time()
        self.config = _load_tui_config()
        self.keybindings = self.config["keybindings"]

    # -- lifecycle ---------------------------------------------------------

    def on_mount(self) -> None:
        # quill_engine logger inherits root's default WARNING; raise it so
        # INFO+ records reach the chat handler even without cli.basicConfig.
        quill_logger = logging.getLogger("quill_engine")
        self._saved_log_level = quill_logger.level
        quill_logger.setLevel(logging.INFO)
        self._log_handler = _ChatLogHandler(self)
        quill_logger.addHandler(self._log_handler)
        _apply_theme(self, self.config["theme"])
        for action, key in self.keybindings.items():
            # toggle_mode is bound on ChatScreen instead: it must beat the
            # Screen's default tab -> focus_next, and StartScreen keeps tab.
            if action == "toggle_mode":
                continue
            self.bind(key, action)
        # legacy alias: ctrl+s still submits (enter is now primary)
        self.bind("ctrl+s", "submit")
        screen = ChatScreen(self.file_path) if self.file_path else StartScreen()
        self.push_screen(screen)

    def on_unmount(self) -> None:
        if self._log_handler is not None:
            quill_logger = logging.getLogger("quill_engine")
            quill_logger.removeHandler(self._log_handler)
            quill_logger.setLevel(self._saved_log_level)
            self._log_handler = None

    def _handle_exception(self, error: Exception) -> None:
        """Textual calls this on any unhandled exception (e.g. inside a
        message handler) and then exits the app, printing the traceback only
        to the terminal. Write it to the log file first so the cause of a
        click-close survives the shutdown."""
        logging.getLogger("quill_engine").critical(
            "Unhandled exception; Textual is exiting the app", exc_info=error
        )
        super()._handle_exception(error)

    def on_tree_node_highlighted(self, event: Tree.NodeHighlighted) -> None:
        """Trace cursor moves over the sections tree (arrow keys + hover)."""
        node = event.node
        logging.getLogger("quill_engine").debug(
            "Tree highlighted: %r (id=%s)",
            getattr(node.label, "plain", node.label),
            node.data.section_id if node.data is not None else None,
        )

    def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        """Trace clicks/Enter on tree nodes — the suspected click-close."""
        node = event.node
        logging.getLogger("quill_engine").info(
            "Tree selected: %r (id=%s)",
            getattr(node.label, "plain", node.label),
            node.data.section_id if node.data is not None else None,
        )

    def status_hints(self) -> str:
        kb = self.keybindings
        return (
            f"{self.mode} · {kb.get('toggle_mode', 'tab')} switch · "
            f"enter send · esc stop · "
            f"{kb.get('toggle_sidebar', 'ctrl+b')} panes · "
            f"{kb.get('preview', 'ctrl+o')} preview · "
            f"{kb.get('export', 'ctrl+e')} export · "
            f"{kb.get('section_rename', 'ctrl+r')} rename · "
            f"{kb.get('section_add', 'ctrl+a')} add · "
            f"{kb.get('section_replace', 'ctrl+t')} replace · "
            f"{kb.get('commands', 'ctrl+p')} commands · "
            f"/merge similar · "
            f"{kb.get('quit', 'ctrl+q')} quit"
        )

    def _update_mode_ui(self) -> None:
        """Reflect the current mode in the meta row + prompt placeholder."""
        if not isinstance(self.screen, ChatScreen):
            return
        self.screen.query_one("#input_mode", Static).update(f"mode: {self.mode}")
        self.screen.query_one("#prompt_input", TextArea).placeholder = (
            "Rewrite selected sections… (pick in the tree)"
            if self.mode == "rewrite"
            else "Describe the report task…"
        )
        self.screen.query_one("#status_right", Static).update(self.status_hints())

    def _configured_model(self) -> str:
        """First active provider as 'name/model' — what the next run would use."""
        chain_list = providers.chain()
        if chain_list:
            provider = chain_list[0]
            return f"{provider.name}/{provider.model}"
        return config.LLM_MODEL

    def _update_model_display(self) -> None:
        """Meta row model line: models actually used by the last run."""
        if not isinstance(self.screen, ChatScreen):
            return
        models = sorted({r.model for r in self.results.values() if r.model})
        self.screen.query_one("#input_model", Static).update(
            f"model: {', '.join(models) if models else self._configured_model()}"
        )
        # Piggyback the header model + footer token usage on the same
        # refresh points (no extra timer).
        self._update_header()
        self.screen.query_one("#status_tokens", Static).update(self._token_usage_label())

    def _update_header(self) -> None:
        """Minimal header: '◆ quill · <title>' left, provider/model right."""
        if not isinstance(self.screen, ChatScreen):
            return
        title = Path(self.file_path or "").stem or "untitled"
        self.screen.query_one("#header_left", Static).update(
            f"[bold #4a9eff]◆[/] quill [dim]·[/] {title}"
        )
        last = providers.last_used()
        model = f"{last[0]}/{last[1]}" if last else self._configured_model()
        self.screen.query_one("#header_right", Static).update(model)

    @staticmethod
    def _token_usage_label() -> str:
        """Dim token usage for the footer, e.g. '↑12.3k ↓45.6k'."""
        usage = providers.usage()
        prompt = usage.get("prompt_tokens", 0)
        completion = usage.get("completion_tokens", 0)
        if not prompt and not completion:
            return ""
        return f"↑{_fmt_tokens(prompt)} ↓{_fmt_tokens(completion)}"

    # -- actions (bound from tui.json) -------------------------------------

    def action_submit(self) -> None:
        screen = self.screen
        if isinstance(screen, ChatScreen):
            self.begin_pipeline_from_input()
        elif isinstance(screen, StartScreen):
            screen.open_selection()

    def action_quit(self) -> None:
        self.exit()

    def action_toggle_sidebar(self) -> None:
        if isinstance(self.screen, ChatScreen):
            self.screen.toggle_sidebar()

    def action_toggle_mode(self) -> None:
        if not isinstance(self.screen, ChatScreen):
            return
        if self._interview is not None:
            self.notify("Finish the questions first", severity="warning")
            return
        self.mode = "rewrite" if self.mode == "generate" else "generate"
        self._update_mode_ui()
        self.notify(f"Mode: {self.mode}", timeout=3)

    def action_focus_input(self) -> None:
        if isinstance(self.screen, ChatScreen):
            self.screen.query_one("#prompt_input", TextArea).focus()

    def action_preview(self) -> None:
        """ctrl+o: open the assembled-document modal (export preview)."""
        if not isinstance(self.screen, ChatScreen) or self.runner is None:
            return
        if not self.results or not self.project_id:
            self.notify("Run the pipeline first to preview the document", severity="warning")
            return
        if getattr(self, "_preview_pending", False):
            self.notify("Preview already assembling…", timeout=3)
            return
        self._preview_pending = True
        self.notify("Assembling preview…", timeout=5)
        self._preview_worker()

    @work(thread=True)
    def _preview_worker(self) -> None:
        try:
            markdown = self.runner.preview()
        except Exception as exc:
            self.call_from_thread(self._on_preview_error, exc)
            return
        self.call_from_thread(self._on_preview_ready, markdown)

    def _on_preview_ready(self, markdown: str) -> None:
        self._preview_pending = False
        self.push_screen(PreviewScreen(markdown, self._collect_sources()))

    def _on_preview_error(self, exc: Exception) -> None:
        self._preview_pending = False
        self.notify(f"Preview failed: {exc}", severity="error", timeout=10)

    def action_commands(self) -> None:
        """ctrl+p: open the command palette modal."""
        if isinstance(self.screen, ChatScreen):
            self.push_screen(CommandsScreen())

    def action_export(self) -> None:
        """ctrl+e: failsafe — export the assembled document to disk now."""
        if not isinstance(self.screen, ChatScreen) or self.runner is None:
            return
        if not self.project_id:
            self.notify("Run the pipeline first to export", severity="warning")
            return
        if getattr(self, "_pipeline_running", False):
            self.notify(
                "Pipeline still running — partial results will export",
                severity="warning",
                timeout=5,
            )
        self.notify("Exporting document…", timeout=3)
        self._export_worker()

    def action_stop(self) -> None:
        """Cancel the running pipeline; partial results stay visible."""
        if self._interview is not None:
            self._finish_interview()
            self._set_status_label("skipping questions, generating…")
            return
        if not self._pipeline_running:
            return
        self._stop_requested = True
        if isinstance(self.screen, ChatScreen):
            self._set_status_label("stopping…")
            self.screen.update_status("stopping…", "")

    # -- session -----------------------------------------------------------

    def begin(self, file_path: str) -> None:
        """Start a session on ``file_path`` (StartScreen -> ChatScreen)."""
        if self.runner is None:
            self.runner = RealPipelineRunner(file_path, **self._runner_kwargs)
        self.file_path = file_path
        self.project_id = ""
        self.mode = "generate"
        self._snapshot_count = 0
        self._evidence_attempts = 0
        self._pipeline_running = False
        self._preview_pending = False
        self._stop_requested = False
        self._evidence_form = None
        self._stream_msg = None
        self._status_msg = None
        self._rewrite_target_ids = []
        self._interview = None
        self._interview_done = False
        self._sections_loaded = False
        self.session_id = uuid.uuid4().hex[:8]
        self.started_at = time.time()
        self._section_msgs = {}
        self.push_screen(ChatScreen(file_path))

    def begin_pipeline_from_input(self) -> None:
        if self._interview is not None and isinstance(self.screen, ChatScreen):
            inp = self.screen.query_one("#prompt_input", TextArea)
            text = inp.text.strip()
            if not text:
                self.notify("Answer the question above first", severity="warning")
                return
            inp.text = ""
            self._submit_interview_answer(text)
            return
        if self._pipeline_running or not isinstance(self.screen, ChatScreen):
            return
        inp = self.screen.query_one("#prompt_input", TextArea)
        prompt = inp.text.strip()
        if not prompt:
            self.notify("Enter a prompt first", severity="warning")
            return
        inp.text = ""
        if prompt.startswith("/merge"):
            self.begin_merge(prompt[len("/merge") :].strip())
            return
        if self.mode == "rewrite":
            self.begin_rewrite(prompt)
        else:
            self.begin_pipeline(prompt)

    def begin_pipeline(self, prompt: str) -> None:
        if self._pipeline_running or self.runner is None:
            return
        self.prompt, self.references = reference_service.expand_references(prompt)
        self._evidence_attempts = 0
        self._pipeline_running = True
        self._stop_requested = False
        self._section_msgs = {}
        self._interview = None
        self._interview_done = False
        if isinstance(self.screen, ChatScreen):
            self._chat().append("prompt", prompt)
            self._append_reference_notice()
            self._status_msg = self._chat().append("status", "thinking…")
            self._set_input_state(False)
        self.call_after_refresh(self._pipeline_worker)

    # -- pipeline worker (thread) ------------------------------------------

    @work(thread=True, exclusive=True)
    def _load_sections_worker(self) -> None:
        """Ingest the document and populate the section tree on ChatScreen mount.

        Populates sections immediately when the workspace opens, without
        running generation — the user sees the tree before submitting a prompt.
        """
        worker = get_current_worker()
        runner = self.runner
        if runner is None:
            return
        try:
            project_id = runner.ingest()
            if worker.is_cancelled:
                return
            self.call_from_thread(self._on_ingested, project_id)
            if worker.is_cancelled:
                return
            self.call_from_thread(self._load_sections, runner.sections())
        except Exception as exc:
            self.call_from_thread(self._on_pipeline_error, exc)

    @work(thread=True, exclusive=True)
    def _pipeline_worker(self) -> None:
        worker = get_current_worker()
        runner = self.runner
        if runner is None:
            return
        try:
            project_id = runner.ingest()
            if worker.is_cancelled:
                return
            self.call_from_thread(self._on_ingested, project_id)
            if worker.is_cancelled:
                return
            self.call_from_thread(self._load_sections, runner.sections())
            if not self._interview_done:
                interview = self._prepare_interview(runner.sections())
                if interview is not None:
                    self.call_from_thread(self._begin_interview, interview)
                    return
                self._interview_done = True
            results = runner.run(
                self.prompt,
                self._thread_progress,
                self._thread_stream,
                cancel=lambda: self._stop_requested or worker.is_cancelled,
                references=self.references,
            )
            if worker.is_cancelled:
                return
            self.call_from_thread(self._on_run_done, results)
        except GenerationCancelled:
            if worker.is_cancelled or self._stop_requested:
                self.call_from_thread(self._on_stopped)
        except Exception as exc:
            self.call_from_thread(self._on_pipeline_error, exc)

    def _thread_progress(self, section_id: str, status: str, ratio: float) -> None:
        self.call_from_thread(self._on_progress, section_id, status, ratio)

    def _thread_stream(self, section_id: str, text: str) -> None:
        self.call_from_thread(self._on_stream, section_id, text)

    # -- interview (pause before generation) -------------------------------

    def _prepare_interview(self, sections) -> dict | None:
        """Build the interview state (worker thread; LLM calls live here)."""
        questions = thinking_service.build_followups(self.prompt, sections)
        template = thinking_service.extract_template(self.prompt, sections)
        existing = {s.title.strip().lower() for s in walk_sections(sections)}
        template = [
            t for t in template
            if t.title.strip() and t.title.strip().lower() not in existing
        ]
        if not questions and not template:
            return None
        return {
            "phase": "template" if template else "question",
            "questions": questions,
            "q_index": 0,
            "answers": {},
            "template": template,
            "template_titles": [],
        }

    def _begin_interview(self, interview: dict) -> None:
        """Pause the pipeline and render the interview in the chat."""
        self._interview = interview
        self._interview_done = True
        if not isinstance(self.screen, ChatScreen):
            return
        self._set_status_label("a few questions before generating…")
        if interview["template"]:
            self._chat().append("template", self._format_template(interview["template"]))
        else:
            self._post_interview_question()
        self._set_interview_state()

    def _post_interview_question(self) -> None:
        """Ask the next question, or finish when none remain."""
        interview = self._interview
        if interview is None or not isinstance(self.screen, ChatScreen):
            return
        questions = interview["questions"]
        if interview["q_index"] >= len(questions):
            self._finish_interview()
            return
        question = questions[interview["q_index"]]
        interview["q_index"] += 1
        text = question.question
        if question.kind == "select":
            text += "  (" + ", ".join(f"{i + 1}. {o}" for i, o in enumerate(question.options)) + ")"
        elif question.kind == "confirm":
            text += "  (yes/no)"
        self._chat().append("question", text)
        interview["phase"] = "question"

    def _submit_interview_answer(self, text: str) -> None:
        """Record the user's answer and advance the interview."""
        interview = self._interview
        if interview is None or not isinstance(self.screen, ChatScreen):
            return
        if interview["phase"] == "template":
            titles = thinking_service.parse_template_choice(text, interview["template"])
            interview["template_titles"] = titles
            self._chat().append(
                "prompt",
                f"Template sections: {', '.join(titles) if titles else 'none'}",
            )
        else:
            question = interview["questions"][interview["q_index"] - 1]
            interview["answers"][question.field] = self._answer_for(question, text)
            self._chat().append("prompt", text)
        self._post_interview_question()

    def _finish_interview(self) -> None:
        """Apply the confirmed template + answers, then resume the pipeline."""
        interview = self._interview
        if interview is None:
            return
        self._interview = None
        titles = set(interview["template_titles"])
        if titles and self.runner is not None:
            chosen = [t for t in interview["template"] if t.title.strip() in titles]
            added = self.runner.append_template(chosen)
            if added and isinstance(self.screen, ChatScreen):
                self._chat().append(
                    "system", f"Added {added} template section(s) to the report"
                )
        merged = thinking_service.merge_answers(self.prompt, interview["answers"])
        if merged != self.prompt:
            self.prompt = merged
        self.call_after_refresh(self._pipeline_worker)

    def _answer_for(self, question, text: str) -> str:
        """Resolve a raw answer into the value stored for the question."""
        answer = _normalize_answer(text)
        if question.kind == "confirm":
            return "yes" if answer.lower() in ("yes", "y", "ok", "sure", "true", "1") else "no"
        if question.kind == "select":
            if answer.isdigit():
                index = int(answer)
                if 1 <= index <= len(question.options):
                    return question.options[index - 1]
            lowered = answer.lower()
            for option in question.options:
                if option.lower() == lowered or option.lower().startswith(lowered):
                    return option
        return answer

    def _format_template(self, template) -> str:
        lines = [
            "Your task mentions sections not in the source document — "
            "I can add them to the report:"
        ]
        for i, item in enumerate(template, start=1):
            line = f"  {i}. {item.title}"
            if item.description:
                line += f" — {item.description}"
            lines.append(line)
        lines.append("Add them?  (yes / no / numbers like 1,2)")
        return "\n".join(lines)

    def _set_interview_state(self) -> None:
        """Enable the input for answers while keeping the pipeline paused."""
        if not isinstance(self.screen, ChatScreen):
            return
        self.screen.query_one("#prompt_input", TextArea).disabled = False
        self.screen.query_one("#busy_indicator", BusySpinner).display = True

    # -- rewrite mode -------------------------------------------------------

    def begin_rewrite(self, prompt: str, *, target_ids: list[str] | None = None) -> None:
        if self._pipeline_running or self.runner is None:
            return
        self.prompt, self.references = reference_service.expand_references(prompt)
        # Resolve the selection on the main thread — the worker must never
        # touch the DOM. Explicit target_ids (section edits) win over the
        # tree cursor.
        self._rewrite_target_ids = (
            list(target_ids) if target_ids is not None else self._rewrite_targets()
        )
        self._pipeline_running = True
        self._stop_requested = False
        if isinstance(self.screen, ChatScreen):
            self._chat().append("prompt", prompt)
            self._append_reference_notice()
            self._status_msg = self._chat().append("status", "thinking…")
            self._set_input_state(False)
        self.call_after_refresh(self._rewrite_worker)

    def begin_merge(self, arg: str = "") -> None:
        """``/merge [threshold]`` — merge sibling sections with similar titles.

        Runs the project-wide merge pass over the current document tree:
        sibling sections whose header embeddings score at or above
        ``config.MERGE_MIN_SIMILARITY`` are combined into one (the earlier
        sibling keeps its identity and absorbs the later one's content).
        ``threshold`` (when given) overrides the similarity cutoff — e.g.
        ``/merge 0.9``.
        """
        if self._pipeline_running:
            return
        if self.runner is None:
            self.notify("Open a document first", severity="warning")
            return
        threshold: float | None = None
        if arg:
            try:
                threshold = float(arg)
            except ValueError:
                self.notify(f"Invalid threshold: {arg}", severity="warning")
                return
        self._merge_threshold = threshold
        self.prompt = "/merge"
        self.references = []
        self._pipeline_running = True
        self._stop_requested = False
        self._section_msgs = {}
        self._sections_loaded = False
        if isinstance(self.screen, ChatScreen):
            self._chat().append("prompt", f"/merge {arg}".strip())
            self._status_msg = self._chat().append("status", "merging similar sections…")
            self._set_input_state(False)
        self.call_after_refresh(self._merge_worker)

    def _rewrite_targets(self) -> list[str]:
        """Section ids selected in the tree; empty = rewrite all generated."""
        if not isinstance(self.screen, ChatScreen):
            return []
        node = self._sections().query_one("#sections_tree", Tree).cursor_node
        if node is None or node.data is None:
            return []
        section: Section = node.data
        return [leaf.section_id for leaf in section.leaves()]

    def _selected_section(self) -> Section | None:
        """The section under the tree cursor, if any."""
        if not isinstance(self.screen, ChatScreen):
            return None
        node = self._sections().query_one("#sections_tree", Tree).cursor_node
        if node is None or node.data is None:
            return None
        return node.data

    def _save_section_tree(self, sections: list[Section]) -> None:
        if self.runner is None or self.project_id is None:
            return
        self.runner.store.save_sections(self.project_id, sections)
        self._load_sections(sections)

    # -- section editing (rename / add / replace, tied to rewrite) ----------

    def action_section_rename(self) -> None:
        """ctrl+r: rename the selected section, then rewrite it to match."""
        section = self._selected_section()
        if section is None or self.runner is None or self.project_id is None:
            self.notify("Select a section in the tree first", severity="warning")
            return
        if self._pipeline_running:
            self.notify("Wait for the pipeline to finish", severity="warning")
            return
        self.push_screen(
            SectionEditModal(
                "RENAME SECTION",
                label=f"New title for: {section.title}",
                placeholder="Section title",
                value=section.title,
                submit_label="Rename",
                on_submit=lambda new_title: self._apply_rename(section, new_title),
            )
        )

    def _apply_rename(self, section: Section, new_title: str | None) -> None:
        if not new_title or new_title == section.title:
            return
        sections = self.runner.store.get_sections(self.project_id)
        target = find_section(sections, section.section_id)
        if target is None:
            return
        target.title = new_title
        self._save_section_tree(sections)
        self.begin_rewrite(
            f"Rename the section so its heading is exactly '{new_title}' and "
            "its content stays consistent with that heading.",
            target_ids=[section.section_id],
        )

    def action_section_add(self) -> None:
        """ctrl+a: add a new section under the selected one, then generate it."""
        section = self._selected_section()
        if self.runner is None or self.project_id is None:
            self.notify("Select a parent section in the tree first", severity="warning")
            return
        if self._pipeline_running:
            self.notify("Wait for the pipeline to finish", severity="warning")
            return
        parent_title = section.title if section is not None else "(top level)"
        self.push_screen(
            SectionEditModal(
                "ADD SECTION",
                label=f"New section under: {parent_title}",
                placeholder="Section title",
                submit_label="Add",
                on_submit=lambda title: self._apply_add(section, title),
            )
        )

    def _apply_add(self, parent: Section | None, title: str | None) -> None:
        if not title:
            return
        sections = self.runner.store.get_sections(self.project_id)
        parent_node = (
            find_section(sections, parent.section_id) if parent is not None else None
        )
        level = (parent_node.level + 1) if parent_node is not None else 1
        order = len(parent_node.children) if parent_node is not None else len(sections)
        new_sec = new_section(
            title,
            level=level,
            order=order + 1,
            parent_id=parent_node.section_id if parent_node is not None else None,
        )
        if not insert_section(
            sections,
            new_sec,
            parent_id=parent_node.section_id if parent_node is not None else None,
        ):
            self.notify("Could not insert the new section", severity="error")
            return
        self._save_section_tree(sections)
        self.begin_rewrite(
            f"Write the new section titled '{title}' from scratch.",
            target_ids=[new_sec.section_id],
        )

    def action_section_replace(self) -> None:
        """ctrl+t: rewrite the selected section's content from an instruction."""
        section = self._selected_section()
        if section is None or self.runner is None or self.project_id is None:
            self.notify("Select a section in the tree first", severity="warning")
            return
        if self._pipeline_running:
            self.notify("Wait for the pipeline to finish", severity="warning")
            return
        self.push_screen(
            SectionEditModal(
                "REPLACE SECTION",
                label=f"What should change in: {section.title}",
                placeholder="Rewrite instruction",
                submit_label="Replace",
                on_submit=lambda instruction: self._apply_replace(section, instruction),
            )
        )

    def _apply_replace(self, section: Section, instruction: str | None) -> None:
        if not instruction:
            return
        self.begin_rewrite(
            instruction,
            target_ids=[leaf.section_id for leaf in section.leaves()],
        )

    @work(thread=True, exclusive=True)
    def _rewrite_worker(self) -> None:
        worker = get_current_worker()
        runner = self.runner
        if runner is None:
            return
        try:
            project_id = runner.ingest()
            if worker.is_cancelled:
                return
            self.call_from_thread(self._on_ingested, project_id)
            if worker.is_cancelled:
                return
            results = runner.rewrite(
                self.prompt,
                self._rewrite_target_ids,
                self._thread_progress,
                self._thread_stream,
                cancel=lambda: self._stop_requested or worker.is_cancelled,
                references=self.references,
            )
            if worker.is_cancelled:
                return
            self.call_from_thread(self._on_rewrite_done, results)
        except GenerationCancelled:
            if worker.is_cancelled or self._stop_requested:
                self.call_from_thread(self._on_stopped)
        except Exception as exc:
            self.call_from_thread(self._on_pipeline_error, exc)

    def _on_rewrite_done(self, results: dict[str, GenerationResult]) -> None:
        self.results = results
        self._update_model_display()
        self._remove_status_msg()
        if self._stream_msg is not None:
            self._stream_msg.remove()
            self._stream_msg = None
        if self._stop_requested:
            self._chat().append("status", "stopped — partial results shown above")
            self._pipeline_running = False
            self._set_input_state(True)
            return
        self._snapshot_count += 1
        if isinstance(self.screen, ChatScreen):
            self._inspector().set_snapshot(self._snapshot_count)
        self._append_sources_message()
        self._export_worker()

    @work(thread=True, exclusive=True)
    def _merge_worker(self) -> None:
        worker = get_current_worker()
        runner = self.runner
        if runner is None:
            return
        try:
            project_id = runner.ingest()
            if worker.is_cancelled:
                return
            self.call_from_thread(self._on_ingested, project_id)
            if worker.is_cancelled:
                return
            self.call_from_thread(self._load_sections, runner.sections())
            if worker.is_cancelled:
                return
            results = runner.merge_similar_sections(
                self._thread_progress,
                threshold=self._merge_threshold,
                cancel=lambda: self._stop_requested or worker.is_cancelled,
            )
            if worker.is_cancelled:
                return
            self.call_from_thread(self._on_merge_done, results)
        except GenerationCancelled:
            if worker.is_cancelled or self._stop_requested:
                self.call_from_thread(self._on_stopped)
        except Exception as exc:
            self.call_from_thread(self._on_pipeline_error, exc)

    def _on_merge_done(self, results: list[MergeResult]) -> None:
        self._remove_status_msg()
        if self._stream_msg is not None:
            self._stream_msg.remove()
            self._stream_msg = None
        if self._stop_requested:
            self._chat().append("status", "stopped — partial results shown above")
            self._pipeline_running = False
            self._set_input_state(True)
            return
        if isinstance(self.screen, ChatScreen):
            self._load_sections(self.runner.sections())
            if results:
                self._chat().append(
                    "system",
                    f"Merge complete — {len(results)} section(s) merged",
                )
            else:
                self._chat().append("system", "No similar sections found")
        self._pipeline_running = False
        self._set_input_state(True)

    def _remove_status_msg(self) -> None:
        if self._status_msg is not None:
            self._status_msg.remove()
            self._status_msg = None

    def _set_status_label(self, text: str) -> None:
        if self._status_msg is not None:
            self._status_msg.update_text(text)

    @work(thread=True)
    def _export_worker(self) -> None:
        try:
            out_path = self.runner.export()
        except Exception as exc:
            out_path = f"export failed: {exc}"
        self.call_from_thread(self._on_finished, out_path)

    # -- main-thread handlers ----------------------------------------------

    def _chat(self) -> MessageLog:
        return self.screen.query_one("#chat_log", MessageLog)

    def _append_reference_notice(self) -> None:
        """Show resolved ``@``-mentions in the chat before the pipeline runs."""
        if not self.references:
            return
        labels = ", ".join(label for label, _ in self.references)
        self._chat().append("system", f"References attached: {labels}")

    def _inspector(self) -> Inspector:
        return self.screen.query_one(Inspector)

    def _sections(self) -> SectionsPane:
        return self.screen.query_one(SectionsPane)

    def _on_ingested(self, project_id: str) -> None:
        self.project_id = project_id
        if not isinstance(self.screen, ChatScreen):
            return
        self._inspector().set_project(project_id)
        self.screen.update_status(f"project {project_id}", "")

    def _load_sections(self, sections: list[Section]) -> None:
        if not isinstance(self.screen, ChatScreen):
            return
        ratio = self._sections().load_sections(sections, self.runner.get_evidence())
        if ratio is not None:
            self._inspector().set_coverage(ratio)
        total = len(list(walk_sections(sections)))
        if not self._sections_loaded:
            self._chat().append(
                "system", f"Project {self.project_id} — {total} sections resolved"
            )
            self._sections_loaded = True
        self.screen.update_status(f"project {self.project_id}", f"{total} sections")

    def _on_progress(self, section_id: str, status: str, ratio: float) -> None:
        if not isinstance(self.screen, ChatScreen):
            return
        self._inspector().set_progress(ratio)
        if not section_id:
            if status == "research":
                self._chat().append("system", "Research phase — query curator → web search → knowledge graph…")
                self._set_status_label("searching…")
            self.screen.update_status(f"project {self.project_id}", f"{ratio:.0%}")
            return
        if status == "generating":
            self._set_status_label("generating…")
        self._sections().update_section(section_id, status)
        title = self._sections().title_for(section_id)
        if status in ("generated", "blocked", "failed", "skipped"):
            glyph = {
                "generated": "✓ generated",
                "blocked": "⛔ blocked — evidence below the coverage gate",
                "failed": "✗ failed",
                "skipped": "skipped (already generated)",
            }[status]
            self._chat().append("section", f"{glyph} — {title}")
            # Refresh preview cache when a section completes so the next
            # ctrl+o opens with up-to-date content.
            self._preview_dirty = True
        self.screen.update_status(f"project {self.project_id}", f"{ratio:.0%} · {title}")

    def _on_stream(self, section_id: str, text: str) -> None:
        if not isinstance(self.screen, ChatScreen):
            return
        if self._stream_msg is None:
            self._stream_msg = self._chat().append("stream", "")
        # Keep only the tail — live output is a glanceable activity line.
        self._stream_msg.update_text(text[-1500:])

    def _collect_sources(self) -> list[SourceRef]:
        """Deduplicated, first-seen-ordered sources from the last run."""
        sources: list[SourceRef] = []
        seen: set[tuple[str, str]] = set()
        for result in self.results.values():
            for ref in result.sources:
                key = (ref.title, ref.url)
                if key in seen:
                    continue
                seen.add(key)
                sources.append(ref)
        return sources

    def _append_sources_message(self) -> None:
        """Chat line listing what this run cited (when anything was cited)."""
        sources = self._collect_sources()
        if not sources or not isinstance(self.screen, ChatScreen):
            return
        by_kind: dict[str, int] = {}
        for ref in sources:
            by_kind[ref.kind] = by_kind.get(ref.kind, 0) + 1
        counts = ", ".join(f"{kind} × {n}" for kind, n in sorted(by_kind.items()))
        self._chat().append("system", f"Sources: {counts} — ctrl+o to preview the document")
        self._inspector().set_sources(sources)

    def _on_run_done(self, results: dict[str, GenerationResult]) -> None:
        self.results = results
        self._update_model_display()
        self._remove_status_msg()
        if self._stream_msg is not None:
            self._stream_msg.remove()
            self._stream_msg = None
        if self._stop_requested:
            self._chat().append("status", "stopped — partial results shown above")
            self._pipeline_running = False
            self._set_input_state(True)
            return
        self._snapshot_count += 1
        if isinstance(self.screen, ChatScreen):
            self._inspector().set_snapshot(self._snapshot_count)
        self._append_sources_message()
        missing = self._collect_missing(results)
        if missing and self._evidence_attempts == 0:
            self._evidence_attempts += 1
            self._evidence_form = self._chat().append_evidence(missing)
        else:
            self._export_worker()

    def _on_pipeline_error(self, exc: Exception) -> None:
        if isinstance(self.screen, ChatScreen):
            self._chat().append("error", f"Pipeline failed: {exc}")
        self.notify(f"Pipeline failed: {exc}", severity="error", timeout=10)
        self._pipeline_running = False
        self._remove_status_msg()
        self._set_input_state(True)

    def _on_stopped(self) -> None:
        if isinstance(self.screen, ChatScreen):
            self._chat().append("status", "stopped — partial results shown above")
            self.screen.update_status("stopped", "")
        self._pipeline_running = False
        self._remove_status_msg()
        self._set_input_state(True)

    def _on_finished(self, out_path: str) -> None:
        self._pipeline_running = False
        if isinstance(self.screen, ChatScreen):
            generated = sum(1 for r in self.results.values() if r.status == "generated")
            blocked = sum(1 for r in self.results.values() if r.status == "blocked")
            failed = sum(1 for r in self.results.values() if r.status == "failed")
            self._chat().append(
                "success", f"Generated {generated} sections, {blocked} blocked, {failed} failed"
            )
            self._chat().append("success", f"Exported: {out_path}")
            self._inspector().set_export_ready()
            self.screen.update_status("done", out_path)
            if failed:
                self.notify(f"{failed} section(s) failed — see messages", severity="warning", timeout=10)
            if self.mode == "generate":
                self.mode = "rewrite"
                self._update_mode_ui()
                self._chat().append(
                    "system",
                    "Switched to rewrite mode — pick sections in the tree, "
                    "then prompt to revise them",
                )
        self._set_input_state(True)

    # -- evidence form flow ------------------------------------------------

    def _collect_missing(self, results: dict[str, GenerationResult]) -> list:
        answers = self.runner.get_evidence()
        missing = []
        for section in walk_sections(self.runner.sections()):
            result = results.get(section.section_id)
            if result is None or result.status != "blocked":
                continue
            for req in requirement_service.build_requirements(section, answers=answers):
                if not req.present and not req.answer:
                    missing.append(req)
        return missing

    def submit_evidence(self, answers: dict[str, str]) -> None:
        if self._evidence_form is not None:
            self._evidence_form.remove()
            self._evidence_form = None
        if self.runner is not None and self.project_id:
            self.runner.save_evidence(answers)
        self._stop_requested = False
        self._pipeline_worker()

    def skip_evidence(self) -> None:
        if self._evidence_form is not None:
            self._evidence_form.remove()
            self._evidence_form = None
        self._export_worker()

    # -- misc --------------------------------------------------------------

    def _set_input_state(self, enabled: bool) -> None:
        if not isinstance(self.screen, ChatScreen):
            return
        self.screen.query_one("#prompt_input", TextArea).disabled = not enabled
        busy = self._pipeline_running
        self.screen.query_one("#busy_indicator", BusySpinner).display = busy

    def on_worker_state_changed(self, event: Worker.StateChanged) -> None:
        if event.state == WorkerState.ERROR:
            self.notify(f"Pipeline crashed: {event.worker.error}", severity="error", timeout=10)
            if isinstance(self.screen, ChatScreen):
                self._chat().append("error", f"Pipeline crashed: {event.worker.error}")
            self._pipeline_running = False
            self._remove_status_msg()
            self._set_input_state(True)


# ---------------------------------------------------------------------------
# Runner + entry point
# ---------------------------------------------------------------------------


class RealPipelineRunner:
    """Wraps orchestrator/export for the TUI; ``ingest`` runs once."""

    def __init__(
        self,
        file_path: str,
        *,
        store=None,
        fmt: str = "markdown",
        out_dir: str | None = None,
        title: str | None = None,
        evidence_file: str | None = None,
    ) -> None:
        self.file_path = file_path
        self.store = store if store is not None else orchestrator.new_store()
        self.fmt = fmt
        self.out_dir = out_dir
        self.title = title or os.path.splitext(os.path.basename(file_path))[0]
        self.evidence_file = evidence_file
        self.project_id: str | None = None

    def ingest(self) -> str:
        if self.project_id is None:
            self.project_id = orchestrator.ingest(self.file_path, self.store)
            if self.evidence_file:
                self.store.save_evidence(
                    self.project_id,
                    questionnaire.load_evidence_file(self.evidence_file),
                )
        return self.project_id

    def sections(self) -> list[Section]:
        return self.store.get_sections(self.project_id)

    def append_template(self, template) -> int:
        current = self.store.get_sections(self.project_id)
        existing = {s.title.strip().lower() for s in walk_sections(current)}
        added = 0
        chapters: dict[int, Section] = {}

        def register_chapter(section: Section) -> None:
            num = _chapter_number(section.title)
            if num is not None and num not in chapters:
                chapters[num] = section

        for section in walk_sections(current):
            register_chapter(section)

        for item in template:
            title = item.title.strip()
            if not title or title.lower() in existing:
                continue
            existing.add(title.lower())
            num = _chapter_number(title)
            parent = None
            if _is_subsection(title) and num is not None:
                parent = chapters.get(num)
            if parent is not None:
                parent.children.append(
                    new_section(
                        title=title,
                        level=parent.level + 1,
                        order=len(parent.children) + 1,
                        parent_id=parent.section_id,
                        description=item.description or "",
                    )
                )
            else:
                section = new_section(
                    title=title,
                    level=1,
                    order=len(current) + 1,
                    parent_id=None,
                    description=item.description or "",
                )
                current.append(section)
                register_chapter(section)
            added += 1
        if added:
            self.store.save_sections(self.project_id, current)
        return added

    def run(
        self,
        prompt: str,
        on_progress,
        on_stream,
        *,
        cancel=None,
        references: list[tuple[str, str]] = (),
    ) -> dict[str, GenerationResult]:
        return orchestrator.run(
            self.project_id,
            self.store,
            prompt=prompt,
            stream=on_stream,
            progress_cb=on_progress,
            cancel=cancel,
            references=references,
        )

    def rewrite(
        self,
        prompt: str,
        section_ids: list[str],
        on_progress,
        on_stream,
        *,
        cancel=None,
        references: list[tuple[str, str]] = (),
    ) -> dict[str, GenerationResult]:
        return orchestrator.rewrite(
            self.project_id,
            self.store,
            section_ids,
            prompt=prompt,
            stream=on_stream,
            progress_cb=on_progress,
            cancel=cancel,
            references=references,
        )

    def merge_similar_sections(
        self,
        on_progress,
        *,
        threshold=None,
        cancel=None,
    ) -> list[MergeResult]:
        return orchestrator.merge_similar_sections(
            self.project_id,
            self.store,
            threshold=threshold,
            progress_cb=on_progress,
            cancel=cancel,
        )

    def save_evidence(self, answers: dict[str, str]) -> None:
        self.store.save_evidence(self.project_id, answers)

    def get_evidence(self) -> dict[str, str]:
        return self.store.get_evidence(self.project_id)

    def export(self) -> str:
        return export(
            self.project_id,
            self.store,
            fmt=self.fmt,
            out_dir=self.out_dir,
            title=self.title,
        )

    def preview(self) -> str:
        return preview_document(self.project_id, self.store, title=self.title)


def _normalize_answer(text: str) -> str:
    return " ".join(text.strip().lower().split())


def _fmt_tokens(n: int) -> str:
    """Compact token count: 123 -> '123', 12345 -> '12.3k', 1234567 -> '1.2M'."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


_ROMAN = {
    "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7,
    "VIII": 8, "IX": 9, "X": 10, "XI": 11, "XII": 12, "XIII": 13,
    "XIV": 14, "XV": 15,
}

_WORD_NUMBERS = {
    "ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5, "SIX": 6,
    "SEVEN": 7, "EIGHT": 8, "NINE": 9, "TEN": 10, "ELEVEN": 11,
    "TWELVE": 12, "THIRTEEN": 13, "FOURTEEN": 14, "FIFTEEN": 15,
}


def _chapter_number(title: str) -> int | None:
    """Extract a chapter number from a title like "CHAPTER THREE" or "3".

    Handles ``CHAPTER N`` (arabic, roman, or spelled-out), ``N.`` / ``N:``
    prefixes, and plain numbers. Returns ``None`` for titles with no
    chapter number.
    """
    m = re.match(r"^CHAPTER\s+([A-Za-z0-9]+)", title, re.IGNORECASE)
    if m:
        token = m.group(1).upper()
        if token.isdigit():
            return int(token)
        return _ROMAN.get(token) or _WORD_NUMBERS.get(token)
    m = re.match(r"^(\d+)\s*[.:]", title)
    if m:
        return int(m.group(1))
    return None


def _is_subsection(title: str) -> bool:
    """True when the title looks like a numbered subsection ("3.1 Safety")."""
    return bool(re.match(r"^\d+\.\d+\s", title))


def run_tui(
    file_path: str | None = None,
    *,
    fmt: str = "markdown",
    out_dir: str | None = None,
    title: str | None = None,
    evidence_file: str | None = None,
) -> int:
    """Launch the Textual app; returns its exit code.

    With ``file_path`` the app opens straight into the chat workspace;
    without it, the StartScreen file picker runs first.
    """
    # tqdm inside sentence_transformers creates a multiprocessing lock on its
    # first use; from the pipeline worker thread that forks the resource
    # tracker while asyncio owns the main-thread fds -> "bad value(s) in
    # fds_to_keep". A throwaway lock here starts the tracker on the main thread.
    multiprocessing.Semaphore(1)
    log_path = setup_file_logging()
    app_log = logging.getLogger("quill_engine")
    app_log.info("TUI starting (file=%s, fmt=%s, log=%s)", file_path, fmt, log_path)
    runner = None
    if file_path is not None:
        runner = RealPipelineRunner(
            file_path,
            fmt=fmt,
            out_dir=out_dir,
            title=title,
            evidence_file=evidence_file,
        )
    app = QuillTuiApp(file_path, runner=runner)
    if runner is None:
        app._runner_kwargs = {
            "fmt": fmt,
            "out_dir": out_dir,
            "title": title,
            "evidence_file": evidence_file,
        }
    exit_code = app.run()
    app_log.info("TUI exited (code=%s)", exit_code)
    return exit_code
