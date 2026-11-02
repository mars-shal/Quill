# Provider registry and run-path wiring (Quill_New)

## Context: what is already established, do not re-derive

Verified this session. Treat each line as a fact, not a hypothesis.

- **The chat panel is a stub, deliberately out of scope.** `gui/src/library/ChatPanel.jsx:666-688`
  `send()` appends the message, waits 850ms, replies from `replyFor()` (`:650-657`) — hardcoded
  keyword-matched strings. No `invoke`, no `fetch`. No `api_chat` command exists in
  `src-tauri/src/lib.rs:42-83`.
- **The model list is one hardcoded string.** `ChatPanel.jsx:459`
  `modelOptions = Array.from(new Set(['GPT-5.2', model]))`, rendered `:751-766`.
- **Provider config is a dead end.** `settings.provider` / `model` / `endpoint`
  (`src-tauri/src/settings.rs:16-24`) are written by the UI and persisted, but nothing on the
  request path reads them. `src-tauri/src/secrets.rs:97-104` `read_for_job` is
  `#[allow(dead_code)]`; its only caller is `account.rs:210` reading the auth-token slot. **A saved
  provider API key is never attached to any request.**
- **The only real outbound AI path is the run path.** `ChatPanel.jsx:597` → `store.js:559-569`
  `api_start_run` → `pipeline.rs:234-271` `Body { prompt, document_id, session_name, concept_mode }`
  → `api.py:340-371` → `utilis/model.py:163-167` `openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"),
  base_url=os.environ.get("OPENAI_BASE_URL"))`, call at `:198` `responses.create`.
- **The run path currently WORKS** via `.env`/Groq — a 561s completed run is in
  `logs/quill-20261014-094031.log`, so Groq does serve the Responses API. Do not "fix" this.
- **There is no provider registry, enum or dispatch anywhere** in TS or Rust. Provider identity is
  a free-form `String`.
- **Keyring slot is the provider display name** (`secrets.rs:18-21`) — unslugged, collides, and
  renaming a provider orphans its credential.
- **`deleteProviderSecret` exists in the seam with zero UI callers** (`store.js:339-345`,
  `commands.rs:129-130`).

## Decisions settled

- **D1 (amended, per Momus).** A real provider registry replaces the flat strings. It carries
  `id`, `label`, `vendor`, **and a separate `protocol`** — see D1a.
- **D1a (amendment — D1 as originally worded was wrong).** `kind[OpenAI|Anthropic|Google|
  OpenAI-compatible]` conflated *vendor* with *wire protocol*. Anthropic and Google do not speak
  the OpenAI protocol, so a vendor enum cannot select an API shape. The registry therefore has two
  independent fields:
  - `vendor: openai | anthropic | google | compatible` — who bills you
  - `protocol: openai_chat | openai_responses | anthropic_messages | google_generative` — which
    HTTP shape to speak
  `protocol` defaults to **`openai_chat`**, because `/chat/completions` is the near-universal
  denominator (Groq, Ollama, vLLM, LM Studio, OpenRouter, Together, DeepSeek, LiteLLM, llama.cpp,
  Azure) and `/responses` is OpenAI-only. Defaulting to `responses` fails the largest class of
  custom providers, and `QUILL_RETRIES=5` means a 404 is then retried five times.
- **D2.** The API key is read from the OS keyring **in Rust** and passed **per-request**. Not
  spawn-env. Accepted with the caveat in Momus R3: the isolation benefit is real (no child
  inheritance, not in `/proc`) but marginal, and the actual exposure was the bind address — fixed
  separately (done).
- **D3.** "All the env should be default providers" resolves to: on first run, seed the registry
  from `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `LLM_MODEL`, **copy the key into the OS keyring
  once**, and thereafter the registry is the only source of truth. Operational env
  (`QUILL_RPM`/`TPM`/`RETRIES`, `QUILL_SEARXNG_URL`, `QUILL_SEARXNG_CATEGORIES`,
  `QUILL_GAP_RESEARCH`, `GROUNDING_PROFILE`, `EMBEDDING_MODEL`, `VITE_POCKETBASE_URL`) **stays env**
  and is NOT turned into providers.
- **D4.** Chat stays a stub. Only the run path gets real providers.

## Momus review: two locked decisions amended, one premise corrected

- **D3's "only source of truth" was false as written.** There are **two** OpenAI clients, not one:
  `utilis/model.py:164` (uses `responses.create`) and `utilis/documentparser.py:139` (uses
  `chat.completions.create` at `:867`). Both read the same env vars. Task 2.4 covers the second.
- **The split-brain mechanism (R2).** **18 of 19** `.model(` call sites omit `model_name` and fall
  back to `model_name: str = os.environ.get("LLM_MODEL", ...)` captured **at import time**
  (`utilis/model.py:180`, `:228`, `:275`). After import you cannot distinguish "caller omitted it"
  from "caller passed the env value". The repo already documents this as a bug class in
  `utilis/coverage.py:118-124` — *"Env value read at CALL time, never at import time."*
- **R4 concurrency.** `api.py:368` spawns a daemon thread per `POST /runs` with no single-flight
  guard. Credentials must ride a **per-run** carrier, never a module global. `api.py:111`
  `_CURRENT = threading.local()` already exists and already carries per-run state (`:216`) — use it.
- **R8.** `api_start_run` returns 202, so a missing credential discovered in Python surfaces
  minutes later. Fail fast in Rust instead (Task 3.1).
- **Premise corrected.** My worry that `responses.create` was broken today was wrong — Groq serves
  it. The landmine is only about *other* providers.

## Environment facts

- Sidecar = `api.py` at repo root, spawned by `src-tauri/src/sidecar.rs`. `python_in`
  (`sidecar.rs:236`) resolves `<root>/.venv/bin/python` — Python 3.14.3 with all deps including
  `markitdown`. **Do not test with system `python3`; it lacks `markitdown`.**
- `pipeline.rs:29` `DEFAULT_BASE = "http://127.0.0.1:8000"`, overridable via `QUILL_API_URL`.
- `api.py` loads `.env` itself via `utilis/model.py:9` `load_dotenv()`, cwd = repo root.
- **`npm run check` now runs `check:rust`** (added this session). It does **not** run the Python
  suite: `tests/*.py` are standalone scripts, not pytest — `tests/test_plagiarism.py:38` calls
  `raise SystemExit()` at module import and aborts collection. Do not try to pytest them.
- Test infra: JS runs in two passes and `gui/scripts/check-test-lists.mjs` **fails** if a new
  `tests/*.test.mjs` is not listed in `gui/scripts/test-js.sh`.

## Done already this session (do not redo)

- Sidecar bind: `api.py:392` default `--host` is now `127.0.0.1`; `sidecar.rs` passes
  `--host 127.0.0.1` explicitly via the new `LOOPBACK` const. Verified: binds `127.0.0.1:8099`,
  not `0.0.0.0`.
- `pipeline.rs` `refused()` / `reason_from()` + 2 tests; `sse_field()` classifier + 3 tests.
- `npm run check` green: 309 JS + 149 Rust, rustfmt clean, clippy clean.
- `tests/thesis-run.test.mjs` drives the run panel through the DOM and pins dedupe, `runId`
  filtering, terminal teardown, sidecar-status refresh and a second run.

## Out of scope — do NOT bundle

- Chat / `api_chat`. (D4)
- Removing framer-motion, theming, anything in `TODO.md`.
- A `/models` capability fetch. The registry's `models[]` is the source of truth; a "Refresh"
  button may merge provider `/models` later. Never auto-fetch on panel open.

## TODOs

### Wave 0 — the fixture that makes everything else provable

- [ ] 1. **[HEAV] Fake provider HTTP server + pure Rust body builder** — new `gui/tests/support/fake-provider.mjs` (or `src-tauri/tests/`), `src-tauri/src/pipeline.rs`. Nothing below is verifiable without this. Register any new test file in `scripts/test-js.sh` or `check-test-lists.mjs` fails.
- [ ] 2. **[LIGHT] Fixture self-test** — assert the fake fails when a request it did not receive is expected, so it cannot silently pass everything.

### Wave 1 — registry, without changing which provider is used

- [ ] 3. **[HEAV] Migration `0004_providers.sql` + registry CRUD in Rust** — `src-tauri/migrations/`, `src-tauri/src/providers.rs` (new), `commands.rs`, `lib.rs`
- [ ] 4. **[HEAV] Keyring slot by provider slug, migrate legacy display-name slots** — `src-tauri/src/secrets.rs`, `providers.rs`
- [ ] 5. **[MED] Seed the registry from `.env` once, copying the key into the keyring** — `providers.rs`, `sidecar.rs`

### Wave 2 — thread config to Python (no behaviour change until 3.2)

- [ ] 6. **[HEAV] Rust resolves the credential per request and extends the `POST /runs` body** — `src-tauri/src/pipeline.rs`
- [ ] 7. **[HEAV] `api.py` accepts provider config; unknown protocol is a reasoned 400** — `api.py`
- [ ] 8. **[HEAV] `utilis/model.py` takes config; kill the three import-time `LLM_MODEL` defaults and update all 19 `.model(` call sites** — `utilis/model.py:180,228,275`
- [ ] 9. **[HEAV] `utilis/documentparser.py` — the second OpenAI client** — `utilis/documentparser.py:139,867`
- [ ] 10. **[HEAV] Protocol dispatch + one-time capability probe, default `openai_chat`** — `utilis/model.py`, `providers.rs`
- [ ] 11. **[MED] Per-run credential carrier on the existing `threading.local()`** — `api.py:111,216`

### Wave 3 — make the registry authoritative

- [ ] 12. **[MED] Fail fast in Rust when the active provider has no credential** — `src-tauri/src/pipeline.rs`, `gui/src/library/ChatPanel.jsx`
- [ ] 13. **[HEAV] Stop reading env for provider config; precedence test with a conflicting `.env`** — `utilis/model.py`, `utilis/documentparser.py`

### Wave 4 — UI

- [ ] 14. **[HEAV] Settings manages N providers; wire the uncalled `deleteProviderSecret`** — `gui/src/library/SettingsPage.jsx`, `gui/src/main.jsx`, `gui/src/platform/store.js`
- [ ] 15. **[MED] Model selector shows each model's provider** — `gui/src/library/ChatPanel.jsx:459,751-766`, `gui/src/styles.css:1625-1628`
- [ ] 16. **[LIGHT] Seeded `defaultModel` always selectable, keep free-text entry** — `gui/src/library/ChatPanel.jsx`, `SettingsPage.jsx`

### Wave 5 — retire the flat fields

- [ ] 17. **[HEAV] Migrate `settings.provider`/`model`/`endpoint` into the registry, then delete them** — `src-tauri/src/settings.rs`, `providers.rs`. **Gated on Waves 2 and 3 being green via the Wave 0 fixture** — a wrong slot migration orphans every existing key and leaves the app worse than today.

### Wave 6 — run resilience (from the 2026-10-29 audit, `logs/quill-20261029-180619.log`)

Findings audited that evening: turn 2 (`can u rewote 5.2, 4.1, 4.2, 3.1 and 3.2`) ran
**22.4 min** (18:49:53 → 19:12:19) and aborted with **nothing persisted** — 45 LLM calls at
30–60 s each, 2 retryable `APITimeoutError`s, one 4-minute silent stall after
`api chat stream failed`, then `DailyQuotaExceeded` (Groq TPD 197,795/200,000 on
`openai/gpt-oss-20b`) hard-aborting per `utilis/ratelimit.py:212`.

- [ ] 18. **[HEAV] Section checkpointing: persist each completed section as it lands, so a mid-run abort resumes instead of discarding the draft** — `components/writingEngine.py:200-283` (the `writer` loop assembles `blocks` in memory), `components/orchestrator.py:246,500` (the only write to `written:{document_id}` — one `set` at the very end)
- [ ] 19. **[LIGHT] Recovery heartbeat: the 4-minute dead air after `api chat stream failed` must never be unlogged again** — `api.py:752` (the bare `except Exception` → re-route), `utilis/ratelimit.py:218` (backoff waits logged only around, not inside)

## Constraints

- The run path must keep working via the seeded Groq provider at every step. If a wave breaks it,
  that wave is wrong.
- No step may put the API key into the sidecar's spawn environment (D2).
- No step may make the GUI show a provider that the sidecar is not actually using. If precedence
  between registry and env is ever ambiguous, fail loudly rather than defaulting.
- Per-wave, `npm run check` must be green (contrast + 309 JS + rustfmt + clippy + 149 Rust).
- Every new `tests/*.test.mjs` must be registered in `gui/scripts/test-js.sh`.

## Final Verification Wave

- [ ] F1. **[HEAV] `cd gui && npm run check` green** — contrast + 309 JS + rustfmt + clippy + 149 Rust
- [ ] F2. **[HEAV] Fixture proves the configured key is the one sent and the configured protocol the one called** — Wave 0
- [ ] F3. **[HEAV] Precedence test with a conflicting `.env` proves the registry wins** — Task 13
- [ ] F4. **[MED] Missing credential fails before any request is made** — Task 12
- [ ] F5. **[HEAV] Manual end-to-end: seed from `.env`, run one thesis, confirm events stream and closing counts** — searxng is up (`quill-searxng` on `127.0.0.1:8080`, healthy since 2026-10-30); port 8000 is occupied by an unrelated service on this machine (override with `QUILL_API_URL` or use `gui/scripts/dev-sidecar.sh --port 8099`)
- [ ] F6. **[MED] Quota-aborted run resumes from the section checkpoint without re-rendering completed sections** — Task 18, proven by the stub test (raise `DailyQuotaExceeded` after section 2, resume after the cache is re-seeded)

---

## Task 1 — Fake provider HTTP server

**Tier HEAVY** — everything else in this plan is unverifiable without it.

A stdlib `http.server` on port `0` (ephemeral, so it never collides with the unrelated service
holding 8000 on this machine) that records method, path, headers and body, and serves canned
replies for **both** `/v1/chat/completions` and `/v1/responses`. It must be able to assert:
the exact key that arrived, which path was called, and that a body never reached the network.

One fixture covers D2 (key location), D1a (protocol selection) and the retry-on-404 behaviour
(`QUILL_RETRIES=5` turns a capability mismatch into five identical slow failures).

### Verify
- A request the fixture did not receive makes the assertion fail — otherwise it proves nothing.
- Both protocol paths return distinguishable shapes so a test can tell them apart.

### Constraints
- No new dependency. No network. No fixed port.
- If a test file is added under `gui/tests/`, register it in `gui/scripts/test-js.sh` **in the same
  change** — `check-test-lists.mjs` fails the build otherwise.

## Task 2 — Fixture self-test

**Tier LIGHT**

Deliberately assert the fixture catches a wrong expectation. A mock that cannot fail is worse
than no mock, because it converts an untested claim into a green one.

### Verify
- Point the fixture at an assertion for a request it never received; the test must fail.

## Task 3 — Migration `0004_providers.sql`

**Tier HEAVY**

New table `providers(id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', vendor TEXT NOT NULL
DEFAULT 'compatible', protocol TEXT NOT NULL DEFAULT 'openai_chat', base_url TEXT NOT NULL DEFAULT
'', default_model TEXT NOT NULL DEFAULT '', models TEXT NOT NULL DEFAULT '[]', is_active INTEGER
NOT NULL DEFAULT 0)`.

Every text column gets an explicit `NOT NULL DEFAULT ''`. `settings.rs:11-18` documents the exact
failure this avoids: a shape change without per-field defaults makes serde reject or silently
discard what an older build wrote.

Add `src-tauri/src/providers.rs` with CRUD, plus `list_providers` / `upsert_provider` /
`delete_provider` / `set_active_provider` commands registered in `lib.rs`.

### Verify
- `cargo test`: migration applies on an empty db and on one carrying existing `settings` rows.
- Round-trip a provider with every field populated and with every field empty.

## Task 4 — Keyring slot by provider slug

**Tier HEAVY**

`secrets.rs:18-21` keys the keyring by the provider **display name** — unslugged, and it collides
and orphans on rename. Slot becomes `provider:{id}`.

Migration must read the legacy display-name slots (`"OpenAI"`, `"Anthropic"`, `"Google"`,
`"Custom endpoint"`) and copy the secret to the new slug.

**Do not delete the legacy slot until the new one reads back successfully.** A user whose only
credential is in the old slot has no other copy, and the key is not recoverable if the copy fails.

### Verify
- A secret written under `"OpenAI"` is readable under the seeded provider's slug after migration.
- A failed copy leaves the legacy slot intact.

## Task 5 — Seed the registry from `.env`

**Tier MED** — decision D3.

On first run with an **empty** `providers` table, create one provider from `OPENAI_BASE_URL`,
`OPENAI_API_KEY` and `LLM_MODEL`, **copying the key into the OS keyring**, and mark it active.
Idempotent: must not re-seed once the table is non-empty, or a user who deliberately deleted the
seeded provider gets it back on next launch.

`utilis/model.py:9` `load_dotenv()` still loads `.env` into the sidecar's own environment; that is
fine and expected — Wave 3 removes the *provider* reads, not the operational ones.

### Verify
- Empty table + `.env` present → exactly one provider, `has_credential` true, `default_model` = `LLM_MODEL`.
- Non-empty table → no seeding occurs.
- `.env` absent → no provider created, no error, app still opens.

## Task 6 — Rust resolves the credential per request

**Tier HEAVY** — decision D2.

`api_start_run` looks up the active provider, reads the keyring **before** POSTing, and extends
the body with `provider_id`, `vendor`, `protocol`, `base_url`, `model`, `api_key`.

The key travels in the request body. Record the residual exposure honestly in a comment: it is
process memory for the run's duration either way, and the body could reach an access log. The
binding was narrowed to loopback (done this session), which is the control that actually mattered.

### Verify
- Fixture (Task 1) asserts the key in the body equals the keyring key.
- No key appears anywhere in the sidecar's environment.

## Task 7 — `api.py` accepts provider config

**Tier HEAVY**

Parse the new fields into `Run`. An unknown `protocol` must be a reasoned `400`, not a silent
default — defaulting is how a provider ends up "working" while talking to the wrong endpoint.

### Verify
- Unknown protocol → `400` with the protocol named in the reason.
- A run created with an explicit `document_id` and no provider fields behaves exactly as today.

## Task 8 — `utilis/model.py` takes config, not env

**Tier HEAVY** — this is where Momus R2 is actually fixed.

`Agent.__init__` gains explicit `base_url` / `api_key` / `protocol` / `model_name` parameters.

**Change the three import-time defaults at `:180`, `:228`, `:275` from
`os.environ.get("LLM_MODEL", ...)` to `None`, and raise on `None`.** Then update all **19**
`.model(` call sites. Leaving the defaults in place means 18 call sites keep silently reading env
and the registry is decorative.

The repo already states the rule at `utilis/coverage.py:118-124`: *"Env value read at CALL time,
never at import time. Import-time capture is how a stale flag survives an operator turning it off."*

### Verify
- A run with a configured model uses it.
- Constructing `Agent()` with no credential raises rather than falling back to env.

## Task 9 — `utilis/documentparser.py`, the second client

**Tier HEAVY** — Momus R1. Skipping this leaves D3's central claim false.

`utilis/documentparser.py:139` builds a second `OpenAI()` from the same env vars and calls
`chat.completions.create` at `:867`. It must take the same registry config.

### Verify
- Parsing a document under a configured provider uses that provider.
- With no provider configured, parsing fails loudly instead of quietly using env.

## Task 10 — Protocol dispatch and capability probe

**Tier HEAVY** — decision D1a.

`protocol` selects the call shape: `openai_chat` → `chat.completions.create`, `openai_responses` →
`responses.create`, plus vendor-native shapes for Anthropic and Google.

**No silent fallback chain as the primary design.** It doubles latency on the failure path and
hides misconfiguration behind eventual success. Instead, "Connect" performs a **one-time
capability probe** and records the discovered `protocol` on the provider, so runs never re-probe.

### Verify
- A provider with `protocol: openai_chat` hits `/v1/chat/completions` and not `/v1/responses`.
- A `/responses` 404 does not get retried five times.

## Task 11 — Per-run credential carrier

**Tier MED** — Momus R4.

`api.py:368` spawns a daemon thread per `POST /runs` with no single-flight guard, and
`RUNS` is a shared dict. Credentials must ride a **per-run** carrier, never a module global, or
two concurrent runs on different providers interleave keys.

`api.py:111` already has `_CURRENT = threading.local()` carrying per-run state (set at `:216`).
Extend it rather than inventing a mechanism.

### Verify
- Two concurrent runs with different providers each send their own key.
- Repeated runs on one provider are unaffected by the neighbour.

## Task 12 — Fail fast on a missing credential

**Tier MED** — Momus R8.

`api_start_run` returns `202`, so a credential discovered missing in Python surfaces minutes
later as a generic failure. Rust checks `has_credential` **before** POSTing and returns a specific
error the UI renders next to the provider selector.

### Verify
- No provider configured → the run does not start, and the message names the missing credential.
- Nothing is sent to the sidecar.

## Task 13 — Stop reading env for provider config

**Tier HEAVY** — the point of the whole plan.

`.env` seeds once (Task 5) and is then ignored for base URL, key and model. Rate-limit and
searxng env stay (D3).

### Verify — the single most important test in this plan
With `.env` holding a **different** `OPENAI_API_KEY` than the seeded provider, the outbound
request carries the **keyring** key. This is the test that would have caught R2, and it is the one
most easily written uselessly — asserting only "a key was sent" passes under both the old and new
implementations.

## Task 14 — Settings manages N providers

**Tier HEAVY**

List / add / edit / delete, with per-provider credential state. Reuse the `.settings-status` pill
convention (`styles.css:1379-1381`) and the existing `settings-row` layout.

Wire `deleteProviderSecret` (`store.js:339-345`, `commands.rs:129-130`) — it currently has **zero
callers**, so a deleted provider's key would linger in the keyring forever.

Switching provider must stop leaving the old keyring secret behind (`SettingsPage.jsx:621-624`
clears only the form field today).

Also fix the stale note at `SettingsPage.jsx:717-720`, which claims the key is never saved.

### Verify
- Add → edit → delete round-trips, and delete removes the keyring secret.
- `tests/settings-controls.test.mjs` still passes (`#provider` must remain a labelled select).

## Task 15 — Model selector shows the provider

**Tier MED**

`modelOptions` (`:459`) becomes `{ model, provider }` drawn from the registry's `models[]`. The
row renders a provider label inside the existing `space-between` flex (`styles.css:1625-1628`).

**Preserve `className="model-name"` and the `.model-trigger` CSS rules** —
`tests/assistant-library.test.mjs:361-378` asserts both.

Per D4 this selector still cannot affect a chat turn, so label it as governing the next run
rather than presenting it as a live chat control.

### Verify
- Each row shows its provider.
- `npm run check` green, including the assistant-library assertions.

## Task 16 — Seeded `defaultModel` always selectable

**Tier LIGHT**

The env-seeded model (e.g. `openai/gpt-oss-20b`) is in no hardcoded provider list, so the UI must
always offer `defaultModel` even when absent from `models[]`. Keep the free-text model input so a
model not in the list is still reachable.

### Verify
- A provider whose `default_model` is absent from `models[]` still selects and runs it.

## Task 17 — Migrate then delete the flat settings fields

**Tier HEAVY** — gated. **Do not start until Waves 2 and 3 are green via the Task 1 fixture.**

Carry `settings.provider` / `model` / `endpoint` into the registry, then remove the fields. Keeping
them in sync means two sources of truth with no enforced invariant, while `SettingsPage.jsx` still
writes `provider`.

The case that must not be dropped: a user who set `settings.endpoint` to their own vLLM instance
has that value **only** in `settings.endpoint`, and any credential they saved sits in the slot
literally named `"Custom endpoint"`. Migration must **construct** a provider from that orphan
endpoint and look the key up under `"Custom endpoint"` — not under a slugified guess.

### Verify
- A user with only flat settings and an `"OpenAI"` key ends up with a working provider.
- A user with an unmatched custom endpoint keeps a working provider, not a discarded one.
- A run started before the change still completes after it.

## Task 18 — Section checkpointing (Wave 6)

**Tier HEAVY** — the audited run wrote 42 section calls over both turns and lost everything on
the quota abort.

Today nothing survives a mid-run abort. `WritingEngine.writer`
(`components/writingEngine.py:200`) iterates the outline nodes and appends rendered blocks to an
in-memory `blocks` list (`:228-252`); the completed document exists only after the loop, when
`Task.Write` / `Task.ReWrite` hands the finished markdown to `PlagiarismEngine` and the
orchestrator stores it once via `self.database.set(f"written:{document_id}", payload)`
(`components/orchestrator.py:246` fresh draft, `:500` rewrite). A `DailyQuotaExceeded` raised by
`utilis/ratelimit.py:212` partway through the loop discards every section already paid for —
22.4 minutes and ~200k daily tokens in the audited run.

### Design

- After each `_render_section` outcome with `status == "written"`, checkpoint that section into
  the same `SqliteDatabase` the orchestrator already uses, keyed
  `written:{document_id}:sections` — a dict keyed by `self._normalise(title)` holding
  `{title, level, claim, block, digest, outcome}`. The store already exists (it holds
  `written:{document_id}` / `research:{document_id}` today, and `api.py:368`'s cleanup already
  deletes `written:`-prefixed keys), so this adds no new storage mechanism.
- On entering `writer()` for the same `document_id` again, seed `blocks`, `outcomes`, `digests`
  and `seen_claims` from the checkpoint **only for nodes still present in the current outline**;
  nodes the new plan no longer contains are dropped, new nodes are written fresh. The outline is
  the plan, so this is a compare against `nodes`, not a versioning scheme.
- The orchestrator's final `set` remains the single source of truth for the assembled document.
  On successful completion the per-section checkpoint is a leftover until the existing
  `written:`-prefixed cleanup runs — the orchestrator should delete
  `written:{document_id}:sections` explicitly alongside its final set so a rewrite cannot seed
  from a stale draft.
- `writer()` gets an optional `document_id` parameter (default `""`, checkpointing off).
  `Task.Write` / `Task.ReWrite` pass it — both already hold it. A falsy id means the current
  no-checkpoint behaviour, so every other caller and all existing tests are untouched.

### Verify
- Stub the agent to raise `DailyQuotaExceeded` after the 2nd of 5 sections: a resumed write of
  the same document_id reuses the two completed sections (no re-render, no new LLM call) and
  writes only the remaining three.
- A resumed write with a **different outline** drops stale sections instead of splicing them in.
- The success path deletes the per-section checkpoint; a following rewrite of the same document
  does not splice leftovers from it (i.e. a rewrite rebuilds on purpose).
- `tests/test_writing.py` and `tests/test_chat_routing.py` unchanged and green.

## Task 19 — Recovery heartbeat (Wave 6)

**Tier LIGHT** — diagnostic only, no behaviour change.

The audited gap: `api chat stream failed:ERROR` at **18:57:10**, next log line **19:01:05**
(234.7 s of nothing) while the recovery path re-routed the turn. The stall itself is legitimate
work (re-routing a long turn against a rate-limited 30–60 s-per-call model); what made it
undiagnosable is that nothing logs during it.

### Design
- In `api.py:752`'s recovery path (`except Exception` → retry the turn), log at `WARNING` at most
  every ~30 s of silence: elapsed since the failure and the current stage
  (`_human_stage(name)` at `api.py:223` already names it). Inserted into `_route_chat_turn`'s
  retry loop, not a daemon timer — loguru timestamps every line anyway, so the rule the audit
  implies is simply "no more than ~30 s without a line in a recovery path".
- In `utilis/ratelimit.py`, when the backoff before a retry exceeds ~20 s, log one line with the
  reason and wait length (`[ratelimit] retryable APITimeoutError ... backing off 0.8s` exists at
  `:218`; the long waits it *doesn't* log are the quota-wait paths). The two audited
  `attempt 1/5` / `attempt 2/5` lines took 47 s and 46 s of wall time with no in-between signal.
- No new thread, no protocol change, no UI change. Progress events are untouched.

### Verify
- Stub a stream failure on a turn whose recovery takes > 30 s (mock model): at least one
  heartbeat line appears, naming elapsed time and stage, and turn completion behaviour is
  byte-identical to today's.
- An induced 20 s+ backoff produces the wait line with the reason.
- Python harness and `npm run check` green; no new `tests/*.test.mjs` needed.

## Constraints

- The run path must keep working via the seeded Groq provider at every step. If a wave breaks it,
  that wave is wrong.
- No step may put the API key into the sidecar's spawn environment (D2).
- No step may let the GUI show a provider the sidecar is not actually using. Where precedence is
  ambiguous, fail loudly rather than defaulting.
- Per-wave, `npm run check` must be green (contrast + 309 JS + rustfmt + clippy + 149 Rust).
- Every new `tests/*.test.mjs` must be registered in `gui/scripts/test-js.sh`.
