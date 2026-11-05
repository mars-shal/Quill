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
- Linux only: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`

```bash
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
npm test                 # unit + mocked + real-motion JS suites
npm run check:contrast   # theme and cover contrast gate
npm run check:rust       # rustfmt, clippy and cargo tests
npm run tauri:build      # platform installers
```

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
