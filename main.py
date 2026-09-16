"""Entry point — ``python main.py`` launches the Textual TUI.

The TUI drives the whole pipeline (ingest -> generate -> export) in an
OpenCode-style chat workspace: pick the source report on the start screen,
describe the task, watch the run in the chat log + sidebar, and answer the
inline evidence form for blocked sections. The non-interactive CLI lives in
:mod:`quill_engine.cli` (``uv run python -m quill_engine.cli <file>``);
this shim always launches the TUI — no flags, no arguments. The file is
chosen inside the app.
"""

import sys

from quill_engine.tui import run_tui


def main() -> int:
    return run_tui()


if __name__ == "__main__":
    sys.exit(main())
