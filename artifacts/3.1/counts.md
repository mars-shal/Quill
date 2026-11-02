# Counts: independent regression gate 3.1

Source of truth: `suite-output.txt` (verbatim stdout+stderr of all 5 suites).
Counts are of **literal `PASS ` / `FAIL ` lines**, matched with `(?m)^PASS\s`.

## Per-suite

| suite | expected | PASS lines | FAIL lines | observed total | suite's own summary line | exit | delta | verdict |
|---|---|---|---|---|---|---|---|---|
| `tests/test_safety.py` | 34 | 34 | 0 | 34 | `34/34` | 0 | +0 | OK |
| `tests/test_writing.py` | 18 | 18 | 0 | 18 | `18/18` | 0 | +0 | OK |
| `tests/test_plagiarism.py` | 10 | 10 | 0 | 10 | `10/10` | 0 | +0 | OK |
| `tests/test_regressions.py` | 51 | 51 | 0 | 51 | `51/51` | 0 | +0 | OK |
| `tests/test_searxng.py` | 70 | 70 | 0 | 70 | `70/70` | 0 | +0 | OK |

## Arithmetic

```
legacy baseline   = 34 + 18 + 10 + 51 = 113
observed (legacy) = 34 + 18 + 10 + 51 = 113
new suite         = 70  (expected 70)

EXPECTED TOTAL = 113 + 70 = 183
OBSERVED TOTAL = 113 + 70 = 183
DELTA          = +0
FAIL lines     = 0
```

**No suite is short.** No suite exits 0 while running fewer checks.

## Why exit 0 was not accepted as proof (`misleading_success_output`)

Four independent confirmations that the 183 is real:

1. **Explicit PASS/FAIL line counts**, above - not inferred from exit status.
2. **Every suite really fails loudly.** `test_safety` / `test_plagiarism` end in
   `raise SystemExit(0 if ok == N else 1)` against a **hard-coded N** (34, 10), so a
   deleted check would read `33/34 FAILURES` and exit 1 - it cannot silently shrink.
   `test_writing` / `test_regressions` / `test_searxng` return
   `0 if passed == len(RESULTS) else 1`, and the denominator is **data-derived**, so the
   summary is a live count of executed checks, not a literal.
3. **Determinism.** 3 consecutive full runs produced byte-identical counts
   (34/18/10/51/70 each time). No flakiness, no ordering dependence.
4. **Offline.** `test_safety`, `test_regressions` and `test_searxng` all complete to
   `SystemExit(0)` with `socket.getaddrinfo`, `socket.socket.connect` and
   `socket.create_connection` hard-disabled - so no suite is reading a live or cached
   search result, and no result can differ because a provider was reachable.

## Advisory (not a regression)

`test_searxng.py` derives its denominator from `len(RESULTS)`, so a check deleted from
*that* suite in future would shrink the denominator and still print `ALL PASS`. The
legacy `test_safety` (34) and `test_plagiarism` (10) avoid this by hard-coding the
required count as a literal.
Recommend pinning `test_searxng` to `passed == 70` as a literal, matching the
existing `test_safety` style, so the same deletion becomes loud instead of silent.

## Verdict on counts: **REGRESSION-FREE**

