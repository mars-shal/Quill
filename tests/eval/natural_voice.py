"""One-prompt natural-voice rewrite, scored at several chunk sizes.

The point is to test a style prompt that keeps the document at normal length
(500-650 words) instead of shrinking it to 300 words. The detector is sensitive
to chunk boundaries, so the result is reported as a range, not one number.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import requests

from tests.eval.ai_detector import Detector, chunks, stylometry

OUT = Path(__file__).parent / "out"
NATURAL = OUT / "natural"
NATURAL.mkdir(exist_ok=True)
OLLAMA = "http://127.0.0.1:11434/v1/chat/completions"

INSTRUCTION = """Rewrite this to 500-620 words in a plain, direct academic voice.
Keep every citation and every factual claim. Do not invent facts or sources.
Use 8-12 word sentences most of the time. Include a few 5-word sentences and two 18-22 word sentences.
Use active voice and concrete verbs. Avoid nominalisations and formulaic transitions.
Do not open sentences with "This", "These", "It is" or "There is".
Avoid triads and "not only ... but also".
Use "we" twice where honest. Include one concrete illustrative example with a number.
Keep paragraphs uneven. No bullet points. Return only the rewritten section."""

PROMPT = """{instruction}

SECTION:
{text}"""


def rewrite(text: str) -> str:
    response = requests.post(
        OLLAMA,
        json={
            "model": "gemma4:latest",
            "messages": [
                {"role": "system", "content": "You are a plain-spoken academic editor."},
                {"role": "user", "content": PROMPT.format(instruction=INSTRUCTION, text=text)},
            ],
            "max_tokens": 2200,
            "temperature": 0.8,
        },
        timeout=1200,
    )
    response.raise_for_status()
    message = response.json()["choices"][0]["message"]
    return (message.get("content") or message.get("reasoning") or "").strip()


def score(text: str) -> dict:
    detector = Detector()
    result = {}
    for target in (150, 200, 260, 350):
        parts = chunks(text, target_words=target, overlap=20)
        values = [detector.score(part) for part in parts]
        mean = float(np.mean(values)) if values else 0.0
        fraction = float(np.mean([value >= 0.5 for value in values])) if values else 0.0
        result[str(target)] = {
            "mean": round(mean, 4),
            "fraction": round(fraction, 4),
            "chunks": len(parts),
            "scores": [round(value, 4) for value in values],
        }
    result["stylometry"] = stylometry(text).__dict__
    result["words"] = len(text.split())
    return result


def main() -> None:
    records = []
    for path in sorted(OUT.glob("0[1-6]-*.md")):
        if path.parent.name == "natural":
            continue
        target = NATURAL / path.name
        print(f"[natural] {path.name} ...", flush=True)
        started = time.time()
        text = rewrite(path.read_text(encoding="utf-8"))
        target.write_text(text, encoding="utf-8")
        result = score(text)
        record = {"file": target.name, "source": path.name, "seconds": round(time.time() - started, 1), **result}
        records.append(record)
        print(
            f"[natural] {path.name}: {record['words']} words, "
            f"200-word mean {result['200']['mean']} / {result['200']['fraction']}",
            flush=True,
        )

    (NATURAL / "scores.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    print("[natural] done", flush=True)


if __name__ == "__main__":
    main()
