"""CLI entry point: ``uv run python -m quill_engine.cli <file>``.

Pipeline: ingest (parse+chunk+embed) -> research phase (query curator -> DuckDuckGo
-> knowledge graph, when enabled) -> generate every section and subsection in
document order -> export. ``--dry-run`` stops after ingestion (structure
only).

The task instruction comes from ``QUILL_PROMPT`` when set; otherwise the
CLI asks interactively via questionary (in a TTY). Sections whose required
evidence is missing are blocked (never written) unless an evidence file is
supplied (``--evidence <file>`` or ``QUILL_EVIDENCE_FILE``) or the missing
fields are collected interactively: ``--interview`` prompts before
generation, and after a run the CLI offers to collect and retry any
remaining blocked sections. ``--research``/``--no-research`` override
``QUILL_RESEARCH``; ``--store memory|opensearch`` overrides ``QUILL_STORE``.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

import questionary

from . import config, orchestrator, questionnaire, requirement_service
from .export_service import export
from .models import walk_sections
from .thinking_service import ask_followups, build_followups, merge_answers


def _ask_prompt(parser: argparse.ArgumentParser, args: argparse.Namespace) -> str:
    """Resolve the task instruction: QUILL_PROMPT, or questionary.

    When nothing was provided and stdin is a TTY the user is asked
    interactively; otherwise the run cannot generate and we exit with a
    usage error (dry-run still works without a prompt).
    """
    if config.PROMPT:
        return config.PROMPT
    if args.dry_run:
        return ""
    if questionnaire.is_interactive():
        answer = questionary.text("Your prompt ----").ask()
        if answer and answer.strip():
            return answer.strip()
    parser.error(
        "no prompt: set QUILL_PROMPT or answer interactively "
        "(use --dry-run to inspect the source without generating)"
    )
    return ""  # unreachable


def _collect_missing(
    sections, store, project_id: str, results: dict
) -> list:
    """Union of unsatisfied evidence requirements across blocked sections."""
    answers = store.get_evidence(project_id)
    missing: list = []
    for section in walk_sections(sections):
        result = results.get(section.section_id)
        if result is None or result.status != "blocked":
            continue
        reqs = requirement_service.build_requirements(section, answers=answers)
        for req in reqs:
            if not req.present and not req.answer:
                missing.append(req)
    return missing


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="quill-engine",
        description="Generate a corrected write-up of a reference document, section by section.",
    )
    parser.add_argument("file", help="source/reference document (docx/pdf/pptx/md/txt)")
    parser.add_argument(
        "--tui",
        action="store_true",
        help="run the interactive Textual terminal UI (ingest -> generate -> export)",
    )
    parser.add_argument(
        "--format",
        "-f",
        default="markdown",
        choices=["markdown", "md", "docx"],
        help="export format (default: markdown)",
    )
    parser.add_argument(
        "--out",
        "-o",
        default=None,
        help="output directory (default: ./output)",
    )
    parser.add_argument(
        "--providers",
        default=None,
        help="comma-separated LLM provider failover order "
        "(groq,openrouter,google); overrides LLM_PROVIDERS",
    )
    parser.add_argument(
        "--evidence",
        default=None,
        help="JSON or 'field: value' YAML file with user-supplied evidence",
    )
    parser.add_argument(
        "--interview",
        action="store_true",
        help="prompt interactively for missing evidence before generating",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="ingest only — parse, chunk, embed, then exit",
    )
    parser.add_argument(
        "--research",
        dest="research",
        action="store_true",
        default=None,
        help="enable the research phase (query curator -> web search -> knowledge graph)",
    )
    parser.add_argument(
        "--no-research",
        dest="research",
        action="store_false",
        help="disable the research phase",
    )
    parser.add_argument(
        "--store",
        default=None,
        choices=["memory", "opensearch"],
        help="storage backend (default: %s; honors QUILL_STORE)" % config.STORE_BACKEND,
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="enable debug logging",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    if args.providers:
        config.LLM_PROVIDERS = [
            p.strip() for p in args.providers.split(",") if p.strip()
        ]

    if args.research is not None:
        config.RESEARCH_ENABLED = args.research
    if args.store:
        config.STORE_BACKEND = args.store

    if args.tui:
        from .tui import run_tui

        return run_tui(
            args.file,
            fmt=args.format,
            out_dir=args.out,
            title=os.path.splitext(os.path.basename(args.file))[0],
            evidence_file=args.evidence,
        )

    prompt = _ask_prompt(parser, args)

    store = orchestrator.new_store()
    project_id = orchestrator.ingest(args.file, store)

    if args.evidence:
        try:
            store.save_evidence(project_id, questionnaire.load_evidence_file(args.evidence))
        except questionnaire.EvidenceFileError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    elif config.EVIDENCE_FILE:
        try:
            store.save_evidence(project_id, questionnaire.load_evidence_file(config.EVIDENCE_FILE))
        except questionnaire.EvidenceFileError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    sections = store.get_sections(project_id)
    print(f"source project {project_id}: {len(sections)} top-level sections")
    for section in sections:
        print(
            f"  - {section.title} ({section.word_count} words, "
            f"{len(section.children)} subsections)"
        )

    if args.dry_run:
        return 0

    # Thinking layer: the model reads the extracted structure and proposes
    # follow-up questions; the answers refine the task instruction.
    if questionnaire.is_interactive() and config.INTERVIEW_ENABLED:
        questions = build_followups(prompt, sections)
        if questions:
            answers = ask_followups(questions)
            if answers:
                prompt = merge_answers(prompt, answers)

    results = orchestrator.run(
        project_id,
        store,
        prompt=prompt,
        interactive=args.interview,
    )

    # Follow-up: collect missing evidence for any blocked sections and retry.
    if not args.interview and questionnaire.is_interactive():
        missing = _collect_missing(sections, store, project_id, results)
        if missing:
            want = questionary.confirm(
                f"{len(missing)} piece(s) of evidence are missing for some "
                "sections. Collect them now and retry?"
            ).ask()
            if want:
                questionnaire.run_wizard(missing, store, project_id)
                results = orchestrator.run(project_id, store, prompt=prompt)

    generated = sum(1 for r in results.values() if r.status == "generated")
    blocked = sum(1 for r in results.values() if r.status == "blocked")
    failed = sum(1 for r in results.values() if r.status == "failed")
    print(f"generated {generated} sections, {blocked} blocked, {failed} failed")
    if blocked:
        print("blocked (missing evidence; provide --evidence or --interview):")
        for result in results.values():
            if result.status == "blocked":
                title = _title_for(sections, result.section_id)
                print(f"  - {title}: {', '.join(result.missing_fields)}")

    title = os.path.splitext(os.path.basename(args.file))[0]
    out_path = export(project_id, store, fmt=args.format, out_dir=args.out, title=title)
    print(f"exported: {out_path}")
    return 0 if failed == 0 else 1


def _title_for(sections, section_id: str) -> str:
    for section in walk_sections(sections):
        if section.section_id == section_id:
            return section.title
    return section_id


if __name__ == "__main__":
    sys.exit(main())
