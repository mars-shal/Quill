"""Service 12 — Questionnaire: collect missing evidence from the user.

Two sources, in priority order (option C): an evidence file (JSON or a
simple ``field: value`` YAML) wins if provided; otherwise an interactive
questionary wizard prompts for each missing field on the terminal. Answers
are saved to the store so ``present``/``answer`` resolution is a pure store
lookup.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import questionary

from .models import EvidenceRequirement
from .storage import StorageService


class EvidenceFileError(RuntimeError):
    """Raised when an evidence file is unreadable or malformed."""


def _parse_flat_yaml(text: str) -> dict[str, str]:
    answers: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            raise EvidenceFileError(f"expected 'field: value', got: {line!r}")
        key, _, value = line.partition(":")
        answers[key.strip()] = value.strip().strip('"').strip("'")
    return answers


def load_evidence_file(path: str) -> dict[str, str]:
    """Read ``field -> answer`` mappings from a .json or .yaml/.yml file."""
    file_path = Path(path)
    if not file_path.is_file():
        raise EvidenceFileError(f"evidence file not found: {path}")
    text = file_path.read_text(encoding="utf-8")
    if file_path.suffix.lower() == ".json":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise EvidenceFileError(f"invalid JSON in {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise EvidenceFileError(f"evidence JSON must be an object: {path}")
        return {str(k): str(v) for k, v in data.items() if v is not None}
    return _parse_flat_yaml(text)


def run_wizard(
    missing: list[EvidenceRequirement],
    store: StorageService,
    project_id: str,
) -> None:
    """Prompt the user for each missing field and persist the answers."""
    if not missing:
        return
    print(f"\n{len(missing)} piece(s) of information are missing:")
    answers: dict[str, str] = {}
    for req in missing:
        default = req.answer or ""
        value = questionary.text(req.label, default=default).ask()
        if value is None:
            break
        if value.strip():
            answers[req.field] = value.strip()
    store.save_evidence(project_id, answers)


def is_interactive() -> bool:
    """True when stdin is a TTY (a wizard can actually prompt)."""
    return sys.stdin is not None and sys.stdin.isatty()
