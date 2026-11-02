"""Quill entry point.

Write one thesis-style document from the source document:

    uv run python main.py                     # run the default prompt
    uv run python main.py "My own ask"        # run one custom prompt
    uv run python main.py --list              # show the built-in prompts

The source document is parsed once, the run gets its own named session, and
every function call, argument, return value, LLM prompt and response is
written to a timestamped file under ``logs/``.
"""

import os
import sys
import time

from loguru import logger

from components.orchestrator import TaskRouter
from components.sessionManager import slugify
from utilis.documentparser import DocumentParser
from utilis.timing import current_log_path, log_block, report

SOURCE_DOCUMENT = "utilis/test/testDocuments/theisus(1).md"

TEST_PROMPTS = [
    "Hey Can you Write a new thieasis for me about The desimation of the stadium of Rome",
    "Write a thesis on using Arduino-based motion sensors for home security in Nigeria",
    "Write a thesis comparing PIR sensor technology to other motion-detection methods",
    "Write a thesis on the causes of the Nigerian Civil War",
    "Write a thesis on the economic impact of colonial trade routes in West Africa",
    "Write a thesis on affordable security technology for Nigerian university hostels",
    "Write a thesis on IoT-based intrusion detection systems",
    "Write a thesis on surveillance and security architecture in precolonial Nigerian palace compounds",
    "Write a thesis on the evolution of home security systems from mechanical locks to smart sensors",
    "Write a thesis on Arduino-based agricultural monitoring systems",
    "Write a thesis on motion pictures and the history of Nollywood",
    "Write a thesis on the detection of financial fraud in Nigerian banking systems",
]
#Dont run this
DEFAULT_PROMPT = TEST_PROMPTS[0]


SURVEY_FLAGS = ("--survey", "--survey-force")


def extract_flags(argv: list[str]) -> tuple[list[str], set[str]]:
    """Split run flags out of the prompt words."""
    flags = {a for a in argv if a in SURVEY_FLAGS}
    return [a for a in argv if a not in SURVEY_FLAGS], flags


def parse_prompt(argv: list[str]) -> str | None:
    """Work out the single prompt to run; None when there is nothing to do."""
    argv, _ = extract_flags(argv)
    if "--list" in argv:
        for i, prompt in enumerate(TEST_PROMPTS, 1):
            print(f"{i:2d}. {prompt}")
        return None
    if not argv:
        return DEFAULT_PROMPT
    if argv[0] in ("--all", "-a"):
        print("This entry point runs one prompt. Use --list to see the built-ins.")
        return None
    return " ".join(argv)


def run_one(
    prompt: str, document_id: str, session_name: str = "",
    concept_mode: str = "reference",
) -> dict:
    logger.info("=" * 78)
    logger.info(f"PROMPT: {prompt}")
    if session_name:
        logger.info(f"SESSION NAME REQUESTED: {session_name}")
    logger.info("=" * 78)

    started = time.monotonic()
    try:
        result = TaskRouter().route_task(
            prompt, document_id, session_name, concept_mode=concept_mode
        )
    except BaseException as exc:  # noqa: BLE001 - the run must always report
        elapsed = time.monotonic() - started
        logger.exception(f"run failed after {elapsed:.1f}s: {type(exc).__name__}: {exc}")
        return {
            "prompt": prompt,
            "session": "",
            "concept": "",
            "output": "",
            "error": f"{type(exc).__name__}: {exc}",
            "seconds": round(elapsed, 1),
        }

    elapsed = time.monotonic() - started
    row = {
        "prompt": prompt,
        "session": result.get("session_name", "") if isinstance(result, dict) else "",
        "concept": result.get("concept", "") if isinstance(result, dict) else "",
        "output": f"output/{slugify(result.get('session_name', ''))}.md"
        if isinstance(result, dict) and result.get("session_name")
        else "",
        "error": "",
        "seconds": round(elapsed, 1),
    }
    if isinstance(result, dict) and result.get("error"):
        row["error"] = str(result["error"])
    elif isinstance(result, str) and result.startswith("An error occurred"):
        row["error"] = result

    if isinstance(result, dict):
        for key in ("research_quality", "low_research"):
            if key in result:
                logger.info(f"{key}: {result[key]}")
        if result.get("markdown"):
            log_block("FINAL DOCUMENT", result["markdown"])
        if result.get("plagiarism"):
            logger.info(f"plagiarism: {result['plagiarism']}")

    logger.info(f"ELAPSED {elapsed:.1f}s")
    if row["error"]:
        logger.error(f"FAILED: {row['error'][:400]}")
    else:
        logger.info(f"OK session={row['session']} saved={row['output']}")
    return row


def main(prompt: str, session_name: str = "", concept_mode: str = "reference") -> int:
    log_file = current_log_path()
    logger.info(f"Quill starting. Log file: {log_file}")
    print(f"Log file: {log_file}")

    logger.info(f"Parsing source document: {SOURCE_DOCUMENT}")
    print("Parsing Documents....")
    try:
        document = DocumentParser().parse(SOURCE_DOCUMENT)
    except BaseException as exc:  # noqa: BLE001
        logger.exception(f"document parse failed: {type(exc).__name__}: {exc}")
        print(f"Could not parse {SOURCE_DOCUMENT}: {exc}")
        return 1

    document_id = document["unique_id"]
    logger.info(f"Document ready: {document_id}")
    print(f"Document ready: {document_id}")

    row = run_one(prompt, document_id, session_name, concept_mode=concept_mode)

    print("\n" + "=" * 78)
    print("RESULT")
    print("=" * 78)
    if row["error"]:
        print(f"  FAILED after {row['seconds']}s: {row['error'][:300]}")
    else:
        print(f"  time    : {row['seconds']}s")
        print(f"  session : {row['session']}")
        print(f"  concept : {row['concept'][:160]}")
        print(f"  saved   : {row['output']}")
    print(f"\n  log     : {current_log_path()}")

    timing = report()
    logger.info(f"timing report:\n{timing}")
    if log_file:
        try:
            with log_file.open("a", encoding="utf-8") as fh:
                fh.write(f"\n{timing}\n")
        except OSError:
            pass
    return 1 if row["error"] else 0


if __name__ == "__main__":
    argv, flags = extract_flags(sys.argv[1:])
    if "--survey-force" in flags:
        os.environ["SURVEY_FORCE"] = "1"
    mode = "survey" if flags & {"--survey", "--survey-force"} else "reference"
    chosen = parse_prompt(argv)
    if chosen and mode == "survey":
        logger.info("concept mode: survey (forced)" if "--survey-force" in flags
                    else "concept mode: survey")
    raise SystemExit(main(chosen, concept_mode=mode) if chosen else 0)
