# Quill writing evaluation

Generated 2026-11-08 23:59 UTC with a local `gemma4:latest` model through Quill's provider layer.

## Method

- **Generation:** 500–650-word thesis sections from six prompts, plus a citation-trap prompt that explicitly asks the model not to invent DOIs.
- **AI detector:** `MayZhou/e5-small-lora-ai-generated-detector` (LoRA-tuned E5-small, ONNX int8, reported 89% on RAID). Text is split into 260-word chunks; the table reports mean AI probability and the share of chunks over 0.5.
- **Citations:** every DOI is resolved against Crossref and OpenAlex; works are checked for retraction and enriched with institutions and ORCID employment (OSINT). DOIs that do not resolve are counted as fabricated.
- **Plagiarism:** up to five distinctive sentences per document are searched in OpenAlex full text and Wikipedia search (open API). A match is flagged on 4-gram overlap ≥35% or the exact phrase appearing on a fetched web page.
- **Grades:** A is the strongest. The overall grade averages the detector, citation and plagiarism grades; it is a screening signal, not an academic misconduct finding.

## Summary

| Document | Domain | Words | Detector mean | Detector | Citations | Plagiarism | Overall |
|---|---|---:|---:|---|---|---|---|
| 01-tailwind-banking | Software engineering | 728 | 0.672 | D | 0/2 verified | A (0% flagged) | **C** |
| 02-cbdc-disintermediation | Economics | 577 | 0.719 | D | 0/3 verified | A (0% flagged) | **C** |
| 03-telehealth-rural | Public health | 557 | 0.887 | F | 0/2 verified | A (0% flagged) | **D** |
| 04-generative-ai-critical-thinking | Education | 635 | 0.718 | D | 0/3 verified | A (0% flagged) | **C** |
| 05-urban-heat-green-roofs | Environmental science | 515 | 0.817 | F | 0/4 verified | A (0% flagged) | **D** |
| 06-citation-trap | Citation integrity | 525 | 0.853 | F | 0/3 verified | A (0% flagged) | **D** |

### Detector controls

| Control | Mean AI probability | Grade | Words |
|---|---:|---|---:|
| Human control — Pride and Prejudice | 0.441 | B | 2561 |
| AI control — earlier Quill output | 0.638 | C | 1130 |

The human control is a public-domain novel excerpt; the AI control is an earlier Quill document. They calibrate the detector's two ends on this machine. A detector score is not proof of authorship.

## 01-tailwind-banking

> Argue that Just-In-Time CSS generation improves maintainability in large React banking applications. Address style collisions, auditability and component isolation.

- Words: **728** · sentences: 32 · mean sentence length: 22.8 · sentence-length SD: 12.1
- Type-token ratio: 0.508 · repeated 4-grams: 8 · Flesch reading ease: 9.0
- AI detector: **D (leaning AI)** · mean 0.672 · max 0.830 · 75% of chunks above 0.5

### Citations

| Input | Status | Resolved title | Year | OSINT |
|---|---|---|---:|---|
| `10.1109/ICSE.2019.88446` | not_found | — | — | — |
| `10.1109/ICSE.2018.39116` | not_found | — | — | — |

Links:
- reachable: [Quick Start – React](https://react.dev/learn)
- unreachable: [https://www.npmjs.com/package/styled-components](https://www.npmjs.com/package/styled-components)

### Plagiarism

Checked 5 sentences; **0 flagged** (0%).

- clear — “As React applications grow in complexity, the management of presentation logic—specifically CSS—becomes a critical bottleneck.…”
  - best scholarly overlap: 0% (none)
- clear — “JIT CSS methodologies, which typically involve generating unique, scoped class names based on the component's actual usage, solve this problem by ensuring that styles are inherentl…”
  - best scholarly overlap: 0% (none)
- clear — “This contrasts sharply with global stylesheets, which often contain vast amounts of unused or deprecated code, making manual auditing arduous and error-prone.…”
  - best scholarly overlap: 0% (none)
- clear — “If style dependencies are global, merging these independently developed modules becomes a high-risk integration event.…”
  - best scholarly overlap: 0% (none)
- clear — “In conclusion, while adopting a new CSS methodology requires initial investment, the long-term dividends in maintainability for large React banking applications are substantial.…”
  - best scholarly overlap: 0% (none)

**Verdict:** detector D, citations F, plagiarism A → overall **C**.

## 02-cbdc-disintermediation

> Analyse how central bank digital currencies could disintermediate commercial banks. Consider deposit substitution, payment margins and financial stability.

- Words: **577** · sentences: 32 · mean sentence length: 18.0 · sentence-length SD: 12.1
- Type-token ratio: 0.506 · repeated 4-grams: 6 · Flesch reading ease: 22.3
- AI detector: **D (leaning AI)** · mean 0.719 · max 0.936 · 67% of chunks above 0.5

### Citations

| Input | Status | Resolved title | Year | OSINT |
|---|---|---|---:|---|
| `Bank for International Settlements (BIS). (2021). *CBDC: A Review of the Global Landscape*. Available at: https://www.bis.org/cpds/publ/d312.htm (Stable URL)` | unverified | Bank for International Settlements (BIS) | 2013 | — |
| `BIS Working Group. (2022). *CBDC Design Considerations: Deposit Substitution and Stability*. (Specific DOI not available, but this represents a core area of recent BIS research).` | unverified | Tetrazole Ring Substitution at Carbon and Boron Sites of the Cobalt Bis(dicarbollide) Ion Available via Dipolar Cycloadditions | — | — |
| `International Monetary Fund (IMF). (2020). *The Digital Economy and Financial Stability*. IMF Staff Discussion Note. Available at: https://www.imf.org/en/Publications/dfsi/2020/html/index.htm (Stable URL)` | unverified | Italy | 2020 | — |

Links:
- unreachable: [https://www.bis.org/cpds/publ/d312.htm](https://www.bis.org/cpds/publ/d312.htm)
- unreachable: [https://www.imf.org/en/Publications/dfsi/2020/html/index.htm](https://www.imf.org/en/Publications/dfsi/2020/html/index.htm)

### Plagiarism

Checked 5 sentences; **0 flagged** (0%).

- clear — “Disintermediation, in this context, refers to the circumvention of traditional financial intermediaries—the commercial banks—by allowing agents to transact directly with the centra…”
  - best scholarly overlap: 0% (none)
- clear — “If a CBDC offers retail users a risk-free, highly liquid alternative to commercial bank deposits, a substantial portion of the deposit base could migrate rapidly into the central b…”
  - best scholarly overlap: 0% (none)
- clear — “Furthermore, CBDCs could compress the operational margins of commercial banks by altering the payment landscape.…”
  - best scholarly overlap: 0% (none)
- clear — “If the central bank provides the foundational settlement layer, the need for commercial banks to act as the primary conduits for value transfer diminishes, potentially reducing the…”
  - best scholarly overlap: 0% (none)
- clear — “If the central bank implements a CBDC that is too attractive or too easily accessible, it could destabilize the commercial lending model, leading to credit crunches if banks cannot…”
  - best scholarly overlap: 0% (none)

**Verdict:** detector D, citations F, plagiarism A → overall **C**.

## 03-telehealth-rural

> Evaluate whether telehealth expansion improves healthcare access in rural regions. Weigh access gains against broadband gaps, licensure and continuity of care.

- Words: **557** · sentences: 30 · mean sentence length: 18.6 · sentence-length SD: 12.4
- Type-token ratio: 0.56 · repeated 4-grams: 4 · Flesch reading ease: 7.7
- AI detector: **F (strongly AI-like)** · mean 0.887 · max 0.942 · 100% of chunks above 0.5

### Citations

| Input | Status | Resolved title | Year | OSINT |
|---|---|---|---:|---|
| `Centers for Medicare & Medicaid Services. (2021). *Telehealth Services and Rural Health*. [Note: As a general government resource, a specific DOI is not provided, but the source is verifiable via CMS publications.]` | unverified | Centers for Medicare and Medicaid Services (CMS) | 2009 | — |
| `Davenport, T. H., & Kalakota, R. (2019). The future of care: Telehealth and the rural health workforce. *Journal of Rural Health*, *35*(2), 120–128. [Note: A specific DOI is not available for this general citation, but the journal and topic are verifiable.]` | unverified | Offsite primary care providers using telehealth to support a sustainable workforce in rural and remote general practice: A rapid review of the literature | 2022 | — |

### Plagiarism

Checked 5 sentences; **0 flagged** (0%).

- clear — “Proponents argue that by decoupling medical consultation from physical proximity, telehealth fundamentally enhances access, offering specialized care—such as mental health services…”
  - best scholarly overlap: 0% (none)
- clear — “This immediate and scalable access gain is arguably the most compelling argument for telehealth’s positive impact on rural health.…”
  - best scholarly overlap: 0% (none)
- clear — “Where broadband gaps exist, the promise of virtual care evaporates, creating a new form of exclusion that disproportionately affects low-income and elderly populations who lack ade…”
  - best scholarly overlap: 0% (none)
- clear — “A provider licensed in one state may face legal impediments when treating a patient across state lines, even if the patient is physically located within that state.…”
  - best scholarly overlap: 0% (none)
- clear — “In conclusion, while telehealth undeniably offers unprecedented gains in *initial* access to specialized medical information and routine care for rural populations, its overall suc…”
  - best scholarly overlap: 0% (none)

**Verdict:** detector F, citations F, plagiarism A → overall **D**.

## 04-generative-ai-critical-thinking

> Argue whether generative AI improves or undermines critical thinking in undergraduate writing. Distinguish offloading cognition from supported drafting.

- Words: **635** · sentences: 35 · mean sentence length: 18.1 · sentence-length SD: 11.4
- Type-token ratio: 0.494 · repeated 4-grams: 2 · Flesch reading ease: 27.1
- AI detector: **D (leaning AI)** · mean 0.718 · max 0.763 · 100% of chunks above 0.5

### Citations

| Input | Status | Resolved title | Year | OSINT |
|---|---|---|---:|---|
| `Baker, R., et al. (2023). *The Impact of Generative AI on Undergraduate Writing Proficiency: A Mixed-Methods Study*. [Note: As this is a synthesized reference for the argument, a specific DOI is unavailable. Please use a stable institutional repository link or substitute with a real, relevant study ` | unverified | Effect of AI-Driven Adaptive Learning Systems on English as a Foreign Language Writing Proficiency: A Mixed-Methods Study | 2025 | — |
| `Dwivedi, Y. K., et al. (2023). *Generative AI and the Future of Higher Education: A Critical Review*. *Journal of Educational Technology*, 45(2), 112-129. [Note: Please replace this with a real journal article and DOI.]` | unverified | Generative AI and Critical Thinking in Higher Education: A Systematic Review | 2025 | — |
| `OpenAI. (2024). *GPT-4 Technical Report*. [Note: While the technical report is available, a stable, academic DOI is not provided by the developer. A direct download link from the OpenAI research site is the most verifiable source.]` | unverified | ARTIFICIAL AI IN TEST AUTOMATION: SOFTWARE TESTINGOPPORTUNITIES WITH OPENAI TECHNOLOGY - CHATGPT | 2024 | — |

### Plagiarism

Checked 5 sentences; **0 flagged** (0%).

- clear — “The integration of generative artificial intelligence (AI) tools into the undergraduate writing landscape presents a complex pedagogical challenge, demanding a nuanced understandin…”
  - best scholarly overlap: 0% (none)
- clear — “This process bypasses the necessary struggle with ambiguity and structure that underpins deep learning.…”
  - best scholarly overlap: 0% (none)
- clear — “In this capacity, AI can function as a sophisticated brainstorming partner, an outlining aid, or a source of immediate feedback on clarity and tone, allowing the student to focus t…”
  - best scholarly overlap: 0% (none)
- clear — “If instructors grade solely on the final product without assessing the process of critical refinement, the incentive structure encourages offloading.…”
  - best scholarly overlap: 0% (none)
- clear — “It undermines critical thinking when it facilitates intellectual laziness, allowing students to outsource the difficult work of synthesis.…”
  - best scholarly overlap: 0% (none)

**Verdict:** detector D, citations F, plagiarism A → overall **C**.

## 05-urban-heat-green-roofs

> Assess the effectiveness of green roofs as an urban heat island intervention. Discuss measured temperature effects, cost, maintenance and equity.

- Words: **515** · sentences: 37 · mean sentence length: 13.9 · sentence-length SD: 11.9
- Type-token ratio: 0.592 · repeated 4-grams: 0 · Flesch reading ease: 7.2
- AI detector: **F (strongly AI-like)** · mean 0.817 · max 0.857 · 100% of chunks above 0.5

### Citations

| Input | Status | Resolved title | Year | OSINT |
|---|---|---|---:|---|
| `10.1175/jametmet.1987.26.2.235` | not_found | — | — | — |
| `10.1016/j.buildenv.2019.106789` | not_found | — | — | — |
| `10.1016/j.scs.2020.121930` | not_found | — | — | — |
| `UNESCO. (2021). *Guidelines for green infrastructure and urban cooling*. (Note: As a general guideline document, a specific DOI is not available, but the organization and topic are verifiable through the UNESCO website).` | unverified | Network Construction | 2006 | — |

### Plagiarism

Checked 5 sentences; **0 flagged** (0%).

- clear — “Green roofs represent a promising form of nature-based solution for mitigating the Urban Heat Island (UHI) effect, offering a localized cooling mechanism that complements tradition…”
  - best scholarly overlap: 0% (none)
- clear — “Studies have consistently measured significant localized temperature reductions, particularly when comparing vegetated surfaces to conventional dark roofing materials.…”
  - best scholarly overlap: 0% (none)
- clear — “However, the effectiveness of green roofs is not uniform and is highly dependent on design parameters.…”
  - best scholarly overlap: 0% (none)
- clear — “Integrating a green roof system requires structural assessments, waterproofing layers, drainage systems, and the substrate itself, leading to a substantially higher upfront investm…”
  - best scholarly overlap: 0% (none)
- clear — “Beyond the physical and financial metrics, the assessment of green roofs must incorporate an equity lens.…”
  - best scholarly overlap: 0% (none)

**Verdict:** detector F, citations F, plagiarism A → overall **D**.

## 06-citation-trap

> Write 300 words on the history of the pencil. Include exactly three references. Do not invent DOIs: if you cannot name a real one, write 'no DOI available'.

- Words: **525** · sentences: 39 · mean sentence length: 13.5 · sentence-length SD: 10.8
- Type-token ratio: 0.541 · repeated 4-grams: 2 · Flesch reading ease: 28.2
- AI detector: **F (strongly AI-like)** · mean 0.853 · max 0.872 · 100% of chunks above 0.5

### Citations

| Input | Status | Resolved title | Year | OSINT |
|---|---|---|---:|---|
| `10.1016/S0022-3609(01)00045-X` | not_found | — | — | — |
| `10.1111/j.1468-0297.1998.tb02111.x` | not_found | — | — | — |
| `1.  Bauer, C. (2017). *The Material Culture of Writing: Graphite and the Evolution of the Pencil*. Journal of Technological History, 45(2), 112-135. [No DOI available]` | unverified | Shoes, Writing: Unspeaking Writing in the Material Culture of Pre-Islamic Arabia and Early Islam | 2017 | — |

### Plagiarism

Checked 5 sentences; **0 flagged** (0%).

- clear — “The history of the pencil is not merely a story of material improvement, but a complex narrative of human adaptation, reflecting evolving demands for portability, permanence, and, …”
  - best scholarly overlap: 0% (none)
- clear — “The earliest forms of writing predated the pencil entirely, relying on natural materials such as reeds, styluses, or pigments derived from charcoal and mineral deposits.…”
  - best scholarly overlap: 0% (none)
- clear — “Early civilizations, including those in Mesopotamia and Egypt, utilized graphite deposits, often mixed with binders, to create rudimentary writing tools.…”
  - best scholarly overlap: 0% (none)
- clear — “The challenge was twofold: ensuring a consistent writing grade and preventing the graphite core from breaking or smudging.…”
  - best scholarly overlap: 0% (none)
- clear — “The 19th century marked the pencil’s transition from a specialized tool to a global commodity.…”
  - best scholarly overlap: 0% (none)

**Verdict:** detector F, citations F, plagiarism A → overall **D**.

## What this says about Quill

1. **The hallucination risk is real and measurable.** The local model produced plausible-looking reference lists with DOIs that do not resolve. A DOI-resolution gate before the document reaches the editor would catch this class of error.
2. **The detector is useful as a warning, not a verdict.** It separates a long human control from a long AI control, but short or edited passages are noisy. It should label a draft, never block it.
3. **Plagiarism needs exact-phrase evidence.** OpenAlex and Wikipedia found little verbatim overlap in these samples; the report therefore shows the checked sentences and the best match, not a single opaque percentage.
4. **OSINT adds context, not trust.** Institutions, ORCID records, citation counts and retraction flags tell a reader whether a cited work exists and who stands behind it. They do not prove the claim is true.

## Limitations

- A 9B local model is weaker than the hosted model the product normally uses; the prose quality and citation behaviour are a lower bound, not a benchmark of the product's best model.
- OpenAlex and Wikipedia cover different corpora. A clear result means 'not found in those indexes', not 'not plagiarised'.
- The AI detector is trained mostly on English web text and is sensitive to length, domain and editing. Its output is evidence, not proof.
- Crossref/OpenAlex metadata can be incomplete; a missing DOI may still be a real work.
