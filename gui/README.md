# Quill — desktop app

Tauri v2 + React/TypeScript. The Rust core owns persistence, credentials and all
privileged operations; the React layer never touches SQLite, the filesystem, or
provider credentials directly.

## Requirements

- Node.js 20+ and npm
- Rust 1.88+ — <https://rustup.rs>. Installed via rustup, which puts `cargo` in
  `~/.cargo/bin`. If `cargo --version` is not found, add this to your shell
  profile: `[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"`
- Linux only: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev` (macOS and Windows need nothing extra)

## Run a dev build

```bash
cd gui
npm install
npm run tauri:dev
```

That starts Vite on `http://localhost:1420`, compiles the Rust core, and opens
the Quill window with hot reload for the frontend. Rust changes require a
recompile, which Tauri handles automatically — just save the file.

The first build takes a few minutes because it compiles the whole Tauri and
ProseMirror dependency tree; later starts are seconds. Quit with `Ctrl+C`.

### Other commands

```bash
npm run dev              # browser only, no Rust core (localStorage fallback)
npm run check            # build + JS tests + rust fmt/clippy/test + integration
npm test                 # JS unit tests
npm run check:rust       # rustfmt, clippy -D warnings, cargo test
npm run verify           # persistence, legacy-import and export integration
npm run tauri:build      # platform installers (needs each OS to bundle)
npm run tauri:build:fast # compile the binary only, skip installer packaging
npm run icon             # regenerate app icons from the brand mark
```

`npm run tauri:*` goes through `scripts/tauri.sh`, which puts the rustup
toolchain on `PATH` first, so the commands work from IDE terminals and CI
runners that do not load your shell profile.

### Where the data lives

- Linux: `~/.local/share/app.quill.workspace/quill.db`
- macOS: `~/Library/Application Support/app.quill.workspace/quill.db`
- Windows: `%APPDATA%\app.quill.workspace\quill.db`

To start from scratch, delete that directory.

## Architecture

| Layer | Location | Responsibility |
| --- | --- | --- |
| UI | `src/` | React components, styling, library, editor, assistant |
| Editor state | `src/editor/` | Tiptap/ProseMirror bound to a Yjs document |
| Export dialog | `src/ExportDialog.jsx` | Format picker, native save dialog, result reporting |
| Icons | `src/Icon.jsx` | Inline SVG registry, shared across components |
| Platform seam | `src/platform/store.js` | Browser/Tauri split for documents, settings, secrets, export |
| Yjs persistence | `src/platform/ydoc.js` | LocalYDoc: load, batched persistence, compaction, retry |
| Core | `src-tauri/src/` | Commands, SQLite, keyring, Yjs store, export, legacy import |
| Schema | `src-tauri/migrations/` | Versioned local schema (source of truth) |

### Export pipeline

One renderer feeds every non-Markdown format:

```text
ProseMirror JSON ──▶ render_html() ──▶ .html  (self-contained, CSS inlined)
                               ├──▶ printpdf::PdfDocument::from_html ──▶ .pdf
                               └──▶ XHTML for the EPUB spine            ──▶ .epub
Markdown ──▶ @tiptap/markdown (frontend) ──▶ atomic write ──▶ .md
```

Markdown is serialised in the frontend on purpose. ProseMirror JSON → HTML →
Markdown loses node identity (mark merging, hard breaks, ordered-list start
values, custom nodes), so `@tiptap/markdown` maps nodes and marks directly and
Rust only writes the bytes.

Properties of the renderers:

- **Allowlisted.** Only known node and mark types are emitted. An unknown node
  contributes its children and raises a warning, so text is never silently lost.
- **URL-checked.** `href`/`src` allow `http`, `https`, `mailto`, `tel`,
  relative URLs and `data:image/*`. Anything else keeps its text but loses the
  link. `javascript:` and `vbscript:` cannot survive.
- **Escaped.** Text nodes and attributes are entity-encoded. A highlight colour
  is only accepted as a hex value, so `url(javascript:…)` cannot be injected.
- **Atomic writes.** Every export writes to a temporary file in the *same
  directory*, `fsync`s, then renames. An interrupted export cannot destroy an
  existing file, and a truncated EPUB or DOCX cannot be left behind.
- **Lossy conversions are reported.** `ExportOutcome.warnings` is surfaced in
  the dialog rather than dropped.

`src-tauri/src/export.rs` holds the renderer and writers;
`src-tauri/examples/export_samples.rs` writes one document in every format for
manual inspection.

### Data model

Local SQLite is the **canonical store**. PocketBase will be added later as a
remote replica, never as a second source of truth.

- `documents` — metadata only. The body lives in the Yjs store, not in a
  `content` column, so there is no competing copy to drift.
- `ydoc_updates` — durable CRDT update log. Idempotent: the update id is a hash
  of `(document_id, bytes)`, so a retried write is a no-op.
- `yjs_snapshot` / `yjs_state_vector` (on `documents`) — the last folded
  full state. Compaction prunes only the updates a snapshot actually covers.
- `sync_outbox` — written in the same transaction as document changes, so an
  acknowledged edit cannot be lost by a crash.
- `settings` — non-secret preferences. `secrets_meta` records only *which*
  provider credentials exist.
- `jobs` / `job_events` — durable state for AI, import, export and migration.
- `migration_runs` — content-hashed, so re-running an import is free.

WAL journaling, `synchronous=FULL` and foreign keys are enabled on every pooled
connection. Update ordering uses SQLite's implicit `rowid`, not `created_at` —
`datetime('now')` only has second resolution, so a burst of edits within one
second would tie and fall back to an arbitrary order.

### The editor

The body is a Yjs fragment named `quill-body`. That name is part of the
persisted format and is pinned deliberately.

- Imported/legacy HTML is parsed **through the Tiptap schema**, which is the
  sanitisation boundary: undefined nodes and marks are dropped, and script tags,
  event handlers, `javascript:` URLs and embedded objects do not survive.
- StarterKit's `UndoRedo` is disabled because the Collaboration extension
  supplies its own history; leaving both enabled causes conflicting undo.
- Statistics are computed from the ProseMirror document, not from HTML.
- The editor mounts only after the Yjs state has loaded, otherwise ProseMirror
  seeds an empty paragraph into a document that already has content.

### Legacy import

`database/database.json` from the previous Python implementation is imported
non-destructively:

```bash
# preview — classifies every key, writes nothing
cd src-tauri && cargo run --example legacy_report -- ../../database/database.json
```

Notable properties:

- **Nothing is hard-coded.** The importer discovers namespaces and validates
  each record against observable properties, because the file's shape has
  changed between runs.
- **Content identity is the `markdown` field, not the section tree.** The seven
  document records share identical `markdown` but have different `sections`
  trees, because the trees are a derived parse artifact that drifted between
  parser versions. Hashing the rendered body would import the same document
  seven times.
- **Structure is recovered from `sections`.** The `markdown` field has already
  lost its heading markers, so it cannot be used to rebuild the outline.
- **Every key gets a verdict** (`imported`, `merged`, `quarantined`,
  `discarded`) with a reason, and the report is stored in `migration_runs`.
- **The source file is never modified.** A test asserts it is byte-for-byte
  unchanged after import.

## Testing

| Suite | What it covers |
| --- | --- |
| `cargo test` (76) | schema, CRUD, transactional outbox, Yjs store, ordering, compaction, keyring metadata, legacy import, and the export renderers/writers |
| `tests/ydoc.test.mjs` (14) | the real `LocalYDoc`: batching, retry, compaction, isolation, convergence |
| `tests/editor.test.mjs` (12) | HTML conversion and schema sanitisation via a real editor |
| `tests/markdown.test.mjs` (11) | Markdown serialisation through a real editor |
| `scripts/verify-persistence.mjs` | persistence contract against a real SQLite file |
| `scripts/verify-legacy-import.mjs` | importer end-to-end, including idempotency |
| `scripts/verify-export.mjs` | all five formats written, then inspected with `file`, `pdftotext` and `unzip` |

## Status

Working:

- Tauri shell, SQLite schema, typed IPC
- Library with seed data migrated into SQLite
- Tiptap/ProseMirror editor with Yjs-backed, durable, collaborative-capable
  local state
- Settings persistence and OS-keyring-backed provider secrets
- Self-hosted Inter and DM Mono (Latin subset, ~265 KB) with no remote requests
- Export to HTML, PDF, DOCX, EPUB and Markdown, with atomic writes
- Non-destructive legacy import with a full per-key report
- Restrictive CSP and minimal Tauri capability set

Not yet implemented, and known issues, are tracked in
[`TODO.md`](TODO.md) — phased, with the files each item touches and the checks
that close it. The short version: Phase 0 is foundations that block the rest,
then custom themes, image backgrounds and onboarding, with the older backlog
carried into Phase 4.
