# Chat routed through the orchestrator / TaskRouter

## Goal
A chat turn is classified (`Agent.Nous`) and dispatched through the orchestrator's
task pipeline instead of the current bare `Agent.model()` call, so a chat turn can
reach all six task types. The reply carries the classification and any research
sources; a genuine failure is reported as a failure instead of a fake answer.

## Locked decisions
- **D-chat-1 — all six types.** Chat may reach WRITE, REWRITE, CRITIQUE, RESEARCH,
  EXPLAIN, SMALLTALK.
- **D-chat-2 — classify first, tell the user, then run.** The classification is
  returned in the same synchronous response as a `task` label; the panel reveals it
  before painting the answer. No SSE protocol is added for chat.
- **D-chat-3 — ephemeral document (Option A).** WRITE/REWRITE/CRITIQUE need a
  `document_id`; chat has none. The editor draft is parsed on demand into a real
  document, dispatched against, then discarded.
- **D-chat-4 — namespace + delete.** The ephemeral id is `chat:{uuid}`, so every
  derived key (`written:chat:{uuid}`, `research:chat:{uuid}`, `concept:chat:{uuid}`,
  `critique:chat:{uuid}`) inherits the prefix. Every `chat:{uuid}*` row is deleted in
  a `finally`, so the user's DB never accumulates chat scratch.
- **D-chat-5 — auto-Write first for REWRITE/CRITIQUE.** `ReWrite`/`Critique` read
  `written:{id}`; a fresh ephemeral doc has none, so they would degenerate. For a chat
  REWRITE/CRITIQUE the flow runs Write first, then the requested task on that result.
- **D-chat-6 — synchronous, block until done.** Heavy tasks (WRITE/RESEARCH/EXPLAIN)
  run to completion inside the chat turn. The panel shows a "researching this turn"
  state for the whole duration. Honours "all six" literally.
- **D-chat-7 — real errors raise.** A failure (string-error return, `result["error"]`,
  or an exception) is raised so `_chat` returns HTTP 502 and the panel renders a
  failure bubble. `route_task`'s `except -> "An error occurred: <e>"` swallow is fixed
  without regressing the `/runs` consumer.

## Waves

### W1 — Python core
- `components/orchestrator.py` `route_task`: replace the swallow. Raise a typed
  `TaskRoutingError(RuntimeError)` carrying the real message. The `/runs` consumer
  (`_execute`) already converts a string return into `RuntimeError`; add a `catch` for
  the typed error so the run still reports it as a failure with the same wording.
- `api.py`: add `_route_chat_turn(provider, transcript, draft) -> dict` returning the
  normalised `{reply, task, sources}`. Steps:
  1. `question` = last user text; build the `task` string from history + question.
  2. Classify with `Agent(provider).Nous(task)`. A `str` return (JSON failure) raises.
  3. Map REWRITE/CRITIQUE to auto-Write-first; SMALLTALK/RESEARCH/EXPLAIN/WRITE direct.
  4. For the document-bearing three, mint `chat:{uuid}` via
     `DocumentParser(provider=provider).parse_text(draft, name="chat-draft.md",
     persist=True)`, rewrite its `unique_id` to `chat:{uuid}`, persist under that key,
     then dispatch `TaskRouter(provider).task_executor` directly (document_id forwarded).
  5. Normalise every shape: bare `str` -> `{reply: str}`; `Write`/`ReWrite` -> `markdown`;
     `Explain` -> `answer` (+ `research.pages` as sources); `Research` -> `summary`/`corpus`
     (+ `pages` as sources); `Critique` -> `critique["thoughts"]`; error dict/`blocked`
     -> raise.
  6. `finally`: delete every `chat:{uuid}*` key via `list_keys()` + `delete()`.
- `api.py` `_chat`: call `_route_chat_turn`, return `{reply, task, sources}`; on failure
  return 502 `{error}` (existing behaviour, now for real failures only).

### W2 — Python tests
- `tests/test_chat_routing.py`: classification dispatch per type; ephemeral isolation
  (a pre-existing document row is untouched, and no `chat:*` row survives the turn);
  all six shapes normalised; the error path raises -> 502.

### W3 — Rust transport
- `gui/src-tauri/src/pipeline.rs`: extend `ChatReply` with `task: String` and
  `sources: Vec<ChatSource>` (`ChatSource { title, url }`, serde camelCase). Thread
  them through `post_chat_to_sidecar` (read from the sidecar JSON) and `chat_direct`
  (empty `task`, empty `sources` — a direct call is unclassified).
- Tests: reply shape round-trips; `chat_direct` carries the new fields.

### W4 — Frontend
- `gui/src/platform/store.js`: `chat()` unchanged in call shape; document the new
  `{reply, transport, task, sources}` return.
- `gui/src/library/ChatPanel.jsx`: AI bubble gains a collapsible sources section
  (`<details>`/chevron) when `sources.length`; a "researching this turn" state driven by
  the `task` label, shown while the turn is pending. Reuse the existing typing/orb
  visual language.
- `gui/tests/support/dom-harness.mjs` + `gui/tests/chat-window.test.mjs`: fixtures carry
  `task`/`sources`; mutation-prove the sources render.

### W5 — Gates
- `npm run check` (3 JS passes + rustfmt + clippy) and the Python suites
  (`test_provider_wiring`, `test_regressions`, `test_drift`) green.
- Live: sidecar on `:8099`, a chat turn that classifies to EXPLAIN returns a sources
  list; a forced failure returns 502, not a fake reply.

## Out of scope
- A streaming/SSE protocol for chat progress (only if a later request demands it).
- Fixing `Critique`'s dead `isinstance(dict)` branches (Warden/Oracle pydantic) — noted,
  not fixed; the normaliser reads `critique["thoughts"]`.
- Removing `Agent.__init__`'s `os.environ` fallback (T13 residue).
