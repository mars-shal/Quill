# Natural-voice experiment

One prompt, no loop, no shortening to 300 words.

## Prompt

> Rewrite this to 500-620 words in a plain, direct academic voice. Keep every
> citation and factual claim. Use 8-12 word sentences most of the time. Include
> a few 5-word sentences and two 18-22 word sentences. Use active voice and
> concrete verbs. Avoid nominalisations and formulaic transitions. Do not open
> sentences with "This", "These", "It is" or "There is". Avoid triads and "not
> only ... but also". Use "we" twice where honest. Include one concrete
> illustrative example with a number. Keep paragraphs uneven. No bullet points.

The same text becomes the `NATURAL_VOICE_STYLE` block in
`components/writingEngine.py`, applied once at generation time. It is on by
default; the toggle in Settings → Writing turns it off.

## Results at 200-word chunks

| Document | Words | Mean AI probability | Chunks ≥ 0.5 | Grade |
|---|---:|---:|---:|---|
| 01-tailwind-banking, natural voice | 539 | 0.314 | 0.333 | **B** |
| 01-tailwind-banking, earlier one-pass | 439 | 0.261 | 0.000 | **B** |
| 03-telehealth-rural, mid-length | 361 | 0.421 | 0.333 | **B** |
| 05-urban-heat-green-roofs, one-pass | 310 | 0.340 | 0.000 | **B** |

Average mean: **0.334** (B). The 539-word document is the important one: it
shows the prompt is not relying on a 300-word limit.

## The catch: the detector is not stable

The same 539-word document scores:

| Chunk size | Mean | Chunks ≥ 0.5 | Grade |
|---:|---:|---:|---|
| 150 words | 0.489 | 0.333 | B |
| 200 words | 0.314 | 0.333 | B |
| 260 words | 0.640 | 1.000 | C |
| 350 words | 0.890 | 1.000 | F |

The chunk boundary changes the grade. This is why a single “B” is not a
scientific target.

## Human baseline

Real, human-written academic abstracts on the same telehealth topic scored
**0.923–0.939 (F)** under the same 260-word protocol. The detector is biased
against formal academic prose, not measuring authorship.

## What was built

- `Settings → Writing → Natural voice` toggle.
- `NATURAL_VOICE_STYLE` in `components/writingEngine.py`.
- `natural_voice` passed through chat → `Task.Write` / `Task.ReWrite` →
  `WritingEngine`, so the style is applied at generation time.
- No extra rewrite loop and no 300-word cap.

The setting improves readability and can reach B on the 200-word protocol. It
does not fix citations: the same documents still fabricated DOIs.
