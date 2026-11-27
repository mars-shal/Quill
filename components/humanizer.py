"""Targeted correction for machine-sounding prose.

Three layers, each cheap enough to run on a real document:

1. **Screen** -- `utilis.aidetect.detect` scores the document and ranks its
   paragraphs. Only blocks above the threshold are considered.
2. **Correct** -- flagged paragraphs are rewritten in small batches with the
   same rules the natural-voice style asks for. The prompt forbids new facts,
   and a reply that loses a marker simply leaves that paragraph alone.
3. **Verify** -- the document is scored again. A round that does not lower the
   risk is discarded, so the pass can never make the text worse by its own
   measure. This is why the caller gets the best version, not the last one.

It is deliberately bounded. Rewriting every paragraph of a long book costs
roughly another writing pass, so `max_paragraphs` and `rounds` are caps, not
suggestions, and every value can be tuned by environment without a rebuild.
"""

from __future__ import annotations

import os
import re

from loguru import logger

from utilis.aidetect import detect, split_prose_blocks

_MARK = re.compile(r"\[\[(\d+)\]\]\s*(.*?)(?=\n\s*\[\[\d+\]\]|\Z)", re.S)

PROMPT = """You are a line editor. Rewrite each numbered paragraph so it reads
like a careful human academic wrote it, not a model.

Keep every fact, number, citation and claim. Add nothing. Do not summarise and
do not merge paragraphs.

Rules for every paragraph:
- Vary sentence length between 6 and 18 words, and include at least one short
  sentence of 4-7 words.
- Never open a sentence with "This", "These", "It is", "There is" or "We".
- Use one contraction where it sounds natural ("doesn't", "isn't", "can't").
- No stock transitions: Furthermore, Moreover, Additionally, Therefore, Thus.
- No three-item lists joined by commas.
- Lead with a concrete subject and an active verb.
- Keep the meaning and roughly the same length.

Return only the rewritten paragraphs, each prefixed with the same marker and
nothing else:

[[1]] rewritten paragraph
[[2]] rewritten paragraph
"""


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class Humanizer:
    def __init__(
        self,
        agent,
        *,
        threshold: float | None = None,
        max_paragraphs: int | None = None,
        rounds: int | None = None,
        batch_size: int = 4,
        temperature: float = 0.75,
    ) -> None:
        self.agent = agent
        self.threshold = (
            _env_float("QUILL_HUMANIZE_THRESHOLD", 0.5)
            if threshold is None
            else threshold
        )
        self.max_paragraphs = (
            _env_int("QUILL_HUMANIZE_PARAGRAPHS", 12)
            if max_paragraphs is None
            else max_paragraphs
        )
        self.rounds = (
            _env_int("QUILL_HUMANIZE_ROUNDS", 2) if rounds is None else rounds
        )
        self.batch_size = max(1, batch_size)
        self.temperature = temperature

    def run(self, markdown: str) -> tuple[str, dict]:
        """Return `(best_text, report)`. A no-op returns the input unchanged."""
        before = detect(markdown)
        report = {
            "enabled": True,
            "before": before["risk"],
            "after": before["risk"],
            "threshold": self.threshold,
            "rounds": 0,
            "rewritten": 0,
            "verdict_before": before["verdict"],
            "verdict_after": before["verdict"],
        }
        if self.max_paragraphs == 0 or self.rounds == 0:
            report["skipped"] = "disabled by configuration"
            return markdown, report
        if before["risk"] < self.threshold:
            report["skipped"] = "below threshold"
            return markdown, report

        best, best_risk = markdown, before["risk"]
        text = markdown
        for _round in range(self.rounds):
            current = detect(text)
            flagged = [
                row for row in current["paragraphs"] if row["risk"] >= self.threshold
            ][: self.max_paragraphs]
            if not flagged:
                break
            updated = self._rewrite(text, flagged)
            if updated == text:
                break
            report["rounds"] += 1
            report["rewritten"] += len(flagged)
            after = detect(updated)
            if after["risk"] < best_risk:
                best, best_risk = updated, after["risk"]
                text = updated
            if best_risk < 0.4:
                break

        report["after"] = best_risk
        report["verdict_after"] = detect(best)["verdict"]
        logger.info(
            "humanizer: {} round(s), {} paragraph(s), risk {:.2f} -> {:.2f}",
            report["rounds"],
            report["rewritten"],
            report["before"],
            report["after"],
        )
        return best, report

    def _rewrite(self, text: str, flagged: list[dict]) -> str:
        replacements: dict[int, str] = {}
        for start in range(0, len(flagged), self.batch_size):
            batch = flagged[start : start + self.batch_size]
            replacements.update(self._rewrite_batch(batch))
        if not replacements:
            return text
        blocks = split_prose_blocks(text)
        for block in blocks:
            rewritten = replacements.get(block["index"])
            if rewritten:
                block["text"] = rewritten
        return "\n\n".join(block["text"] for block in blocks).strip() + "\n"

    def _rewrite_batch(self, batch: list[dict]) -> dict[int, str]:
        numbered = "\n\n".join(
            f"[[{position + 1}]] {row['text']}" for position, row in enumerate(batch)
        )
        prompt = f"{PROMPT}\n{numbered}"
        try:
            reply = self.agent.Quill(prompt, temperature=self.temperature) or ""
        except Exception as exc:  # a failed batch must not fail the run
            logger.warning("humanizer: batch failed: {}: {}", type(exc).__name__, exc)
            return {}

        parsed: dict[int, str] = {}
        for number, body in _MARK.findall(reply):
            position = int(number) - 1
            if not 0 <= position < len(batch):
                continue
            cleaned = " ".join(body.split()).strip()
            if len(cleaned) >= 40:
                parsed[batch[position]["index"]] = cleaned
        return parsed
