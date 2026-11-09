"""Build the Markdown evaluation report from generated documents."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .ai_detector import analyse as ai_analyse
from .verify import analyse_document

OUT = Path(__file__).parent / "out"


def load_manifest() -> list[dict]:
    path = OUT / "manifest.json"
    if path.exists():
        return json.loads(path.read_text())
    return [
        {"slug": p.stem, "domain": "", "prompt": "", "file": p.name}
        for p in sorted(OUT.glob("*.md"))
    ]


def numeric(grade: str) -> int:
    return {"A": 4, "B": 3, "C": 2, "D": 1, "F": 0}.get((grade or "F")[0].upper(), 0)


def citation_grade(result: dict) -> tuple[str, float]:
    checks = list(result.get("citations") or []) + list(result.get("reference_lines") or [])
    if not checks:
        return "N/A", 0.0
    verified = sum(1 for item in checks if item.get("status") == "verified")
    probable = sum(1 for item in checks if item.get("status") == "probable")
    score = (verified + 0.5 * probable) / len(checks)
    if score >= 0.8:
        return "A", score
    if score >= 0.6:
        return "B", score
    if score >= 0.4:
        return "C", score
    if score >= 0.2:
        return "D", score
    return "F", score


def plagiarism_grade(result: dict) -> tuple[str, float]:
    scan = result.get("plagiarism") or {}
    checked = int(scan.get("checked_sentences") or 0)
    flagged = int(scan.get("flagged_sentences") or 0)
    if not checked:
        return "N/A", 0.0
    ratio = flagged / checked
    if ratio == 0:
        return "A", 0.0
    if ratio <= 0.2:
        return "B", ratio
    if ratio <= 0.4:
        return "C", ratio
    if ratio <= 0.6:
        return "D", ratio
    return "F", ratio


def overall(detector: dict, citation: tuple[str, float], plagiarism: tuple[str, float]) -> str:
    values = [numeric(detector.get("grade", "F"))]
    if citation[0] != "N/A":
        values.append(numeric(citation[0]))
    if plagiarism[0] != "N/A":
        values.append(numeric(plagiarism[0]))
    avg = sum(values) / len(values)
    if avg >= 3.5:
        return "A"
    if avg >= 2.5:
        return "B"
    if avg >= 1.5:
        return "C"
    if avg >= 0.75:
        return "D"
    return "F"


def fmt_pct(value: float) -> str:
    return f"{value * 100:.0f}%"


def build() -> str:
    manifest = load_manifest()
    records = []
    for item in manifest:
        path = OUT / item["file"]
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        print(f"[report] {item['slug']} ...", flush=True)
        detector = ai_analyse(text)
        verification = analyse_document(text)
        cg = citation_grade(verification)
        pg = plagiarism_grade(verification)
        record = {
            **item,
            "text": text,
            "detector": detector,
            "verification": verification,
            "citation_grade": cg,
            "plagiarism_grade": pg,
            "overall": overall(detector, cg, pg),
        }
        records.append(record)
        (OUT / f"{item['slug']}.eval.json").write_text(
            json.dumps({k: v for k, v in record.items() if k != "text"}, indent=2, ensure_ascii=False)
        )

    controls = []
    for name, label in [("00-control-human.txt", "Human control — Pride and Prejudice"), ("00-control-ai.txt", "AI control — earlier Quill output")]:
        path = OUT / name
        if path.exists():
            controls.append({"label": label, "result": ai_analyse(path.read_text(encoding="utf-8"))})

    lines = []
    lines.append("# Quill writing evaluation")
    lines.append("")
    lines.append(f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} with a local `gemma4:latest` model through Quill's provider layer.")
    lines.append("")
    lines.append("## Method")
    lines.append("")
    lines.append("- **Generation:** 500–650-word thesis sections from six prompts, plus a citation-trap prompt that explicitly asks the model not to invent DOIs.")
    lines.append("- **AI detector:** `MayZhou/e5-small-lora-ai-generated-detector` (LoRA-tuned E5-small, ONNX int8, reported 89% on RAID). Text is split into 260-word chunks; the table reports mean AI probability and the share of chunks over 0.5.")
    lines.append("- **Citations:** every DOI is resolved against Crossref and OpenAlex; works are checked for retraction and enriched with institutions and ORCID employment (OSINT). DOIs that do not resolve are counted as fabricated.")
    lines.append("- **Plagiarism:** up to five distinctive sentences per document are searched in OpenAlex full text and Wikipedia search (open API). A match is flagged on 4-gram overlap ≥35% or the exact phrase appearing on a fetched web page.")
    lines.append("- **Grades:** A is the strongest. The overall grade averages the detector, citation and plagiarism grades; it is a screening signal, not an academic misconduct finding.")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("| Document | Domain | Words | Detector mean | Detector | Citations | Plagiarism | Overall |")
    lines.append("|---|---|---:|---:|---|---|---|---|")
    for record in records:
        det = record["detector"]
        ver = record["verification"]
        checks = len(ver.get("citations") or []) + len(ver.get("reference_lines") or [])
        verified = ver.get("verified_dois", 0)
        pg = record["plagiarism_grade"]
        lines.append(
            f"| {record['slug']} | {record.get('domain','')} | {det['stylometry']['words']} | "
            f"{det['mean_ai_probability']:.3f} | {det['grade'].split()[0]} | "
            f"{verified}/{checks} verified | {pg[0]} ({fmt_pct(pg[1])} flagged) | **{record['overall']}** |"
        )
    lines.append("")
    if controls:
        lines.append("### Detector controls")
        lines.append("")
        lines.append("| Control | Mean AI probability | Grade | Words |")
        lines.append("|---|---:|---|---:|")
        for control in controls:
            result = control["result"]
            lines.append(
                f"| {control['label']} | {result['mean_ai_probability']:.3f} | "
                f"{result['grade'].split()[0]} | {result['stylometry']['words']} |"
            )
        lines.append("")
        lines.append("The human control is a public-domain novel excerpt; the AI control is an earlier Quill document. They calibrate the detector's two ends on this machine. A detector score is not proof of authorship.")
        lines.append("")

    for record in records:
        det = record["detector"]
        ver = record["verification"]
        sty = det["stylometry"]
        lines.append(f"## {record['slug']}")
        lines.append("")
        if record.get("prompt"):
            lines.append(f"> {record['prompt']}")
            lines.append("")
        lines.append(f"- Words: **{sty['words']}** · sentences: {sty['sentences']} · mean sentence length: {sty['mean_sentence_words']} · sentence-length SD: {sty['sentence_length_sd']}")
        lines.append(f"- Type-token ratio: {sty['type_token_ratio']} · repeated 4-grams: {sty['repeated_4grams']} · Flesch reading ease: {sty['flesch_reading_ease']}")
        lines.append(f"- AI detector: **{det['grade']}** · mean {det['mean_ai_probability']:.3f} · max {det['max_ai_probability']:.3f} · {fmt_pct(det['fraction_chunks_ai'])} of chunks above 0.5")
        lines.append("")
        lines.append("### Citations")
        lines.append("")
        checks = list(ver.get("citations") or []) + list(ver.get("reference_lines") or [])
        if not checks:
            lines.append("No DOI or reference-like line was found.")
        else:
            lines.append("| Input | Status | Resolved title | Year | OSINT |")
            lines.append("|---|---|---|---:|---|")
            for item in checks:
                base = item.get("openalex") or item.get("crossref") or item.get("best_match") or {}
                osint = item.get("osint") or {}
                extra = []
                if osint.get("institutions"):
                    extra.append("; ".join(osint["institutions"][:2]))
                if osint.get("is_retracted"):
                    extra.append("**RETRACTED**")
                if osint.get("cited_by") is not None:
                    extra.append(f"{osint['cited_by']} citations")
                lines.append(
                    f"| `{item.get('input','')}` | {item.get('status','')} | "
                    f"{base.get('title','') or '—'} | {base.get('year','') or '—'} | {' · '.join(extra) or '—'} |"
                )
        if ver.get("url_checks"):
            lines.append("")
            lines.append("Links:")
            for link in ver["url_checks"]:
                lines.append(f"- {link['status']}: [{link.get('title') or link['url']}]({link['url']})")
        lines.append("")
        lines.append("### Plagiarism")
        lines.append("")
        scan = ver.get("plagiarism") or {}
        if not scan.get("checked_sentences"):
            lines.append("No sentence was long enough to check.")
        else:
            lines.append(f"Checked {scan['checked_sentences']} sentences; **{scan['flagged_sentences']} flagged** ({fmt_pct(record['plagiarism_grade'][1])}).")
            lines.append("")
            for match in scan.get("matches") or []:
                mark = "**FLAGGED**" if match.get("flagged") else "clear"
                lines.append(f"- {mark} — “{match['sentence'][:180]}…”")
                lines.append(f"  - best scholarly overlap: {fmt_pct(match['best_similarity'])} ({match.get('best_title') or 'none'})")
                if match.get("web"):
                    lines.append("  - web: " + "; ".join(f"[{h['title'][:70]}]({h['url']})" for h in match["web"][:2]))
                if match.get("web_phrase_found"):
                    lines.append("  - exact phrase found on a fetched page")
        lines.append("")
        lines.append(f"**Verdict:** detector {det['grade'].split()[0]}, citations {record['citation_grade'][0]}, plagiarism {record['plagiarism_grade'][0]} → overall **{record['overall']}**.")
        lines.append("")

    lines.append("## What this says about Quill")
    lines.append("")
    lines.append("1. **The hallucination risk is real and measurable.** The local model produced plausible-looking reference lists with DOIs that do not resolve. A DOI-resolution gate before the document reaches the editor would catch this class of error.")
    lines.append("2. **The detector is useful as a warning, not a verdict.** It separates a long human control from a long AI control, but short or edited passages are noisy. It should label a draft, never block it.")
    lines.append("3. **Plagiarism needs exact-phrase evidence.** OpenAlex and Wikipedia found little verbatim overlap in these samples; the report therefore shows the checked sentences and the best match, not a single opaque percentage.")
    lines.append("4. **OSINT adds context, not trust.** Institutions, ORCID records, citation counts and retraction flags tell a reader whether a cited work exists and who stands behind it. They do not prove the claim is true.")
    lines.append("")
    lines.append("## Limitations")
    lines.append("")
    lines.append("- A 9B local model is weaker than the hosted model the product normally uses; the prose quality and citation behaviour are a lower bound, not a benchmark of the product's best model.")
    lines.append("- OpenAlex and Wikipedia cover different corpora. A clear result means 'not found in those indexes', not 'not plagiarised'.")
    lines.append("- The AI detector is trained mostly on English web text and is sensitive to length, domain and editing. Its output is evidence, not proof.")
    lines.append("- Crossref/OpenAlex metadata can be incomplete; a missing DOI may still be a real work.")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    report = build()
    target = OUT / "REPORT.md"
    target.write_text(report, encoding="utf-8")
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
