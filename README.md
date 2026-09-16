# quill_engine

OpenCode-style AI report engine: ingest a document, research it, and rewrite
every section with any LLM provider. quill_engine takes a reference report
(docx/pdf/pptx/md/txt), parses it into sections and subsections, embeds and
researches the content, then regenerates each section in document order under
an evidence gate — exporting corrected Markdown or DOCX. The Textual TUI
presents all of this in an OpenCode-style chat workspace (chat log, sidebar,
inline evidence forms).

## Quickstart

```bash
uv sync

# TUI (pick the source file inside the app)
uv run python main.py

# Non-interactive CLI
uv run quill <file>
uv run python -m quill_engine.cli <file> --dry-run   # ingest only, no generation
```

The task instruction comes from `QUILL_PROMPT` when set; otherwise the CLI asks
interactively (in a TTY). Useful CLI flags:

```text
--format/-f markdown|docx   export format (default: markdown)
--out/-o DIR                output directory (default: ./output)
--providers LIST            comma-separated failover order, overrides LLM_PROVIDERS
--evidence FILE             JSON or "field: value" YAML with user-supplied evidence
--interview                 prompt interactively for missing evidence before generating
--dry-run                   ingest only (parse, chunk, embed), then exit
--research / --no-research  enable/disable the research phase
--store memory|opensearch   storage backend (honors QUILL_STORE)
--tui                       run the Textual TUI
--verbose/-v                debug logging
```

## Providers

Built-in providers: `groq`, `openrouter`, `google`, `ollama`, `openai`,
`deepseek`, `mistral`, `together`, `xai`, `fireworks`, `lmstudio`, `vllm`.
Keys are read from the environment or a `.env` file (see `.env.example`).

`LLM_PROVIDERS` sets the failover order (default `ollama`); the CLI tries each
provider in turn and cools down failing ones:

```bash
LLM_PROVIDERS=ollama,groq,openrouter
```

For custom OpenAI-compatible endpoints, add them to
`~/.config/quill/providers.json` (or `$QUILL_PROVIDERS_FILE`). The optional
`chain` key overrides `LLM_PROVIDERS`; custom entries override built-ins on
name clash:

```json
{
  "providers": {
    "my-vllm": {
      "base_url": "http://localhost:8000/v1",
      "model": "Qwen/Qwen2.5-7B-Instruct",
      "api_key_env": "MY_VLLM_KEY",
      "requires_key": false
    },
    "groq": { "model": "llama-3.3-70b-versatile" }
  },
  "chain": ["ollama", "my-vllm", "groq"]
}
```

No API key is required for fully-local runs: `LLM_PROVIDERS=ollama` with
Ollama (or `lmstudio`/`vllm`) running.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDERS` | `ollama` | Provider failover order |
| `QUILL_STORE` | `memory` | Storage backend: `memory`, `opensearch` (or `disk`) |
| `QUILL_RESEARCH` | `1` | Enable the research phase (query curator -> web search -> knowledge graph) |
| `QUILL_PROFILE` | `auto` | Model size profile: `auto`, `small`, `large` |
| `QUILL_STAGED` | `auto` | Staged writing for small models: `auto`, `1`, `0` |
| `QUILL_SEARCH_CACHE_TTL_H` | `168` | Search-result cache TTL in hours |
| `QUILL_SEARCH_CONCURRENCY` | `3` | Parallel web-search requests |
| `QUILL_PLAG_THRESHOLD` | `0.6` | Sentence similarity above which a section is flagged for rework |
| `QUILL_EVIDENCE_FILE` | *(empty)* | Evidence file loaded automatically per run |
| `QUILL_OS_VERIFY_TLS` | `1` | Verify TLS for OpenSearch (set `0` for self-signed certs) |
| `OPEN_SEARCH_URL` / `_USER` / `_PASSWORD` | *(empty)* | OpenSearch cluster connection |
| `REDIS_URL` | *(empty)* | Optional Redis backend |

See `.env.example` for the full template.

## Features

- **Evidence gate** — sections declare required evidence; anything unmet is
  blocked (never written) unless supplied via `--evidence`, `--interview`, or
  the interactive follow-up wizard.
- **Staged writing** — small models write in outline/draft/refine stages
  instead of one long completion (`QUILL_STAGED=auto` picks based on the model).
- **Plagiarism checks** — sentence-level similarity against the source flags
  verbatim copy (`QUILL_PLAG_THRESHOLD`, `QUILL_VERBATIM_THRESHOLD`).
- **Search caching** — search results cached on disk with a configurable
  TTL and bounded concurrency.
- **Token usage accounting** — per-provider/model token counts tracked across
  the run.

## Project layout

`quill_engine/` holds the package (CLI in `cli.py`, TUI in `tui.py`,
pipeline in `orchestrator.py`, provider failover in `providers.py`,
config in `config.py`); `main.py` is the TUI shim, `gui/` the Electron
app, `tests/` the test suite.

## Testing

```bash
uv run pytest
```
