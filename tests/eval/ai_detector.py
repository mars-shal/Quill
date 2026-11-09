"""Open-source AI-text detector used by the evaluation harness.

Model: MayZhou/e5-small-lora-ai-generated-detector (LoRA-tuned E5-small,
reported 89% accuracy on the RAID benchmark). The ONNX int8 export keeps the
check CPU-only and small. Label 0 is human, label 1 is AI-generated.

This is evidence, not proof. Detectors are biased by domain, length and
editing, so the report also carries a simple stylometric profile (sentence
length variance, type-token ratio, repeated 4-grams) as a second signal.
"""

from __future__ import annotations

import glob
import json
import math
import os
import re
from dataclasses import dataclass, asdict
from typing import Iterable

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

MODEL_REPO = "onnx-community/e5-small-lora-ai-generated-detector-ONNX"
SNAPSHOT_GLOB = os.path.expanduser(
    "~/.cache/huggingface/hub/models--onnx-community--e5-small-lora-ai-generated-detector-ONNX/snapshots/*"
)


def _snapshot() -> str:
    roots = [p for p in glob.glob(SNAPSHOT_GLOB) if os.path.isdir(p)]
    if not roots:
        from huggingface_hub import snapshot_download

        return snapshot_download(
            MODEL_REPO,
            allow_patterns=[
                "onnx/model_int8.onnx",
                "config.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "special_tokens_map.json",
                "vocab.txt",
            ],
        )
    return sorted(roots)[-1]


class Detector:
    def __init__(self) -> None:
        base = _snapshot()
        self.tokenizer = AutoTokenizer.from_pretrained(base)
        self.session = ort.InferenceSession(
            os.path.join(base, "onnx", "model_int8.onnx"),
            providers=["CPUExecutionProvider"],
        )

    def score(self, text: str, max_length: int = 512) -> float:
        encoded = self.tokenizer(
            text,
            return_tensors="np",
            truncation=True,
            max_length=max_length,
        )
        feeds = {
            item.name: encoded[item.name]
            for item in self.session.get_inputs()
            if item.name in encoded
        }
        logits = self.session.run(None, feeds)[0][0]
        # Stable softmax.
        shifted = logits - logits.max()
        probs = np.exp(shifted) / np.exp(shifted).sum()
        return float(probs[1])


def chunks(text: str, target_words: int = 260, overlap: int = 40) -> list[str]:
    words = text.split()
    if len(words) <= target_words:
        return [text]
    step = max(40, target_words - overlap)
    return [" ".join(words[i : i + target_words]) for i in range(0, len(words), step)]


@dataclass
class Stylometry:
    words: int
    sentences: int
    mean_sentence_words: float
    sentence_length_sd: float
    type_token_ratio: float
    repeated_4grams: int
    flesch_reading_ease: float


def _syllables(word: str) -> int:
    word = re.sub(r"[^a-z]", "", word.lower())
    if not word:
        return 0
    vowels = "aeiouy"
    count = 0
    previous = False
    for char in word:
        is_vowel = char in vowels
        if is_vowel and not previous:
            count += 1
        previous = is_vowel
    if word.endswith("e") and count > 1:
        count -= 1
    return max(1, count)


def stylometry(text: str) -> Stylometry:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    words = re.findall(r"[A-Za-z']+", text.lower())
    lengths = [len(re.findall(r"[A-Za-z']+", s)) for s in sentences] or [0]
    mean = sum(lengths) / len(lengths)
    sd = math.sqrt(sum((x - mean) ** 2 for x in lengths) / len(lengths)) if len(lengths) > 1 else 0.0
    ttr = len(set(words)) / len(words) if words else 0.0
    grams = [" ".join(words[i : i + 4]) for i in range(max(0, len(words) - 3))]
    repeated = len(grams) - len(set(grams))
    syllables = sum(_syllables(w) for w in words)
    asl = len(words) / max(1, len(sentences))
    asw = syllables / max(1, len(words))
    flesch = 206.835 - 1.015 * asl - 84.6 * asw
    return Stylometry(
        words=len(words),
        sentences=len(sentences),
        mean_sentence_words=round(mean, 1),
        sentence_length_sd=round(sd, 1),
        type_token_ratio=round(ttr, 3),
        repeated_4grams=repeated,
        flesch_reading_ease=round(flesch, 1),
    )


def grade(mean_ai: float, fraction_ai: float) -> str:
    # Two signals: the average probability and how much of the document trips
    # the 0.5 line. A single high chunk is common in a human document with one
    # formulaic paragraph, so the fraction matters.
    if mean_ai < 0.35 and fraction_ai < 0.25:
        return "A (mostly human-like)"
    if mean_ai < 0.50 and fraction_ai < 0.50:
        return "B (mixed, leaning human)"
    if mean_ai < 0.65 and fraction_ai < 0.75:
        return "C (mixed)"
    if mean_ai < 0.80:
        return "D (leaning AI)"
    return "F (strongly AI-like)"


def analyse(text: str) -> dict:
    detector = Detector()
    pieces = chunks(text)
    scores = [detector.score(piece) for piece in pieces]
    mean = float(np.mean(scores)) if scores else 0.0
    fraction = float(np.mean([s >= 0.5 for s in scores])) if scores else 0.0
    return {
        "model": "MayZhou/e5-small-lora-ai-generated-detector (ONNX int8)",
        "chunks": len(pieces),
        "scores": [round(s, 4) for s in scores],
        "mean_ai_probability": round(mean, 4),
        "max_ai_probability": round(max(scores), 4) if scores else 0.0,
        "fraction_chunks_ai": round(fraction, 4),
        "grade": grade(mean, fraction),
        "stylometry": asdict(stylometry(text)),
        "note": "A detector score is not proof of authorship; use it with the citation and plagiarism checks.",
    }


if __name__ == "__main__":
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        raise SystemExit("usage: ai_detector.py <file>")
    print(json.dumps(analyse(open(path, encoding="utf-8").read()), indent=2))
