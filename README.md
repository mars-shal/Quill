<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo/quill-inverse.svg">
    <img src="brand/logo/quill-color.svg" alt="Quill" width="230">
  </picture>
</p>

<h1 align="center">Quill</h1>

<p align="center">
  A desktop editor for long-form writing, with AI inside the text instead of in a separate chat window.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-1A1A1A">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-1A1A1A">
  <img alt="React 18" src="https://img.shields.io/badge/React-18-1A1A1A">
  <img alt="Local-first" src="https://img.shields.io/badge/local--first-yes-1A1A1A">
</p>

---

## Why Quill

Most writing tools split the page and the assistant into two worlds. Quill keeps
them together: the library is a shelf, the editor is a page, and the assistant
can read the draft you have open. Everything is stored locally, and the app is
still a perfectly good offline editor when no model is connected.

## What is in it

- **A real library.** Documents live on a shelf, with collections, status
  filters, grid/list views, word counts and designed empty states.
- **A focused editor.** Tiptap/ProseMirror with headings, lists, quotes,
  highlights, images, formulas, tables and per-selection typography.
- **Editable tables.** Add or remove rows and columns, resize columns, and
  reshape an existing table from the toolbar.
- **An assistant that sees the draft.** Per-document conversations, streaming
  stages, attachments read as text, and optional write-back into the page.
- **Themes with taste.** Light, Paper and Dark built in, plus curated presets
  including Catppuccin Latte/Mocha, Nord, Dracula, Tokyo Night, Gruvbox, Rose
  Pine and Everforest. The picker groups them by light and dark.
- **Local-first storage.** SQLite, Yjs documents, settings and credentials stay
  on the machine. Export to Markdown, HTML, PDF, DOCX and EPUB.
- **Small details.** A skeleton shelf that decodes in through
  [`ascii-reveal`](https://github.com/mars-shal/ascii-reveal), a branded
  onboarding card, a real 404, and reduced-motion support throughout.
- **Natural-voice review.** The originality report includes a craft signal for
  flat rhythm, repeated openings, stock transitions and uniform paragraphs. It
  is a readability report, not an authorship probability or a detector score.
  Pipeline runs write it beside the draft as `output/<session>.style.md`.

## A look at the shelf

![Quill on the web](brand/mockups/quill-website.png)

More of the brand kit lives in [`brand/`](brand/).

## Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| UI | React 18, Vite, Tailwind bridge |
| Editor | Tiptap 3 / ProseMirror |
| Collaboration state | Yjs |
| Storage | SQLite via the Rust core |
| Export | Rust renderer for PDF/EPUB/DOCX, Tiptap Markdown for `.md` |
| Assistant | Provider-agnostic chat layer with local and hosted models |

## Getting started

Requirements:

- Node.js 20+ and npm
- Rust 1.88+ ([rustup](https://rustup.rs))
- [uv](https://docs.astral.sh/uv/) for the Python pipeline sidecar
- Linux only: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`

```bash
uv sync                  # Python 3.14 + pipeline dependencies
cd gui
npm install
npm run tauri:dev
```

That starts Vite, compiles the Rust core and opens the Quill window. For a
browser-only preview:

```bash
cd gui
npm run dev
```

Useful commands:

```bash
npm run build            # production frontend build
npm run sidecar:build    # package the Python pipeline as a sidecar binary
npm run build:desktop    # frontend + sidecar, the packaged-build path
npm test                 # unit + mocked + real-motion JS suites
npm run check:contrast   # theme and cover contrast gate
npm run check:rust       # rustfmt, clippy and cargo tests
npm run tauri:build      # platform installers, sidecar included
```

## The sidecar

The assistant and the long-form pipeline run behind `api.py`. Packaged builds
carry it as a PyInstaller sidecar (`quill-sidecar-<target-triple>`) through
Tauri's `externalBin`; the Rust supervisor starts it with the app's data
directory as its workspace. Chat starts it on first use if it is not already
answering, so the assistant does not silently fall through to the direct
provider. Embeddings run locally through `fastembed`/ONNX,
using the same `all-MiniLM-L6-v2` model as before. The model is fetched once
into the app-data `fastembed` cache, then all inference stays on the machine.

## Running it on another machine

Quill is a desktop app plus two optional services, and only the first of those
travels inside the AppImage. Knowing which is which is the difference between a
five-minute first run and a support thread.

| Layer | Ships with the app | Where it lives |
| --- | --- | --- |
| App, Python sidecar, SearXNG server | yes | inside the AppImage |
| Documents, settings, keys | no | per-user app-data directory |
| Convex (telemetry) | no | optional, configured per install |

**First run, in order:**

1. Open Quill. The Rust supervisor starts the bundled pipeline sidecar on a
   loopback port and waits for `/health`; nothing has to be started by hand.
2. Connect a provider in onboarding, or enter an API key on
   **Settings → Assistant**. A local model or a CLI tool needs no key at all.
3. Search needs no setup. If nothing answers on `127.0.0.1:8080`, Quill starts
   its bundled SearXNG (`quill-searxng`, an unmodified upstream build) and points
   the pipeline at it. The settings file that enables `format=json` is written
   into the app-data directory on demand.
4. **Settings → System** reports the three pieces separately: the writing
   service, the search backend, and the generation ledger. Each row says what is
   wrong and offers the one action that fixes it — restart the service, re-probe
   search, or point at where the ledger is written.
5. Convex is opt-in and per install. Without `QUILL_CONVEX_URL` and
   `QUILL_CONVEX_TOKEN`, every run still records to `generations.jsonl` locally.

Docker is still supported, as a fallback rather than a requirement: a machine
without the bundled binary but with Docker gets the old `quill-searxng`
container, started or created on demand. With neither, research falls back to
the DuckDuckGo and Bing scrapers and the rest of the app is unaffected.

Nothing machine-specific is baked into the build: keys live in the OS credential
store, the workspace is under the user's app-data directory, and the search
server is built from a pinned upstream commit. The AppImage itself is the same
file everywhere.

For a shared or headless install, use the Compose stack instead — it runs the
sidecar and SearXNG together with restart policies, and the desktop app can drive
it through `QUILL_API_URL`:

```bash
cp .env.example .env        # provider key + optional telemetry
docker compose up --build
```

## Generation metrics

Every long-form `WRITE` records one metadata row in
`output-api/generations.jsonl`. It answers what ran, on which model, how long
each stage took, what evidence it had, and how much it produced. The prompt is
never copied into the ledger: the record stores its SHA-256 hash and length, and
only includes a 280-character preview when `QUILL_TELEMETRY_PROMPT=1`.

When `QUILL_CONVEX_URL` and `QUILL_CONVEX_TOKEN` are set, the same record is
POSTed to the Convex HTTP action in [`convex/http.ts`](convex/http.ts) and is
queryable in the dashboard. See [`convex/README.md`](convex/README.md) for the
deployment. Without those variables the ledger stays local; a failed Convex
POST is logged and never fails the generation.

A real run (2026-11-23, the distributed student-records book):

| Metric | Value |
| --- | --- |
| Research | **15m 27s** |
| Writing (10 sections) | **2m 33s** |
| End-to-end | **26m 48s** |
| Corpus | **103,378 chars** |
| Sources | **32 retrieved, 21 relevant** |
| Research quality | **0.599** |
| Output | **2,527 words / 17,237 chars** |
| Writing model | `opencode-go/gpt-5.6-luna` |

The first pass used `opencode/big-pickle`, which took about 2m49s for the first
217-word section; with a 32-section plan that was roughly 90 minutes. It was
stopped after that section and its completed research corpus was reused for the
10-section run above. The end-to-end figure includes the aborted pass and the
model switch; the final writing pass itself was 2m33s.

## Repository map

```text
gui/                 Tauri app (React frontend + Rust core)
  src/               library, editor, assistant, settings, themes
  src-tauri/         commands, SQLite, Yjs store, export, migrations
  tests/             JS suites and shared DOM harness
brand/               brand book, logo kit, mockups and the palette of record
components/          Python long-form generation pipeline
api.py               HTTP/SSE wrapper around the pipeline
main.py              CLI entry point for a generated thesis run
```

The Python pipeline is the long-form generation service the desktop app can
drive; it is optional for everyday writing. See `gui/README.md` for the full
architecture and data locations.

## Brand

The mark, wordmark and palette are documented in [`brand/README.md`](brand/README.md).
Runtime copies live in [`gui/public/brand/`](gui/public/brand/).

## License

[MIT](LICENSE) © 2026 Quill contributors.

Packaged builds also carry **[SearXNG](https://github.com/searxng/searxng)**, the
search backend, under **AGPL-3.0-or-later**. It is bundled unmodified: Quill only
starts it and writes its settings file. The exact upstream commit and the SHA-256
of the source archive are pinned in
[`gui/scripts/build-searxng.py`](gui/scripts/build-searxng.py), which is the
corresponding-source reference for any binary built from it; the settings Quill
writes at run time are in `gui/src-tauri/src/search.rs`.
