# Writing evaluation harness

This directory is a reproducible, local evaluation of Quill's writing layer.
It generates thesis-style sections, runs an open-source AI-text detector, and
checks the citations and copied passages against open indexes.

## Run

```bash
# 1. Start Ollama (or use any OpenAI-compatible provider).
ollama serve

# 2. Generate the corpus (about 10 minutes on CPU with gemma4).
.venv/bin/python tests/eval/generate.py

# 3. Build the report. This calls Crossref, OpenAlex, ORCID, Wikidata and
#    Wikipedia, so it takes a few minutes.
.venv/bin/python -m tests.eval.report
```

The report is written to `tests/eval/out/REPORT.md`, with per-document JSON in
`tests/eval/out/*.eval.json`.

## What is measured

- **AI detector:** `MayZhou/e5-small-lora-ai-generated-detector` (MIT, ONNX
  int8). It is a LoRA-tuned E5-small model; the model card reports 89% accuracy
  on RAID. Scores are chunked at 260 words. A detector score is evidence, not
  proof.
- **Citations:** DOIs are resolved through Crossref and OpenAlex. A DOI that
  does not resolve is reported as fabricated/missing. Verified works are
  enriched with institutions, countries, ORCID employment and retraction
  status.
- **Plagiarism:** distinctive sentences are searched in OpenAlex full text and
  Wikipedia. A sentence is flagged when 4-gram overlap is at least 35% or the
  exact phrase appears on a fetched web page.
- **Stylometry:** word count, sentence length mean/SD, type-token ratio,
  repeated 4-grams and Flesch reading ease.

## Notes

- The local model is a quality lower bound, not the hosted model Quill normally
  uses.
- OpenAlex and Wikipedia cover different corpora. "Not found" means not found
  in those indexes.
- The checker is available to the app through `utilis/verification.py` and the
  `/verify` sidecar route; the editor exposes it as **Tools → Verify citations &
  plagiarism…**.
