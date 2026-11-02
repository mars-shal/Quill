# SearXNG Search Backend (Quill_New)

Fix the dead web-search layer. The last real run (`logs/quill-20261008-171831.log`) issued
21 searches / 41 HTTP requests, offered 148 hits, had **148 rejected**, ended with `pages == []`,
never called `_fetch` once, and emitted `written=0 placeholder=5`.

- DuckDuckGo served a client-rendered JS shell on 20 of 21 calls (`div.result` matched nothing) — 20.2s wasted.
- Bing RSS answered all 20 topical queries with SEO/brand/porn/portal junk.
- The planning layer is now healthy (entity `Stadio dei Marmi` title-confirmed, anchoring a no-op,
  9 clean queries). The bottleneck is entirely the search backend.

## Rejected candidates (verified — do not revisit)

- **Meilisearch** — a document index over your own data, not a web metasearch. Cannot serve general web search.
- **MiroFish** (`666ghj/MiroFish`) — multi-agent swarm **prediction** engine. Workflow is
  Graph Building → Environment Setup → Simulation → Report Generation → Deep Interaction. A GitHub code
  search for `serpapi|tavily|google_search|bing_search|duckduckgo|SEARX` returns **zero results**;
  `.env.example` has only `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL_NAME`/`ZEP_API_KEY`. Its GraphRAG
  indexes only uploaded seed material. Category error — no query-in/web-results-out path. Its README
  warns "High consumption", the worst latency/cost fit for a per-query path.

## Chosen: SearXNG (self-hosted metasearch, AGPL-3.0, free)

Confirmed API (official docs, `docs/dev/search_api.rst`, `searx/webutils.py`):
`GET {base}/search?q=..&format=json` → `{"query","results","answers","corrections","infoboxes","suggestions","unresponsive_engines"}`.
Each result serializes via `Result.as_dict()` → `url`, `title`, `content`, `engine`, `score`, `category`.
**`format=json` MUST be enabled in the instance's `settings.yml` under `search.formats`, else HTTP 403.**
Many public instances have it disabled — self-host.

## Momus review: REJECTED, three blockers folded into this plan

1. **`_http_get` cannot carry the request.** `researchEngine.py:763-771` hardcodes
   `Accept: "text/html,application/rss+xml"` and `timeout=12`, no params. A SearXNG fanout can exceed 12s
   → raises into `except Exception: return []`, reproducing the blind failure.
2. **Fail-soft logs nothing.** `unresponsive_engines` at DEBUG only exists on the success path; the real
   failure modes (403/timeout/refused) are the same silent shape as today's `_ddg`.
3. **Planned tests would never run.** Repo has **no pytest**: 0 in `site-packages`, 0 in `uv.lock`,
   **0 `def test_` across all four suites**. Suites are `chk()`/`RESULTS` scripts. And stubbing
   `_http_get` would never assert the request contract — forgetting `format=json` yields exactly the 403
   and zero tests would fail.

## Decisions settled by Momus

- **Precedence:** keep `_searxng or _ddg or _bing`. The scrapers are the fallback for the 403 case. Do not suppress.
- **Config:** call-time env var. Do **not** add a constructor kwarg (two sources of truth). Precedent `researchEngine.py:946`.
- **No pagination.** The binding ceiling is `pages_per_query=3` (`:149`), consumed as `hits[:3]` (`:657`) — only 3 of 8 hits are ever fetched. Pagination multiplies latency to feed discarded hits. The 8-cap still widens the pool `_filter_hits` selects its top 3 from (`:591-646`). Raise `pages_per_query` later if recall is short — zero extra HTTP.
- **`categories=general`** explicitly (deterministic across instances), configurable via `QUILL_SEARXNG_CATEGORIES`, default `general`. No hardcoded research bias.

## Environment facts

Docker 29.8.1, daemon running. Podman 3.4.4. 30GiB RAM (9.0GiB avail), 12 cores i7-9850H. `/` at 90% (11G free).
Quill pins **Python 3.14**; SearXNG `setup.py` declares `python_requires=">=3.10"`, classifiers to 3.13 —
unsupported (not forbidden) on 3.14. **Do not install SearXNG into Quill's venv** — use Docker, or a separate
`uv venv --python 3.12`.

## HARD PRECONDITION — protect user evidence

The repo's `output/` currently holds the Oct-8 run artifacts (`Desimation-of-the-Stadium-of-Rome.*`) which are
the evidence for the forensic review. **Any end-to-end run overwrites them.** Before any e2e run, snapshot
`output/` to a timestamped directory and record the path in the ledger. Never delete the originals.

## Out of scope — separate increments, do NOT bundle

- `atlas` empty-return swallowed silently by `_normalise_plan` → `_default_outline` with no log line.
- Human questionnaire answer `maximus` overriding title-confirmed entity `Stadio dei Marmi`.
- `_filter_hits` scoring snippets before `_fetch`, so snippet quality caps recall.
- No token accounting anywhere in the system.

---

## TODOs

### Wave 1 — independent lanes, no file overlap

- [x] 1. **[HEAV] SearXNG provider + shared-fetcher contract + tests** (Wave 1, lane A) — `components/researchEngine.py`, `tests/test_searxng.py`
- [x] 2. **[LIGHT] Config + deployment docs** (Wave 1, lane B) — `.env.example`, `docs/searxng.md`

### Wave 2 — gated on Wave 1

- [x] 3. **[HEAV] Regression gate: full suite + `_http_get` backward-compat** — read-only verification
- [x] 4. **[HEAV] Live Docker gate: RSS, latency, hit quality, `_fetch` reachability** — Docker resource, cleanup required

## Final Verification Wave

- [x] F1. **[HEAV] Adversarial verification of the increment** — independent verifier, `confirmed` verdict required

---

## Task 1.1 — SearXNG provider, fetcher contract, tests

**Tier HEAVY** — external integration + shared-path refactor (`_http_get` is used by `_fetch`, `_ddg`, `_bing`).

Files: `components/researchEngine.py`, `tests/test_searxng.py` (new).

### 1.1a Baseline characterization test (must pass on UNCHANGED code)

Before touching `_http_get`, pin its current observable behavior in `tests/test_searxng.py`:
default `Accept` header is exactly `text/html,application/rss+xml`; default timeout is 12; URL must be
`http(s)://` or it raises `ValueError`; a blocked URL raises `ValueError` (`utilis/safety.is_blocked_url`);
`_fetch` returns `""` on exception. Construct via `ResearchEngine.__new__(ResearchEngine)` —
`__init__` at `:156-158` spins up `Agent()`/`Embedder.get()`/`SqliteDatabase()`.
Precedent for driving `_http_get` directly: `tests/test_safety.py:59-62`.

### 1.1b Failing-first proof

`chk("searxng provider exists", hasattr(ResearchEngine, "_searxng"))` — fails now, must pass after 1.1c.

### 1.1c `_http_get` contract fix

Add keyword-only `timeout: float = 12` and `headers: dict | None = None`. Default preserves every existing
caller. Override headers to add/merge `Accept`. Still ONE http path.

### 1.1d `_searxng`

`@timed("ResearchEngine._searxng")`. Base URL `os.environ.get("QUILL_SEARXNG_URL")` read **at call time**;
return `[]` immediately if unset. `QUILL_SEARXNG_CATEGORIES` default `"general"`. URL-encode the query.
Call `self._http_get(url, timeout=30, headers=...)` with `Accept: application/json`.
Map `results` → `{"title","url","snippet"}` with `snippet` from `content`, so `_filter_hits`/`_fetch` are
UNCHANGED. Skip entries missing a usable `url` or `title`. Cap `hits[:8]`.
Log `unresponsive_engines` count at DEBUG. On exception:
`logger.warning("searxng failed: %s: %s", type(exc).__name__, exc)` then `return []` — fail-soft stays, visibility added.

### 1.1e `search()` precedence

`self._searxng(query) or self._ddg(query) or self._bing(query)`. Scrapers retained as the 403 fallback.

### 1.1f Tests — `chk`/`RESULTS` script, NOT pytest

Convention: `RESULTS` list (`tests/test_regressions.py:24`), `chk()` (`:27`), `main() -> int` (`:175`),
run `PYTHONPATH=$PWD .venv/bin/python tests/test_searxng.py`. Must cover:
- **Request contract (blocker 3):** `format=json` present, `q` percent-encoded, base-URL join correct, `content`→`snippet` mapping.
- Mapping correctness; cap at 8; skip missing `url`/`title`.
- `[]` on: empty `results`, 403, malformed JSON, raised exception, unset `QUILL_SEARXNG_URL`.
- `search()` fallback ordering, both tiers.
- Baseline 1.1a assertions still hold (backward compat).

### Constraints

- No `as any`, no `# type: ignore`, no empty `except: pass`.
- Comments required on non-obvious decisions (repo convention — every non-trivial branch in this repo carries a justification comment).
- Do NOT touch: `_filter_hits`, `assess`, `fetch`, `_crawl_node`, `planner`, writingEngine, grounding.

### Verify

`PYTHONPATH=$PWD .venv/bin/python tests/test_searxng.py` → exit 0.
`PYTHONPATH=$PWD .venv/bin/python tests/test_safety.py && ... test_writing.py && ... test_plagiarism.py && ... test_regressions.py` → exit 0.

### Manual-QA channel

Real surface, live:
`curl -i -s "http://localhost:8080/search?q=Stadio%20dei%20Marmi%20Rome&format=json"` → PASS iff HTTP 200 and body
parses as JSON containing a non-empty `results` array. Capture the response to `artifacts/1.1/curl-searxng.json`.

### Adversarial classes

- **malformed input** (new input parsing): feed truncated JSON, `results` as a dict not a list, a result whose
  `url` is `javascript:` or empty, non-ASCII query → all must yield `[]` or be skipped, never raise.
- **misleading success output**: assert on parsed hit COUNT and field values, not on HTTP 200 or log text.
- **flaky tests**: no network in tests at all — every case stubs `_http_get`.
- **stale state**: unset/re-set `QUILL_SEARXNG_URL` via `os.environ` and confirm call-time read (not import-time).
- **prompt injection**: a SearXNG result `title`/`snippet` containing adversarial instructions must be treated
  as data — `_filter_hits` already embeds snippets; confirm no instruction-following path is introduced.
- **hung/long commands**: 30s timeout must actually bound a hung instance.
- Not-applicable, with reason: cancel/resume (no resumable flow), dirty worktree (only 2 files touched, both tracked),
  repeated interruption (single-shot edit).

### Artifacts + cleanup

`artifacts/1.1/` — curl JSON, suite output, baseline-vs-after diff of `_http_get` signature.
Cleanup: none spawned (no containers/ports in this lane).

---

## Task 1.2 — Config + deployment docs

**Tier LIGHT** — one small config file plus one new doc. Zero overlap with Task 1.1.

Files: `.env.example`, `docs/searxng.md` (new).

- `.env.example`: add `QUILL_SEARXNG_URL` and `QUILL_SEARXNG_CATEGORIES` in the existing `QUILL_*` block,
  with a comment that `search.formats` must include `json` in the instance's `settings.yml` or the API returns 403.
- `docs/searxng.md`: the Docker default; the exact `settings.yml` edit enabling `json`; **and a compose sidecar
  snippet** (`api` + `searxng` on one network, `depends_on: condition: service_healthy`, settings volume mounted)
  because the user asked about bundling as an API sidecar later. Note that config is a URL, so sidecar-ing is
  config-only (`http://localhost:8080` today → `http://searxng:8080` later, zero code change). Note the K8s
  pod-sidecar variant (`127.0.0.1:8080`). Note AGPL-3.0: unmodified sidecar is fine; AGPL network clause bites on
  modified versions offered as a service.

### Verify

`grep -n QUILL_SEARXNG .env.example` shows both vars; the doc renders the compose YAML.
Manual-QA: `docker run --rm searxng/searxng:latest --version` boots (proves the documented image tag exists).

### Adversarial classes

- **malformed input**: the documented `settings.yml` snippet must be valid YAML — parse it (`python -c "import yaml,sys;yaml.safe_load(open(...))"`).
- **stale state**: doc names an image tag that must be verified to exist, not assumed.
- Not-applicable with reason: prompt injection, flaky tests, cancel/resume, dirty worktree, hung commands (bounded pulls), repeated interruption.

### Artifacts + cleanup

`artifacts/1.2/`. Cleanup: the `--rm` container self-cleans; confirm no leftover container.

---

## Task 2.1 — Regression gate

**Tier HEAVY.** Read-only. Confirms the 113 baseline survives shared-path surgery.

Run all four existing suites plus the new one. Baseline: test_safety 34, test_writing 18,
test_plagiarism 10, test_regressions 51 = **113/113**. New suite must pass too.
Explicitly prove `_http_get` backward compatibility: `_ddg`, `_bing`, `_fetch` all still function with default args.
Also confirm `lsp_diagnostics`/import cleanliness on `components/researchEngine.py`.

Manual-QA: run one `_ddg` and one `_bing` call against the real network through the modified `_http_get` and
confirm they still return the same shape as baseline (they may return junk — the point is the call path is intact).
Artifact: `artifacts/2.1/suite-output.txt`.

Adversarial: **misleading success output** — compare per-suite check COUNTS against baseline, not just exit 0.
**dirty worktree** — confirm `git status` shows only the intended files.

---

## Task 2.2 — Live Docker gate

**Tier HEAVY.** Proves the backend actually returns usable results and that `_fetch` becomes reachable.

1. Snapshot `output/` → timestamped dir. Record path. (HARD PRECONDITION)
2. `docker run -d --name quill-searxng -p 8080:8080 searxng/searxng:latest`
3. Edit `settings.yml` to set `search.formats: [html, json]`, restart, wait for healthy.
4. `curl -i -s "http://localhost:8080/search?q=Stadio%20dei%20Marmi%20demolition%201968&format=json"`
5. Assert PASS thresholds: **≥6 of 8 hits**, **≥5 non-empty snippets**, **≥3 topically-recognised domains**.
   FAIL if 0 hits (→ check `search.formats`, then `unresponsive_engines` in the log) or ≥3 porn/portal/SEO URLs.
6. Call `ResearchEngine.__new__(...)._searxng(...)` live; assert non-empty and log `unresponsive_engines`.
7. **Measure** container RSS (`docker stats --no-stream`) and per-query latency — record both, to inform
   low-end deployment. Recommend an engine-list trim if RSS is high.
8. End-to-end: one full pipeline run. Assert in the log: `ResearchEngine._fetch` calls **> 0**, `pages` **> 0**,
   `written` **> 0**. Baseline to beat: `_fetch`=0, `written=0 placeholder=5`.

Artifacts: `artifacts/2.2/` — curl JSON, `docker stats`, latency samples, e2e log extract, RSS.
Cleanup (MANDATORY): `docker rm -f quill-searxng`, confirm `docker ps -a` shows no leftover, record receipt.

Adversarial: **hung/long commands** — SearXNG cold start and the e2e run are both long; bound both, and never
treat a timeout as a pass. **stale state** — confirm `settings.yml` edit actually took effect (a stale mount
silently 403s). **misleading success output** — assert parsed result counts, not container "Up" status.
**repeated interruption** — if the e2e run is interrupted, the `output/` snapshot must still be intact.

---

## Task 3.1 — Adversarial verification

Independent verifier, different context from the implementer. Produces the `AdversarialVerify` block.
Verdict must be `confirmed`; `false-positive`/`needs-fix`/`needs-human-review` all block.

Probes: `stale_state`, `dirty_worktree`, `misleading_success_output`, plus re-checks that `_ddg`/`_bing`/`_fetch`
were not regressed and that no out-of-scope defect got bundled.

---

## Definition of done

- [ ] `tests/test_searxng.py` passes; 113 baseline preserved; total suite green.
- [ ] `_searxng` returns real results against a live instance; ≥6/8 hits, ≥5 snippets, ≥3 relevant domains.
- [ ] `ResearchEngine._fetch` calls > 0 in an end-to-end run; `written` > 0.
- [ ] No Docker container, port, or temp dir left running.
- [ ] `output/` originals preserved.
- [ ] Adversarial verdict `confirmed`.