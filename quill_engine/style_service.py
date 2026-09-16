"""Service 14 — StyleService: per-section writing style profiles.

Hybrid (option C): cheap deterministic metrics computed from the section's
own source text (sentence length, passive/pronoun signals, formality,
tense) merged with one LLM-written style description per chapter, cached
in the store so the analysis call happens once per chapter, not once per
section. The merged profile is what ContextBuilder renders into the prompt.
"""

from __future__ import annotations

import logging
import re

from . import config, writing_service
from .models import EvidencePacket, PromptPackage, Section
from .storage import StorageService

logger = logging.getLogger(__name__)

_SENTENCE_RE = re.compile(r"[^.!?]+[.!?]+")
_WAS_WERE_RE = re.compile(r"\b(was|were)\s+\w+ed\b", re.IGNORECASE)
_PRONOUN_RE = re.compile(r"\b(I|we|my|our)\b", re.IGNORECASE)
_CONTRACTION_RE = re.compile(r"\b\w+'(s|t|re|ve|ll|d)\b", re.IGNORECASE)
_PAST_RE = re.compile(r"\b(was|were|did|had|carried|performed|conducted|completed)\b", re.IGNORECASE)
_PRESENT_RE = re.compile(r"\b(is|are|do|have|carry|perform|conduct|complete)\b", re.IGNORECASE)

_STYLE_SYSTEM = (
    "You are a writing-style analyst. Analyze the writing style of the "
    "provided source text and reply with ONLY a compact JSON object with "
    "keys: tone (e.g. 'formal academic'), register, sentence_rhythm, "
    "vocabulary, and any distinctive stylistic habits you observe. "
    "No prose outside the JSON."
)


def _deterministic(text: str) -> dict:
    sentences = [s.strip() for s in _SENTENCE_RE.findall(text) if s.strip()]
    words = text.split()
    if not words:
        return {}
    avg_sentence = round(sum(len(s.split()) for s in sentences) / max(1, len(sentences)), 1)
    body = f" {text} "
    passive = len(_WAS_WERE_RE.findall(body))
    pronouns = len(_PRONOUN_RE.findall(body))
    contractions = len(_CONTRACTION_RE.findall(body))
    past = len(_PAST_RE.findall(body))
    present = len(_PRESENT_RE.findall(body))
    return {
        "avg_sentence_words": avg_sentence,
        "passive_signals": passive,
        "first_person_signals": pronouns,
        "contraction_signals": contractions,
        "tense": "past" if past >= present else "present",
        "vocabulary_density": round(len(set(w.lower() for w in words)) / len(words), 2),
    }


def _chapter_key(section: Section) -> str:
    """Chapters (level 1) analyze themselves; subsections inherit the chapter id."""
    if section.level == 1:
        return section.section_id
    return section.parent_id or section.section_id


def _llm_description(
    project_id: str, section: Section, store: StorageService
) -> dict:
    """One cached LLM style-analysis call per chapter."""
    chapter_id = _chapter_key(section)
    cached = store.get_style(project_id, chapter_id)
    if cached is not None:
        return cached

    body = _section_text(section).strip()
    if not body or len(body.split()) < 30:
        return {}

    try:
        package = PromptPackage(
            system_instructions=_STYLE_SYSTEM,
            template=f"Source text:\n\n{body[:3000]}\n\nAnalyze the style now.",
            style_profile={},
            evidence=[],
            target_words=60,
        )
        text = writing_service.generate(package)
        profile = _parse_json_object(text)
    except Exception:
        logger.warning("style analysis failed for %s; using deterministic only", chapter_id)
        return {}

    if profile:
        store.save_style(project_id, chapter_id, profile)
    return profile


def _parse_json_object(text: str) -> dict:
    """Parse a JSON object from an LLM reply, tolerating minor model noise.

    Small local models frequently emit a stray character (trailing paren,
    doubled quote) or drop quotes around values, which breaks ``json.loads``.
    Fall back to extracting flat ``"key": value`` pairs line by line.
    """
    import json

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {}
    fragment = text[start : end + 1]
    try:
        data = json.loads(fragment)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        pass
    pairs = {}
    for m in re.finditer(r'^\s*"([A-Za-z_]+)"\s*:\s*(.+?)\s*,?\s*$', fragment, re.MULTILINE):
        key, value = m.group(1), m.group(2).strip().strip('"')
        if value and not value.startswith(("[", "-", "{")):
            pairs[key] = value
    return pairs


def _section_text(section: Section) -> str:
    """All text in a section's subtree (descendants included)."""
    parts = [section.description]
    for unit in section.content:
        parts.append(unit.text)
    for child in section.children:
        parts.append(_section_text(child))
    return "\n".join(p for p in parts if p)


def profile_for(
    project_id: str,
    section: Section,
    store: StorageService,
    *,
    enable_llm: bool | None = None,
) -> dict:
    """Merged style profile for ``section`` (deterministic + cached LLM)."""
    text = _section_text(section)
    profile = _deterministic(text)
    use_llm = config.STYLE_ANALYSIS_ENABLED if enable_llm is None else enable_llm
    if use_llm:
        profile.update(_llm_description(project_id, section, store))
    return profile
