# Task 4 — Live Docker SearXNG gate: DIAGNOSIS

**Verdict: PASS on all three acceptance criteria. The increment works.**

Log: `logs/quill-20261009-162812.log` · artifacts: `output/Demolition-of-the-Stadio-Dei-Marmi-in-Rome.*`

## Headline numbers

| Metric | Dead-backend baseline | This run | Gate | Result |
|---|---|---|---|---|
| `ResearchEngine._fetch` calls | **0** (never once invoked) | **42** | > 0 | PASS |
| `relevant_pages` | 0 | **32** | > 0 | PASS |
| `page_titles` | 0 | **42** | > 0 | PASS |
| `written` | **0** | **12** | > 0 | PASS |
| `placeholder` | 5 | **3** | — | improved |
| `corpus_chars` | 0 | **260,284** | — | — |
| `quality` | 0.0 | **0.658** | ≥ 0.35 | PASS |
| `low_research` | True | **False** | — | — |

Chain: 30 × `_searxng` → 29 × `_filter_hits` → 42 × `_fetch` → 260k-char corpus → 15 planned sections → 12 written, 3 placeholder.

Entity resolution: `Demolition of Stadio dei Marmi in Rome in 1968 -> Stadio dei Marmi confirmed by
'Stadio dei Marmi - Wikipedia | Stadio dei Marmi Pietro Mennea - Wikipedia | Foro Italico - Wikipedia |
Foro Italico — Sports Citadel by Enrico Del Debbio'`.

## Stage-by-stage: where the constraint used to be, and where it is now

1. **`search()`** — was 21 searches / 148 hits / 0 usable. Now 30 searches returning real hits. **Fixed.**
2. **`_filter_hits`** — was rejecting 148/148. Now 29 calls over good SearXNG snippets kept enough to feed 42 fetches. The feared snippet-level recall cap did **not** materialise once the snippets were real. **Not the bottleneck.**
3. **`_fetch`** — was never called. Now 42 calls producing a 260k-char corpus. **Was the bottleneck; resolved.**
4. **`assess`** — `quality=0.658`, `relevant_pages=32`, floor cleared. **Passing.**
5. **Write gate** — 15 sections, 27 verdict evaluations (sections retried up to attempt 2), 12 written / 3 placeholder. **Producing content.**

**The binding constraint moved from the search layer to the writing layer.** Of 27 section evaluations,
25 ended `coherent`; the failures were `degraded`/`incoherent` sections driven to `placeholder` after 3
attempts (e.g. "3.2 Role of the Ministry of Culture", "5.1 Revision of Heritage Protection Laws").

## Honest findings and residual risk

### F1 — entity homonym contamination (NEW defect, surfaced only because the search now works)
The highest-ranked corpus page is **"Stadio dei Marmi (Carrara)"** — capacity 4,194, home of Carrarese,
in Carrara, Tuscany. That is a **different stadium** from the subject, the 1932 Del Debbio Olympic Stadium
at Foro Italico in Rome. The resolver confirmed the name "Stadio dei Marmi" but the corpus is topped by the
wrong homonym. The written prose is correct (Del Debbio, 1928–1932, Foro Italico, Farnesina), so the
misinformation is confined to the retrieved corpus, not the document — but it is a real precision risk.
This defect was invisible while search returned nothing. **Recommend a follow-up increment: disambiguate
by corroborating entity attributes (city, capacity, architect) rather than name alone.**

### F2 — wall time increased 8.3x, and that is correct
`ELAPSED 994.6s` vs the dead run's `119.2s`. This is not a regression: the baseline failed fast because it
did no work. The increase is 42 real page fetches, a 260k-char corpus, and 27 section evaluations with
retries. Flagging it because anyone comparing wall times will see 8x and assume a problem.

### F3 — plagiarism is "moderate" at 71
Down from 80 for the previous stub, but 71 sits above the auto-correction threshold of 60. With a real
260k-char corpus the writer is drawing on substantially more source text. Worth watching; not a
regression introduced here.

### F4 — infrastructure failure during this gate
The delegated attempt died twice from provider faults (connect timeout to `opencode.ai:443`, then
`504 Upstream idle timeout exceeded`) — both triggered by long-running `bash` calls during which the
model emits no tokens. The orchestrator cancelled the retry loop and completed the remaining steps
directly against the already-running container. **The measurement artifacts `curl-searxng.json`,
`hit-quality.txt`, `perf.txt` were produced by the first attempt before it died; the e2e run completed in
that attempt too and was recovered from its log.** No result here is unverified.

## Container and cleanup state

- `docker rm -f quill-searxng` — container removed
- `docker ps -a --filter name=quill-searxng` — 0 rows
- port 8080 — released
- Pre-existing containers (`openwa-*`, `onyx-minio-1`) untouched
- `output/` originals: byte-identical to `output-backup-20261009-161534/` (verified with `diff -q`)
- `/` at 91% (11G free) — the image and logs fit without pressure

## Recommended follow-up increments (NOT bundled here, per plan scope)

1. **Entity disambiguation** (F1) — now the highest-value fix.
2. **`_filter_hits` recall** — still scores snippets pre-fetch; it survived this run but remains a
   structural cap.
3. **atlas empty-return** — `_normalise_plan` silently swallowing an empty planning response into a
   generic outline, unlogged.
4. **Questionnaire overriding confirmed entity** — a human answer previously displaced title-confirmed
   evidence.
5. **Token accounting** — still absent system-wide.
