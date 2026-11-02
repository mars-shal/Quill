# Entity resolver: system prompt before and after

Incident: `logs/quill-20261008-171831.log`. The user typed

    Hey Can you Write a new thieasis for me about The desimation of the stadium of Rome

— no stadium named. The resolver answered `{"entity":"Stadio dei Marmi","ambiguous":false}`,
a marble stadium in **Carrara**, not Rome. All 30 downstream queries anchored on it and the
corpus topped out at `Stadio dei Marmi (Carrara)`.

## The line that caused it

    - Prefer the most famous specific referent.

It orders *invention* above *accuracy*. When the text names nothing, "the most famous
specific referent" is still an instruction to produce one. A class description ("a stadium
in Rome" — Colosseum, Stadio Olimpico, Stadio dei Marmi, Stadio delle Alpi) has no famous
referent, so the rule could only be satisfied by guessing.

It is **deleted**. `tests/test_searxng.py` pins its absence so it cannot be restored.

## Before (466 chars)

```text
You are an entity resolver. Given a research concept, name the
single canonical real-world entity a researcher should search for.

Rules:
- If the concept names a specific place, structure, work, person or thing, give
  its standard proper name only. No explanation, no qualifiers.
- If the concept is genuinely generic with no single referent, repeat it back.
- Prefer the most famous specific referent.

Respond with JSON only:
{"entity": "<CANONICAL NAME>", "ambiguous": <true|false>}
```

Two defects, not one:

1. `- Prefer the most famous specific referent.` — pushes a proper name out of a class
   description. This is the direct cause.
2. `- If the concept is genuinely generic with no single referent, repeat it back.` — the
   safe answer exists, but it is phrased as an afterthought ("genuinely generic") and says
   nothing about `ambiguous`, so the model has no reason to prefer it over a confident guess.

## After (519 chars)

```text
You are an entity resolver. Name the one entity a researcher should search for.

Rules:
- If the text NAMES a specific place, structure, work, person or thing, give its
  standard proper name only. No qualifiers.
- If the text DESCRIBES a class or role, or several distinct entities plausibly
  fit, do NOT invent a proper name: return the class phrase from the text with
  ambiguous=true. That is correct and safe - never guess.

Respond with JSON only:
{"entity": "<NAME OR CLASS PHRASE>", "ambiguous": <true|false>}
```

What changed and why:

| Change | Reason |
|---|---|
| `- Prefer the most famous specific referent.` **removed** | The cause. Nothing tells a 20b model that guessing is the failure mode. |
| `NAMES a specific …` vs `DESCRIBES a class or role` | Two explicit, mutually exclusive branches instead of three overlapping ones. A small model follows a binary better. |
| `do NOT invent a proper name: return the class phrase from the text` | Says what to return *and* where to take it from, so the safe branch has a concrete output. |
| `with ambiguous=true` | The old safe branch left `ambiguous` unset, so a class phrase and a real name looked identical downstream. |
| `That is correct and safe - never guess.` | Removes the obligation to guess. Without it the model treats abstaining as failure. |
| `or several distinct entities plausibly fit` | "Several real candidates" is case (b) by definition, stated so. |
| Placeholder `"<NAME OR CLASS PHRASE>"` | The response shape now admits the class phrase. Keys are unchanged — no key was added. |

## Length

519 chars vs 466. **+53 chars (+11%)** — longer than "the same length or shorter" as asked.
The removed 41-char line is more than paid for by the new branch; the extra 94 characters buy
the named/class split, the `ambiguous=true` instruction and the explicit no-guessing licence.
Trimming further would have meant dropping "from the text" (the model would start *paraphrasing*
class phrases instead of quoting them, reintroducing the same failure one level down) or dropping
the never-guess sentence (which is the part that makes the safe branch attractive). 519 chars is
9 lines for `openai/gpt-oss-20b`. The budget is pinned in the suite (`466 <= len(prompt) <= 520`)
so a future edit that balloons it fails loudly.

## Behaviour change, not just wording

The prompt alone cannot be trusted to stop invention, so a second, independent guard exists in
`_resolve_entity`: when an entity occurs in **neither** the user's prompt nor the concept, and a
non-empty prompt was supplied, the run reaches the existing FALLBACK path and keeps the concept.
The confirming search cannot catch this case — the invented name has its own Wikipedia page, so
search *confirms* it. See `manual-qa.txt` QA 1.
