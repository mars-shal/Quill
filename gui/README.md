# Quill GUI — an IDE for writers

Electron desktop app ("Cursor for writers") on top of the `quill_engine`
Python pipeline. The renderer talks to a local FastAPI sidecar over
`http://127.0.0.1:8765` (REST + WebSocket); the engine never touches the network
beyond the LLM/web-search providers it is already configured with.

```
┌──────────────────────── Electron (gui/) ────────────────────────┐
│ main process: window + spawns the Python sidecar + native menus │
│ renderer:     React + TipTap WYSIWYG editor (markdown persisted)│
└───────────────┬─────────────────────────────────────────────────┘
                │ HTTP + WS (localhost only)
┌───────────────▼─────────────────────────────────────────────────┐
│ quill_engine/api — FastAPI sidecar: projects, sections, runs,   │
│ validation, evidence, export; run events streamed over /ws      │
└──────────────────────────────────────────────────────────────────┘
```

## Run (development)

```bash
# from the repo root — one-time
python3 -m ensurepip --upgrade && .venv/bin/python -m pip install websockets  # if uv venv lacks pip
cd gui && npm install

# every time (needs Node ≥ 18, e.g. via nvm)
cd gui && npm run dev
```

The Electron main process spawns `.venv/bin/python -m quill_engine.api.server`
automatically and waits for its health check. You can also open the renderer
alone in a browser at the vite URL (currently `http://localhost:5174`) — it
falls back to `http://127.0.0.1:8765` and uses a prompt() instead of the native
open dialog.

## What works

- **Open** a source document (md/txt/docx/pdf/pptx) → section tree with
  per-section status glyphs, progress and word counts. Re-opening a file
  resumes its persisted project (JsonFileStore, `.quill_engine/projects/`).
- **Editor**: TipTap WYSIWYG with a formatting toolbar (headings, bold,
  italic, underline, strike, lists, quote, code block, rule, undo/redo).
  Content is stored as markdown per section; autosave after 800 ms.
- **Assistant** panel: prompt drives the full pipeline (`/run`) or a targeted
  `/rewrite` of the open section; live progress, per-section text streaming,
  Stop button; evidence form for blocked sections.
- **Inspector**: word count, target, reading time, Flesch readability,
  validation checks (too_short, placeholder, verbatim_copy, …) and sources.
- **Problems** panel: document-wide blocked/failed/warning sections.
- **Export** markdown or DOCX (`export_service`, instant — no hidden rewrites).

## Layout

```
gui/
  electron/main.ts       window, sidecar spawn/health, menus, open dialog
  electron/preload.ts    contextBridge API (serverUrl, pickSourceFile, …)
  src/App.tsx            IDE layout shell + welcome pane
  src/components/        TitleBar, SectionTree, EditorPane, ChatPanel,
                         InspectorPanel, ProblemsPanel, StatusBar
  src/state/store.ts     zustand store: project/tree/section/chat/run + WS events
  src/lib/api.ts         typed REST client   src/lib/ws.ts  reconnecting WS
  src/styles.css         warm editorial theme (#c15f3c / #ffffff / #f4f3ee / #b1ada1)
```

## Packaging (not yet done)

Distribution needs a bundled sidecar: PyInstaller `quill_engine.api.server`
into `gui/resources/`, then electron-builder with `extraResources`. Dev mode
resolves the venv from the repo root; `repoRoot()` in `electron/main.ts` is the
single place to change.
