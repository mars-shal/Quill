"""Search mode: answers from the open document, not from the web.

Run with `PYTHONPATH=$PWD .venv/bin/python tests/test_document_search.py`.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from components.documentSearch import (
    audit_document,
    is_structural_question,
    is_yes_no_question,
    render_audit,
    render_no_hits,
    search_document,
    search_terms,
)
from components.orchestrator import Task

RESULTS: list[bool] = []


def chk(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"   [{detail}]"))


DOCUMENT = """# Multistage Amplifiers

## Gain

A single stage cannot do everything. The gain is the product of the stages.

## Miller effect

The Miller effect slows the amplifier at high frequencies because the
collector-base capacitance looks larger when the gain is high.

## Coupling

RC coupling blocks direct current but passes the signal.
"""


def main() -> int:
    terms = search_terms("did you remove millers effect?")
    chk(
        "possessive/plural words are normalised",
        terms[:2] == ["miller", "effect"],
        repr(terms),
    )
    chk(
        "question scaffolding is not searched",
        "did" not in terms and "you" not in terms and "remove" not in terms,
        repr(terms),
    )

    found = search_document(DOCUMENT, "Did you remove the Miller effect?")
    chk("the Miller section is found", found["has_evidence"], repr(found))
    chk(
        "the hit names its heading and line",
        found["hits"][0]["heading"] == "Miller effect" and found["hits"][0]["line"] > 0,
        repr(found["hits"][:1]),
    )
    chk("a present term is not missing", "miller" not in found["missing"], repr(found["missing"]))

    absent = search_document(DOCUMENT, "did you remove the Darlington pair?")
    chk("an absent term is reported missing", "darlington" in absent["missing"], repr(absent))
    chk("an absent term has no evidence", not absent["has_evidence"], repr(absent["hits"]))

    long_document = DOCUMENT + "\n\n" + ("filler sentence about resistors. " * 800) + "\n\n## Cascode\n\nThe cascode reduces the Miller effect."
    deep = search_document(long_document, "where is the cascode?")
    chk(
        "a match beyond the first 12k characters is still found",
        any("cascode" in hit["text"].lower() for hit in deep["hits"]),
        repr([hit["heading"] for hit in deep["hits"]]),
    )

    halted = """# Generation Halted — Insufficient Research Evidence

> **⚠ THIS RUN PRODUCED NO CONTENT.** No section could be written.

- Corpus size: **209448 chars** (minimum 800)
- Relevant pages: **0** (minimum 1)
- Research quality: **0.101** (minimum 0.35)

## Skipped outline

### II. How They Work Together

*Write II. How They Work Together for: assistant: New conversation. user: can rewrite the document*

*- How: a list marker that lost its emphasis*
"""
    audit = audit_document(halted)
    chk("the halt stub is recognised", audit["halted"], repr(audit))
    chk(
        "the gate numbers are parsed",
        audit["gate"]["corpus"] == 209448
        and audit["gate"]["pages"] == 0
        and audit["gate"]["quality"] == 0.101,
        repr(audit["gate"]),
    )
    kinds = {issue["kind"] for issue in audit["issues"]}
    chk("placeholder content is flagged", "placeholder" in kinds, repr(kinds))
    chk("leaked chat history is flagged", "leaked-chat" in kinds, repr(kinds))
    chk("broken emphasis is flagged", "broken-markdown" in kinds, repr(kinds))
    chk(
        "a skipped outline is recognised",
        audit["skipped_outline"] is True,
        repr(audit["skipped_outline"]),
    )

    report = render_audit(audit)
    chk("the report names the failing page gate", "Relevant pages" in report, report[:200])
    chk("the report explains the recovery", "How to recover" in report, report[:200])
    chk(
        "the report names the leaked transcript",
        "Chat history leaked" in report,
        report[:400],
    )

    chk(
        "a generation question is structural",
        is_structural_question("can u go through the ast generation and help me solve this?"),
    )
    chk(
        "a document question is not structural",
        not is_structural_question("did you remove the Miller effect?"),
    )
    chk("a did-you question is yes/no", is_yes_no_question("did you remove it?"))

    no_hits = render_no_hits(absent, audit_document(DOCUMENT))
    chk("no-hit answers say the term is absent", "No occurrence" in no_hits, no_hits[:120])

    class _Agent:
        def model(self, prompt, **kwargs):
            self.prompt = prompt
            return "The Miller effect is still in the draft."

    task = Task.__new__(Task)
    task.agent = _Agent()
    answer = task.Search("did you remove the Miller effect?", DOCUMENT)
    chk("Search answers from the draft", "still in the draft" in answer["answer"], repr(answer))
    chk(
        "the model only sees matching excerpts",
        "collector-base capacitance" in task.agent.prompt
        and "RC coupling" not in task.agent.prompt,
        task.agent.prompt[:300],
    )
    chk("Search returns no web sources", answer["sources"] == [], repr(answer["sources"]))

    task.agent = _Agent()
    structural = task.Search(
        "can u go through the ast generation and help me solve this?", halted
    )
    chk(
        "a structural question is answered without the model",
        "Why the run halted" in structural["answer"] and not hasattr(task.agent, "prompt"),
        structural["answer"][:200],
    )

    task.agent = _Agent()
    pasted = task.Search("help me solve this:\n" + halted, DOCUMENT)
    chk(
        "a halt stub pasted into the chat is diagnosed too",
        "Why the run halted" in pasted["answer"] and "How to recover" in pasted["answer"],
        pasted["answer"][:200],
    )

    passed = sum(RESULTS)
    print(f"\n{'ALL PASS' if passed == len(RESULTS) else 'FAILURES'}: {passed}/{len(RESULTS)}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
