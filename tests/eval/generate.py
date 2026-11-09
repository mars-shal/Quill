"""Generate the evaluation corpus with a local Ollama model.

The point is to test the writing layer with different prompts and then grade
the results with the open-source detector and the citation/plagiarism checks.
Using a local model keeps the run reproducible and costs nothing.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import requests

OUT = Path(__file__).parent / "out"
OUT.mkdir(exist_ok=True)

OLLAMA = "http://127.0.0.1:11434/v1/chat/completions"
MODEL = os.environ.get("EVAL_MODEL", "gemma4:latest")

SYSTEM = """You are an academic writer producing a thesis section for a graduate reader.
Write 500-650 words of continuous prose with a clear argument, evidence, and a short conclusion.
Use 3-5 real, verifiable references. Give each reference a DOI or a stable URL; if you do not know
a real identifier, say so explicitly instead of inventing one. Do not use bullet points for the body.
Return only the section, followed by a References list."""

PROMPTS = [
    {
        "slug": "01-tailwind-banking",
        "domain": "Software engineering",
        "prompt": "Argue that Just-In-Time CSS generation improves maintainability in large React banking applications. Address style collisions, auditability and component isolation.",
    },
    {
        "slug": "02-cbdc-disintermediation",
        "domain": "Economics",
        "prompt": "Analyse how central bank digital currencies could disintermediate commercial banks. Consider deposit substitution, payment margins and financial stability.",
    },
    {
        "slug": "03-telehealth-rural",
        "domain": "Public health",
        "prompt": "Evaluate whether telehealth expansion improves healthcare access in rural regions. Weigh access gains against broadband gaps, licensure and continuity of care.",
    },
    {
        "slug": "04-generative-ai-critical-thinking",
        "domain": "Education",
        "prompt": "Argue whether generative AI improves or undermines critical thinking in undergraduate writing. Distinguish offloading cognition from supported drafting.",
    },
    {
        "slug": "05-urban-heat-green-roofs",
        "domain": "Environmental science",
        "prompt": "Assess the effectiveness of green roofs as an urban heat island intervention. Discuss measured temperature effects, cost, maintenance and equity.",
    },
    {
        "slug": "06-citation-trap",
        "domain": "Citation integrity",
        "prompt": "Write 300 words on the history of the pencil. Include exactly three references. Do not invent DOIs: if you cannot name a real one, write 'no DOI available'.",
    },
]


def generate(prompt: str) -> dict:
    started = time.time()
    response = requests.post(
        OLLAMA,
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 2600,
            "temperature": 0.45,
        },
        timeout=900,
    )
    response.raise_for_status()
    payload = response.json()
    message = payload["choices"][0]["message"]
    content = (message.get("content") or "").strip()
    if not content:
        content = (message.get("reasoning") or "").strip()
    return {
        "content": content,
        "usage": payload.get("usage", {}),
        "finish_reason": payload["choices"][0].get("finish_reason"),
        "seconds": round(time.time() - started, 1),
        "model": MODEL,
    }


def main() -> None:
    manifest = []
    for item in PROMPTS:
        print(f"[gen] {item['slug']} ...", flush=True)
        result = generate(item["prompt"])
        text = result.pop("content")
        path = OUT / f"{item['slug']}.md"
        path.write_text(text, encoding="utf-8")
        record = {**item, **result, "file": path.name, "chars": len(text), "words": len(text.split())}
        manifest.append(record)
        (OUT / f"{item['slug']}.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        print(f"[gen] {item['slug']}: {record['words']} words in {record['seconds']}s", flush=True)

    # Two calibration texts for the detector.
    human = Path("/tmp/opencode/pride.txt")
    if human.exists():
        raw = " ".join(human.read_text(errors="ignore").split())
        start = raw.find("It is a truth universally acknowledged")
        excerpt = raw[start : start + 14000] if start >= 0 else raw[2000:16000]
        (OUT / "00-control-human.txt").write_text(excerpt, encoding="utf-8")
    old = Path.home() / ".local/share/app.quill.workspace/output-api/User-Can-You-Write-a-Reserach.md"
    if old.exists():
        (OUT / "00-control-ai.txt").write_text(old.read_text(errors="ignore"), encoding="utf-8")

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("[gen] done", flush=True)


if __name__ == "__main__":
    main()
