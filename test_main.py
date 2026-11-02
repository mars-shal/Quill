"""Test harness: run the built-in prompts with the questionnaire FORCED ACTIVE.

Why this exists
---------------
`ResearchEngine._ask_user` returns `{}` immediately when `_interactive()` is
false, which is the case in every non-tty run. That silently kills the whole
`answers -> _refined_queries -> _crawl_queries` branch, so no script, CI job or
agent run has ever exercised it. This harness monkeypatches that one method at
runtime -- production code is never edited -- and answers the questions with an
LLM so the branch actually runs.

    uv run python test_main.py                    # first 3 prompts (default)
    uv run python test_main.py --limit 12         # all of them
    uv run python test_main.py --prompt "..."     # one specific prompt
    uv run python test_main.py --answers-mode blank   # reproduce today's behaviour

Everything is written under `test_output/`. `output/` is never touched.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

from components.orchestrator import TaskRouter
from components.researchEngine import ResearchEngine, _is_informative
from components.sessionManager import slugify
from main import SOURCE_DOCUMENT, TEST_PROMPTS
from utilis.documentparser import DocumentParser

OUTPUT_ROOT = Path("test_output")
DEFAULT_LIMIT = 3

# Answers rejected by researchEngine._is_informative are dropped silently, which
# would stall research with no visible cause. Anything weak gets one retry and
# then an explicit marker, and the substitution is recorded in run.json.
FALLBACK_ANSWER = "not specified by the test harness"

ANSWER_SYSTEM = """You are answering a research questionnaire on behalf of a user \
who wants a thesis written.

Answer every question with a concrete, specific, plausible value drawn from \
general knowledge. Rules:
- Never answer "idk", "unknown", "none", "n/a", "no idea" or similar refusals.
- Never ask a question back. Never explain. Values only.
- One short line per question, prefixed by its number.

Respond with JSON only:
{"answers": ["<answer 1>", "<answer 2>"]}"""


class RunRecorder:
    """Collects what the patched _ask_user saw, for this prompt only."""

    def __init__(self) -> None:
        self.proposed: list[str] = []
        self.surviving: list[str] = []
        self.answers: dict[str, str] = {}
        self.substitutions: list[str] = []
        self.asked = False


_CURRENT: RunRecorder | None = None


def _safe_dir(prompt: str) -> Path:
    """A directory under test_output/, whatever the prompt contains.

    A prompt is user text and becomes a path component, so `../../etc` must not
    escape. slugify strips separators, but the resolved path is re-checked
    anyway - the containment guarantee is the point, not the sanitiser.
    """
    name = slugify(prompt) or "unnamed-prompt"
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:80].strip("._") or "unnamed-prompt"
    candidate = (OUTPUT_ROOT / name).resolve()
    root = OUTPUT_ROOT.resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"refusing path outside {root}: {candidate}")
    return candidate


def _answer_questions(agent, questions: list[str]) -> dict[str, str]:
    """One LLM call for the whole questionnaire, sanitised against _is_informative."""
    numbered = "\n".join(f"{i}. {q}" for i, q in enumerate(questions, 1))
    raw = agent.model(
        f"QUESTIONNAIRE:\n{numbered}",
        system_prompt=ANSWER_SYSTEM,
    )
    try:
        parsed = json.loads(raw)
        values = parsed.get("answers") if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError, ValueError):
        values = None
    values = values if isinstance(values, list) else []

    out: dict[str, str] = {}
    for i, q in enumerate(questions):
        value = str(values[i]).strip() if i < len(values) else ""
        if not _is_informative(value):
            value = FALLBACK_ANSWER
        out[q] = value
    return out


def _redirect_pipeline_output() -> None:
    """Point the pipeline's own SessionManager at test_output/, not output/.

    Copying results out afterwards is NOT enough: route_task() -> Write() ->
    SessionManager.save() writes a .md/.research.md/.plagiarism.md trio into
    output/ as a side effect of running at all. On the first harness run that
    silently overwrote a real document. SessionManager already accepts an
    output_dir, so redirect its default here rather than editing it.
    """
    from components import sessionManager

    original_init = sessionManager.SessionManager.__init__

    def patched_init(self, db=None, output_dir: str = ""):
        # An explicit output_dir from a caller still wins; only the default moves.
        original_init(self, db=db, output_dir=output_dir or str(OUTPUT_ROOT / "_pipeline"))

    sessionManager.SessionManager.__init__ = patched_init  # type: ignore[method-assign]


def _install_questionnaire_patch(mode: str) -> None:
    """Force _ask_user active, answering via LLM (or blanks in `blank` mode)."""
    original_clean = ResearchEngine._clean_questions

    def patched(self, questionnaire: list[str]) -> dict[str, str]:
        rec = _CURRENT
        if rec is None:                      # outside a harness run: stay inert
            return {}
        rec.asked = True
        rec.proposed = [str(q) for q in (questionnaire or [])]
        # Scout's raw output is captured separately; these are what survived the
        # research-shaped-question guard in researchEngine.
        rec.surviving = list(original_clean(rec.proposed))
        if not rec.surviving:
            return {}
        if mode == "blank":
            answers = {q: FALLBACK_ANSWER for q in rec.surviving}
        else:
            answers = _answer_questions(self.agent, rec.surviving)
        for q, a in answers.items():
            if a == FALLBACK_ANSWER:
                rec.substitutions.append(q)
        rec.answers = answers
        return answers

    ResearchEngine._ask_user = patched  # type: ignore[method-assign]


def _write_artifacts(outdir: Path, prompt: str, result: dict, rec: RunRecorder,
                    elapsed: float, error: str, stderr_path: Path) -> dict:
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "questions.md").write_text(
        f"# Questionnaire\n\nPrompt: {prompt}\n\n"
        f"Asked at all: **{'yes' if rec.asked else 'no - Scout never requested input'}**\n\n"
        f"## Proposed by Scout ({len(rec.proposed)})\n\n"
        + ("\n".join(f"- {q}" for q in rec.proposed) or "_none_")
        + f"\n\n## Survived the guard ({len(rec.surviving)})\n\n"
        + ("\n".join(f"- {q}" for q in rec.surviving) or "_none - all were research-shaped_\n")
        + "\n\n## Answers given\n\n"
        + ("\n".join(f"**Q:** {q}\n**A:** {a}" for q, a in rec.answers.items()) or "_none_")
        + ("\n\n## Substituted (weak answer rejected by _is_informative)\n\n"
           + "\n".join(f"- {q}" for q in rec.substitutions) if rec.substitutions else ""),
        encoding="utf-8",
    )

    doc = result.get("markdown") or ""
    (outdir / "document.md").write_text(doc, encoding="utf-8")
    placeholders = doc.count("INSUFFICIENT EVIDENCE")

    payload = {
        "prompt": prompt,
        "seconds": round(elapsed, 1),
        "error": error,
        "session": result.get("session_name", ""),
        "concept": result.get("concept", ""),
        "questionnaire_asked": rec.asked,
        "questions_proposed": rec.proposed,
        "questions_surviving": rec.surviving,
        "answers": rec.answers,
        "answer_substitutions": rec.substitutions,
        "document_chars": len(doc),
        "placeholder_sections": placeholders,
        "written_sections": doc.count("\n## ") + doc.count("\n# ") - placeholders if doc else 0,
        "research_quality": result.get("research_quality"),
        "research_relevant_pages": result.get("research_relevant_pages"),
        "low_research": result.get("low_research"),
        "write_gate": result.get("write_gate"),
        "plagiarism": (result.get("plagiarism") or {}).get("score")
        if isinstance(result.get("plagiarism"), dict) else None,
    }
    (outdir / "run.json").write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    (outdir / "research.md").write_text(
        result.get("research") or "_no research summary returned_", encoding="utf-8"
    )
    if stderr_path and stderr_path.exists():
        (outdir / "run.log").write_text(stderr_path.read_text(encoding="utf-8", errors="replace"),
                                        encoding="utf-8")
    return payload


def _outcome(row: dict) -> str:
    """Never call a placeholder-only run a success - that is how 10 empty
    sections once shipped as 'OK'."""
    if row["error"]:
        return "ERROR"
    if not row["document_chars"]:
        return "NO DOCUMENT"
    if row["placeholder_sections"] and not row["written_sections"]:
        return "ALL PLACEHOLDER"
    if row["placeholder_sections"]:
        return f"PARTIAL ({row['placeholder_sections']} placeholders)"
    return "OK"


def _searxng_note() -> str:
    import urllib.request
    try:
        with urllib.request.urlopen(
            "http://localhost:8080/search?q=probe&format=json", timeout=3
        ) as r:
            return "" if r.status == 200 else f"SearXNG answered HTTP {r.status}."
    except Exception as exc:  # noqa: BLE001 - advisory only
        return (f"SearXNG unreachable ({type(exc).__name__}). These runs fall back to the "
                "DDG/Bing scrapers, which currently return junk - results are NOT representative.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                    help=f"run the first N prompts (default {DEFAULT_LIMIT}; 0 = all)")
    ap.add_argument("--prompt", default="", help="run one specific prompt")
    ap.add_argument("--answers-mode", choices=("llm", "blank"), default="llm",
                    help="llm = model answers the questionnaire; blank = denylisted stubs")
    args = ap.parse_args()

    prompts = [args.prompt] if args.prompt else list(TEST_PROMPTS)
    if args.limit and args.limit > 0:
        prompts = prompts[: args.limit]
    skipped = 0 if args.prompt else max(0, len(TEST_PROMPTS) - len(prompts))

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    _redirect_pipeline_output()
    _install_questionnaire_patch(args.answers_mode)

    print(f"Log file will appear under logs/; artifacts under {OUTPUT_ROOT}/")
    print(f"Prompts to run: {len(prompts)}"
          + (f" (skipped {skipped} due to --limit)" if skipped else ""))

    print("Parsing Documents....")
    document = DocumentParser().parse(SOURCE_DOCUMENT)
    document_id = document["unique_id"]
    print(f"Document ready: {document_id}")

    note = _searxng_note()
    if note:
        print("WARNING: " + note)

    rows: list[dict] = []
    for i, prompt in enumerate(prompts, 1):
        global _CURRENT
        rec = RunRecorder()
        _CURRENT = rec
        print(f"\n[{i}/{len(prompts)}] {prompt[:100]}")
        started = time.monotonic()
        result, error = {}, ""
        try:
            result = TaskRouter().route_task(prompt, document_id, "", concept_mode="reference")
            if isinstance(result, dict) and result.get("error"):
                error = str(result["error"])
            elif isinstance(result, str):
                # route_task returns a bare string on some failures. Reading it
                # as a dict-silent success reported a crashed run as NO DOCUMENT
                # with an empty error field - the exact thing _outcome exists to
                # prevent, so a non-dict return is always an error.
                error = result or "route_task returned a non-dict, non-error value"
        except BaseException as exc:  # noqa: BLE001 - one bad prompt must not stop the rest
            error = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        elapsed = time.monotonic() - started
        row = _write_artifacts(_safe_dir(prompt), prompt,
                               result if isinstance(result, dict) else {}, rec,
                               elapsed, error, None)
        row["outcome"] = _outcome(row)
        rows.append(row)
        print(f"    -> {row['outcome']} in {elapsed:.0f}s "
              f"(questions asked: {len(rec.surviving)}, placeholders: {row['placeholder_sections']})")

    _CURRENT = None
    _write_summary(rows, skipped, note, args)
    print(f"\nSummary: {OUTPUT_ROOT / 'summary.md'}")
    return 0 if all(not r["error"] for r in rows) else 1


def _write_summary(rows, skipped, note, args) -> None:
    lines = [
        "# Test harness summary", "",
        f"- Generated: {datetime.now().isoformat(timespec='seconds')}",
        f"- Answers mode: `{args.answers_mode}`",
        f"- Prompts run: {len(rows)}" + (f" / {len(TEST_PROMPTS)} (limit)" if skipped else ""),
        f"- Prompts skipped by `--limit`: {skipped}",
        f"- Placeholders are FAILURES: a run that wrote only placeholders is not OK.",
    ]
    if note:
        lines += ["", f"> **WARNING:** {note}"]
    lines += [
        "", "## Runs", "",
        "| # | prompt | outcome | time | asked | answers | placeholders | chars | quality | error |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for i, r in enumerate(rows, 1):
        lines.append(
            f"| {i} | {r['prompt'][:44].replace('|', '/')} | **{r['outcome']}** "
            f"| {r['seconds']}s | {'yes' if r['questionnaire_asked'] else 'no'} "
            f"| {len(r['answers'])} | {r['placeholder_sections']} | {r['document_chars']} "
            f"| {r['research_quality']} | {r['error'][:60] or '-'} |"
        )
    lines += ["", "## Per-run detail", ""]
    for i, r in enumerate(rows, 1):
        lines += [
            f"### {i}. {r['prompt'][:90]}", "",
            f"- dir: `test_output/{slugify(r['prompt'])}/`",
            f"- concept: {r['concept'] or '-'}",
            f"- questions proposed / survived: {len(r['questions_proposed'])} / {len(r['questions_surviving'])}",
            f"- answers: {json.dumps(r['answers'], ensure_ascii=False)[:400]}",
            f"- write gate: `{r['write_gate']}`",
        ]
        if r["answer_substitutions"]:
            lines.append(f"- **substituted answers**: {r['answer_substitutions']}")
        lines.append("")
    lines += [
        "## What this harness does not prove", "",
        "- A small `--limit` run is not a regression suite.",
        "- LLM answers are not human answers; a real user's answers change the research path.",
        "- It does not validate the drift check or the quality gate - only that the",
        "  questionnaire branch executes and produces artifacts.",
    ]
    (OUTPUT_ROOT / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())