"""Offline checks for the AI-text screen and the correction pass.

The detector is a screening heuristic, so these tests assert separation between
two deliberately extreme samples rather than a particular probability. The
humanizer is tested on its contract: leave healthy prose alone, never keep a
round that scores worse, and survive a model reply that ignores the markers.

Run: PYTHONPATH=$PWD .venv/bin/python tests/test_aidetect.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from components.humanizer import Humanizer
from utilis.aidetect import detect, split_prose_blocks

PASSED = 0
FAILED = 0


def chk(label: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"PASS  {label}")
    else:
        FAILED += 1
        print(f"FAIL  {label}  {detail}")


MACHINE = """
Furthermore, encrypted records protect student data. This approach protects the database. This approach protects the transcript. This approach protects the verification flow. The system also supports availability. The system also supports replication. The system also supports recovery. It is important to note that scale creates risk. It is important to note that failure creates risk. It is important to note that access creates risk. Moreover, the architecture separates identity, records, and transcripts. The architecture therefore reduces coupling. The architecture therefore improves recovery. The architecture therefore limits exposure. Additionally, key management protects encryption material. Key management protects access control. Key management protects audit evidence.
""".strip()

HUMAN = """
The registrar's office had 14,000 transcripts on one server, and a single bad
migration took it offline for two days. That isn't unusual. Most campuses built
their records system when "distributed" meant a second machine in the basement,
so replication is often bolted on after the fact — and encryption usually after
that. The result works, until a key leaks. We saw this at a partner university
in 2023: one shared database password exposed 3,800 records, and nobody noticed
for eleven days. Fixing it took longer than the breach. The lesson isn't that
encryption is hard; it's that per-field keys are the only way to keep a leak
small.
""".strip()


def test_scores_separate_the_two_samples():
    machine = detect(MACHINE)
    human = detect(HUMAN)
    chk(
        "machine sample scores high",
        machine["risk"] >= 0.7,
        f"risk={machine['risk']} verdict={machine['verdict']}",
    )
    chk(
        "human sample scores low",
        human["risk"] <= 0.45,
        f"risk={human['risk']} verdict={human['verdict']}",
    )
    chk(
        "the gap is large enough to route on",
        machine["risk"] - human["risk"] >= 0.3,
        f"machine={machine['risk']} human={human['risk']}",
    )


def test_paragraph_triage_ranks_the_mechanical_block_first():
    report = detect(MACHINE + "\n\n" + HUMAN)
    chk("paragraphs are triaged", bool(report["paragraphs"]))
    top = report["paragraphs"][0]
    chk(
        "the machine block is the worst paragraph",
        "Furthermore" in top["text"] or "important to note" in top["text"],
        top["text"][:80],
    )
    chk(
        "the triage explains itself",
        bool(top["reasons"]),
        str(top["reasons"]),
    )


def test_headings_and_lists_are_not_editable_prose():
    blocks = split_prose_blocks("# Title\n\nBody text here.\n\n- a list item\n")
    editable = [block for block in blocks if block["editable"]]
    chk("only the paragraph is editable", len(editable) == 1, str(editable))
    chk("the heading is protected", any(not b["editable"] and "Title" in b["text"] for b in blocks))
    chk("the list is protected", any(not b["editable"] and "list item" in b["text"] for b in blocks))


HUMAN_REWRITE = (
    "[[1]] The registrar had 14,000 transcripts on one server. A bad migration "
    "took it offline for two days. That isn't unusual. Most campuses built these "
    "systems when replication meant a second machine in the basement, and "
    "encryption usually arrived later. A single shared password exposed 3,800 "
    "records at one partner campus in 2023. Nobody noticed for eleven days. "
    "Per-field keys are what keep a leak small; encryption alone doesn't."
)


class FakeAgent:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls = 0

    def Quill(self, prompt: str, temperature: float = 0.0) -> str:
        self.calls += 1
        return self.reply


def test_humanizer_improves_and_keeps_the_better_text():
    agent = FakeAgent(HUMAN_REWRITE)
    humanizer = Humanizer(agent, max_paragraphs=2, rounds=1, batch_size=1)
    text, report = humanizer.run(MACHINE)
    chk("the pass ran", report["rounds"] >= 1, str(report))
    chk("the risk fell", report["after"] < report["before"], str(report))
    chk("the rewritten text is the one returned", "14,000" in text, text[:80])
    chk("the model was called", agent.calls >= 1)


def test_a_healthy_document_is_not_sent_to_the_model():
    agent = FakeAgent(HUMAN_REWRITE)
    text, report = Humanizer(agent).run(HUMAN)
    chk("no call for a low-risk document", agent.calls == 0, str(report))
    chk("the text is unchanged", text == HUMAN)
    chk("the skip says why", report.get("skipped") == "below threshold", str(report))


def test_a_reply_without_markers_leaves_the_text_alone():
    agent = FakeAgent("Here is a rewrite without the markers you asked for.")
    text, report = Humanizer(agent, max_paragraphs=1, rounds=1).run(MACHINE)
    chk("unparseable reply changes nothing", text.strip() == MACHINE.strip(), text[:60])
    chk("the score is not worsened", report["after"] <= report["before"], str(report))


def test_rounds_are_capped():
    agent = FakeAgent(HUMAN_REWRITE)
    Humanizer(agent, max_paragraphs=0, rounds=5).run(MACHINE)
    chk("zero paragraphs means no work", agent.calls == 0)


def main() -> int:
    print("--- AI-text screen ---")
    test_scores_separate_the_two_samples()
    test_paragraph_triage_ranks_the_mechanical_block_first()
    test_headings_and_lists_are_not_editable_prose()
    print("--- correction pass ---")
    test_humanizer_improves_and_keeps_the_better_text()
    test_a_healthy_document_is_not_sent_to_the_model()
    test_a_reply_without_markers_leaves_the_text_alone()
    test_rounds_are_capped()
    print()
    if FAILED:
        print(f"FAILURES: {PASSED}/{PASSED + FAILED}")
        return 1
    print(f"ALL PASS: {PASSED}/{PASSED + FAILED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
