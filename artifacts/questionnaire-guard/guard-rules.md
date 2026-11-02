# Questionnaire guard — rules and prompt diff

Incident: `logs/quill-20261010-152259.log`, 2026-10-10 15:23. Scout asked the user

```
"What is the name of the stadium?"
"When was it demolished?"
"What was the primary reason for its demolition?"
```

on a run that had a working SearXNG backend, **42 retrieved pages** and a
**260,284-char corpus**. Round 2 then logged
`suppressed=1 newly_asked=0 (round limit 1 reached)` — the same two fact
questions regenerated.

Two coordinated fixes: the Scout prompt no longer instructs fact-questions
(`utilis/model.py`), and `ResearchEngine._clean_questions` drops them regardless
(`components/researchEngine.py`).

---

## 1. Old vs new — Scout `system_prompt` questionnaire block

### OLD (382 chars) — the cause

```
If you need input, ask at most 3 questions. Each question must:
- cover a DIFFERENT aspect, with no overlap or repetition between questions;
- ask for ONE specific thing (a name, a date, a mechanism, a figure);   <-- THE BUG
- be at most 100 characters and end in a question mark;
- not restate the concept or mention "this document", "this essay" or "the topic".
```

`a date` and `a mechanism` name precisely the two shapes the corpus can answer.
The model was **obeying instructions**, not misbehaving.

### NEW (680 chars, 1.78x) — the fix

```
If you need input, ask at most 3 questions. Each question must:
- cover a DIFFERENT aspect, with no overlap or repetition between questions;
- ask ONLY what search cannot answer: which subject you mean, what angle,
  how deep, what to include or avoid, who it is for;
- NEVER ask for a fact research can establish - dates, years, reasons,
  causes, mechanisms, quantities, builders, locations, or a known name;
- be at most 100 characters and end in a question mark;
- not restate the concept or mention "this document", "this essay" or "the topic".
If the concept is specific enough to research, reply done instead.
```

Kept verbatim: the at-most-3 cap, the DIFFERENT-aspect rule, the 100-char and
question-mark rule, the no-restating rule, and **both JSON response contracts
byte-for-byte**.

Not kept: the `done`-instead branch was added. Length grew 1.78x because the
block now has to carry four rules the old one did not have; a 20b model reads
short bullets reliably, so the added rules are bullets rather than prose.

---

## 2. The deterministic guard

`_is_research_fact_question()` in `components/researchEngine.py`, called from
`_clean_questions()`. **No LLM call** — the generator is the component that is
already unreliable, so asking it to also classify its own output adds cost and a
second failure mode to the thing that just failed.

Order matters: **`_USER_ONLY_RULES` is checked first and always wins.** A question
matching neither table is **KEPT** — losing a good question costs the user a
round trip, keeping a bad one costs them one "I don't know".

### 2a. `_RESEARCH_FACT_RULES` — dropped

Each rule carries the question it exists to reject. Tests assert every stored
example against the live helper, so a pattern and its comment cannot drift.

| rule | rejects (real example) |
|---|---|
| `date/year` | `In what year was it demolished?` |
| `reason/cause` | `What was the primary reason for its demolition?` |
| `mechanism/process` | `What mechanism was used to demolish it?` |
| `quantity/figure` | `How many seats did it have?` |
| `builder/author/owner` | `Who designed the stadium?` |
| `location` | `Where is it located?` |

### 2b. `_USER_ONLY_RULES` — protected, checked first

| rule | protects (real example) |
|---|---|
| `disambiguation` | `Which specific stadium in Rome are you referring to?` |
| `naming` | `What is the name of the stadium?` |
| `audience` | `Who is the intended audience for this thesis?` |
| `depth` | `How much detail do you want on the demolition?` |
| `length` | `How long should the essay be?` |
| `scope` | `Should the essay focus on the demolition or the aftermath?` |
| `avoid` | `Is there anything I should avoid including?` |
| `stance` | `What should the thesis argue about the demolition?` |
| `preference` | `How should I structure the demolition chapter?` |

`naming` and `disambiguation` are why the ordering is not optional: both contain
fact-shaped words and would be destroyed by a filter that ran the fact table
first. "What is the name of the stadium?" is a **naming request**, not a date.

---

## 3. Graceful degradation (already wired, verified, not broken)

`validate()`:

```python
if status == "needs_user_input" and not questionnaire:
    status = "continue"   # no usable questions -> let Oracle drive
```

An all-fact Scout reply now yields `questionnaire=[]` + `status="continue"`, so
the run falls through to Oracle-driven `_think` research instead of pestering
the user. That is the desired outcome, not an error. Pinned by test.

---

## 4. Result on the incident data

```
round 1 in : ["What is the name of the stadium?", "When was it demolished?",
              "What was the primary reason for its demolition?"]
round 1 out: ["What is the name of the stadium?"]

round 2 in : ["Which specific stadium in Rome are you referring to?",
              "In what year was it demolished?",
              "What was the primary reason for its demolition?"]
round 2 out: ["Which specific stadium in Rome are you referring to?"]
```

Every drop is logged at INFO as
`questionnaire dropped: rule=<rule> question='<exact text>' (search answers this, not the user; an all-dropped set falls through to Oracle research)`.

---

## 5. Known limits

* **User-only rules win globally, so a bundled question survives whole.**
  `How many seats did it have, and how much detail do you want?` is kept
  intact — `depth` matches and returns "keep" before the fact table is reached.
  `_first_question()` only splits on a literal `?`, so a fact clause sharing a
  string with an intent clause is not separated. In practice Scout emits one
  question per list item. Verified, not assumed.
* **`naming` shields compound name questions.** `What is the name of the
  architect who designed it?` survives. Over-keeping is the accepted bias, but
  this is a known false negative.
* **Pattern guard, not semantics.** `location`'s `which <place>` branch needed a
  research verb for the same reason the `when` branch did. Untightened, it ate
  `Which city does the archive cover?` and `Which city is most relevant to you?`.
  Tightened it still drops the lookups (`Which city was it demolished in?`,
  `Which country hosted the demolition?`, `Which street is the stadium on?`) and
  keeps the scope questions. Eight paired cases pin both directions in
  `tests/test_searxng.py`.
* **Scope-over-period needed a deliberate fix.** `Which year do you care about?`
  was being dropped by `date/year` until `preference` learned `do you care /
  care about / matters`. The Scout prompt invites "which period matters", so the
  two must agree; `tests/test_searxng.py` pins four period questions so this
  cannot regress.