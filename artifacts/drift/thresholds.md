# Drift check thresholds — every number justified by a measured value

Source corpora (read-only, never modified):

| | failing run | healthy run |
|---|---|---|
| document | `output/Desimation-of-the-Stadium-of-Rome.md` | `output/Demolition-of-the-Stadio-Dei-Marmi-in-Rome.md` |
| corpus | `output/Desimation-of-the-Stadium-of-Rome.research.md` (270,426 chars) | `output/Demolition-of-the-Stadio-Dei-Marmi-in-Rome.research.md` (282,243 chars) |
| log | `logs/quill-20261010-160443.log` | — |
| concept | `The demolition of the stadium in Rome` | `Demolition of Stadio dei Marmi in Rome in 1968` |
| prompt | `Hey Can you Write a new thieasis for me about The desimation of the stadium of Rome` | `write a thesis about the demolition of the Stadio dei Marmi in Rome in 1968` |
| outcome | 10 of 19 sections `⚠ INSUFFICIENT EVIDENCE`; research gate passed at `quality=0.699 relevant_pages=50` | 12 written / 3 placeholders |
| years in concept or prompt | **none** | 1968 only |

Reproduce everything below with:

```
PYTHONPATH=$PWD .venv/bin/python /tmp/opencode/manual_qa.py > artifacts/drift/manual-qa.txt 2>&1
```

---

## `WINDOW_YEARS = 2` (a 5-year window)

The failing corpus is a *recent-news* cluster, not a single year: 2024 = 60
mentions, 2025 = 154, 2026 = 71. Any window narrower than 5 years would miss the
shoulders of that cluster and report a share that depends on arbitrary bucket
edges. Any window wider would start merging the failing corpus's genuinely
unrelated neighbours (2018 = 44, 2021 = 22) into the dominant band and inflate
every corpus's share.

Measured on the healthy corpus, the same 5-year window gives **0.263**
(1928-1932, 239 of 908 mentions). Widening to a decade band would push the
healthy figure up toward the failing one and destroy the separation, which is
why this stays narrow.

## `MIN_WINDOW_SHARE = 0.33`

| corpus | best 5-year window | mentions | share |
|---|---|---|---|
| failing | 2022-2026 | 309 / 700 | **0.441** |
| healthy | 1928-1932 | 239 / 908 | **0.263** |

`0.33` sits above the healthy 0.263 and below the failing 0.441. Margins:
**+0.111** on the side that must fire, **0.067** on the side that must stay
quiet.

Rejected alternatives, with the measurement that rejected them:

- **0.44** (just under the failing value) — healthy margin becomes 0.177, but
  the failing margin collapses to 0.001. Any corpus slightly less concentrated
  than this one goes silent, which is the failure mode this gate exists to
  catch.
- **0.30** — healthy margin 0.037. The healthy run's second-widest decade band
  (2020s, 120/908 = 0.132) is far below it, but 0.037 is inside the noise of
  an unseen third run.
- **Naive top-3-years** (no window) — failing 0.407, healthy 0.320. Separation
  shrinks to 0.087 **and** the metric is no longer "a period", it is "the three
  most common numbers in a list", which would fire on any corpus with three
  popular years regardless of whether they are adjacent.

A spread of years never fires. The healthy corpus spans 1000-2026 (73 distinct
years) and stays quiet at 0.263. The synthetic spread in `tests/test_drift.py`
(10 years x 40 mentions, all distinct) stays quiet at 0.091.

## `MIN_WINDOW_MENTIONS = 30`

0.33 of six mentions is two mentions; a five-page corpus must not be able to
produce a temporal verdict. The failing corpus has 309 inside the window, so a
floor of 30 costs nothing there and is verified in the suite at 29 (silent) and
30 (fires).

## Temporal fires only when the window is absent from the request

Both the concept and the prompt are scanned for years. If **any** year inside
the dominant window appears in either, the check stands down. Measured:
adding `2025` to the prompt or the concept disarms the failing corpus; adding
`1901` (present in the corpus, outside the dominant window) does not.

A year *outside* the window must not disarm the check — the healthy request
names 1968 and the healthy corpus's dominant window is 1928-1932, which is
exactly the shape that would make a naive "any shared year" test useless.

## `MIN_ENTITY_MENTIONS = 8` and `MAX_ENTITY_WORDS = 4`

Entities are mid-sentence capitalised phrases (`utilis/drift._entity_census`).
The census on the failing corpus yields 4,238 phrase mentions over 1,692
distinct keys; on the healthy corpus 5,716 over 1,522. A floor of 8 keeps
one-off proper nouns out of the ranking.

`MAX_ENTITY_WORDS` exists because an uncapped run of capitalised words
collapses: `Rome Rome Rome ...` (137 repeats) was being filed as a single
137-word entity, which destroyed the entire census. Capping at 4 fixes it.

## `TOP_ENTITIES = 5` and `MIN_ALIEN_SHARE = 0.60`

| corpus | alien share (top-5 entities) | head of request entity | head alien | head_advantage |
|---|---|---|---|---|
| failing | **0.699** | `rome` 132 | `stadio flaminio` 99 | **1.333** |
| healthy | **0.487** | `stadio dei marmi` 276 | `foro italico` 232 | **1.190** |

Both conditions must hold to fire entity drift:

1. `alien_share >= 0.60` — the corpus's headline names are overwhelmingly
   foreign. 0.60 leaves a **0.113** margin below the healthy 0.487. The first
   value tried, 0.50, left only **0.013** on the healthy run, which is noise;
   it was replaced.
2. `head_advantage < 1.0` — the most frequent off-request entity must outrank
   the most frequent request entity. This is what keeps the check quiet on the
   real failure: the failing corpus names `rome` 132 times, more than any alien
   head, because the wrong corpus genuinely *is* about Roman stadiums. The
   wrongness there is the period, not the place, and the check says so.

Aggregate alien mass on its own does **not** discriminate: 0.699 vs 0.487 is
too close, and the healthy corpus is full of legitimately off-request names
(`Foro Italico`, `Enrico Del Debbio`, `Carrara`). An earlier iteration using
"share of *all* entity mentions" scored 0.928 (failing) vs 0.820 (healthy) —
worse separation, and it fired on nothing useful. Ranking is what carries the
signal, so the share is computed over the top-5 only.

### Entity drift is silent on the real failure, deliberately

`detect_drift` on the failing corpus returns `signal="temporal"` and
`entity.fired=false`. That is the intended verdict, not a gap: the temporal
signal is the one that carries proof (0.441 of year mentions in a period the
request never named, and the true subject year 1968 appears **zero** times —
`grep -c 1968 output/Desimation-of-the-Stadium-of-Rome.research.md` → 0). Loosening
the entity gate until it also fires would mean firing on healthy historical
corpora, and a gate that fires on every healthy run is worse than no gate.

## Behaviour that is deliberately NOT a threshold

- **No verdict when the request names no entity.** The failing run's concept is
  "the demolition of the stadium in Rome", which names `rome`. A concept like
  "it" cannot be shown to have drifted onto an alien subject, so the entity
  half returns `reason="request names no entity, so no alien subject can be
  shown"` rather than firing on every vague request ever made.
- **No hard block anywhere.** `detect_drift` returns a dict; `ResearchEngine.run`
  logs a warning and continues. `assess()` still decides pass/fail, exactly as
  before.
- **No state.** Reads only the corpus handed to it. No database, no cache, no
  network, no LLM. Asserted by the no-cross-call-state-leak and
  returned-dict-is-not-shared-state tests.