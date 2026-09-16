"""Service 11 — RequirementService: section -> required evidence fields.

Extracts, from each section's title, the list of evidence fields the
writer is allowed to produce content for (dates, activities, locations,
...). ``present`` is decided deterministically from the section's own
source content, so the orchestrator can gate generation on coverage
instead of letting the LLM invent facts (``.agent/agent.md`` §11).
"""

from __future__ import annotations

import re

from .models import ContentUnit, EvidenceRequirement, Section

# Field -> question the questionnaire/wizard asks the user for.
FIELD_LABELS: dict[str, str] = {
    "dates": "What dates did these activities take place?",
    "activities": "Which activities were performed?",
    "locations": "Where were the activities conducted?",
    "supervisors": "Who supervised the activities?",
    "challenges": "What challenges were encountered?",
    "solutions": "How were the challenges resolved?",
    "findings": "What were the key findings or observations?",
    "recommendations": "What recommendations follow from this section?",
    "materials": "Which materials or equipment were used?",
    "tasks": "Which specific tasks were performed?",
    "content": "What should this section actually say?",
    "key_activities": "Summarize the actual activities performed.",
    "context": "What context or background belongs in this section?",
    "images": "Describe the figure/photo and what it shows.",
    "logbook": "What was recorded in the logbook for this period?",
    "artifacts": "Which deliverables, outputs, or artifacts were produced?",
}

# Title pattern -> required fields. Order matters: first match wins.
_TITLE_RULES: list[tuple[re.Pattern[str], list[str]]] = [
    (re.compile(r"logbook|activity log|daily log|work log", re.IGNORECASE), ["logbook", "dates", "activities"]),
    (re.compile(r"week", re.IGNORECASE), ["dates", "activities", "locations", "supervisors"]),
    (re.compile(r"abstract|summary|synopsis", re.IGNORECASE), ["key_activities"]),
    (re.compile(r"introduction|overview|background|objective", re.IGNORECASE), ["context"]),
    (re.compile(r"challenge|problem|difficult|issue", re.IGNORECASE), ["challenges", "solutions"]),
    (re.compile(r"conclusion|recommend", re.IGNORECASE), ["findings", "recommendations"]),
    (re.compile(r"figure|image|photo|picture", re.IGNORECASE), ["images"]),
    (re.compile(r"artifact|deliverable|prototype|demo|code|script|design|diagram|screenshot", re.IGNORECASE), ["artifacts"]),
    (re.compile(r"equipment|material|tool", re.IGNORECASE), ["materials"]),
    (re.compile(r"task|job|work", re.IGNORECASE), ["tasks", "activities"]),
]

# Deterministic presence checks, keyed by field. Fact fields (dates,
# locations, supervisors, materials, images) require a concrete marker in
# the text — the whole point of the gate is to never write a fact the
# source does not contain. Prose fields only require substantive text.
_DATE_RE = re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b", re.IGNORECASE)
_LOCATION_RE = re.compile(r"\b(at|in|located at|venues?|workshops?|depots?|labs?|laborator(?:y|ies)|sites?|offices?)\b", re.IGNORECASE)
_SUPERVISOR_RE = re.compile(r"\b(supervis(?:or|ed|ion)s?|engineers?|instructors?|mentors?|Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Engr\.?)\b", re.IGNORECASE)
_ACTIVITY_RE = re.compile(r"\b(perform(?:ed|ing|s)?|carried out|conduct(?:ed|s)?|undertook|task(?:s)?|exercise(?:s)?|practical(?:s)?|demonstration(?:s)?)\b", re.IGNORECASE)

_FACT_PRESENCE: dict[str, re.Pattern[str]] = {
    "dates": _DATE_RE,
    "locations": _LOCATION_RE,
    "supervisors": _SUPERVISOR_RE,
    "materials": re.compile(r"\b(materials?|equipment|tools?|machines?|machinery|instruments?)\b", re.IGNORECASE),
    "images": re.compile(r"!\[|image-placeholder|\[IMAGE"),
    "logbook": re.compile(r"\b(log(?:ged|book|s)?|entries?|day\s+\d+|recorded)\b", re.IGNORECASE),
    "artifacts": re.compile(r"\b(created|built|developed|designed|implemented|coded?|scripts?|submitted|attached?|deliverables?|prototypes?|dem(?:o|os))\b", re.IGNORECASE),
}

# Fields satisfied by any substantive source text (no specific marker).
_LENIENT_FIELDS = {
    "content",
    "tasks",
    "activities",
    "key_activities",
    "context",
    "challenges",
    "solutions",
    "findings",
    "recommendations",
}

_LENIENT_MIN_WORDS = 15


def requirements_for(title: str) -> list[str]:
    """The ordered list of evidence fields a section titled ``title`` needs."""
    for pattern, fields in _TITLE_RULES:
        if pattern.search(title):
            return list(fields)
    return ["content"]


def _body_text(section: Section) -> str:
    parts: list[str] = [section.description]
    for unit in section.content:
        parts.append(unit.text)
    for child in section.children:
        parts.append(_body_text(child))
    return " ".join(p for p in parts if p)


def _field_present(field: str, body: str, *, evidence: str = "") -> bool:
    """Whether ``field`` is covered by the section's source content.

    ``evidence`` (research/knowledge-graph text) counts toward lenient
    prose fields only — fact fields (dates, locations, supervisors, ...)
    still require a concrete marker in the source body, so the gate never
    lets the writer invent facts from background research.
    """
    if field in _LENIENT_FIELDS:
        text = " ".join(p for p in (body, evidence) if p)
        return len(text.split()) >= _LENIENT_MIN_WORDS
    if not body.strip():
        return False
    pattern = _FACT_PRESENCE.get(field)
    if pattern is not None:
        return bool(pattern.search(body))
    return bool(body.strip())


def build_requirements(
    section: Section,
    *,
    answers: dict[str, str] | None = None,
    evidence: str = "",
) -> list[EvidenceRequirement]:
    """Build the evidence requirements for ``section``.

    ``present`` reflects the section's own source content plus ``evidence``
    (research/knowledge-graph text) for lenient prose fields only — fact
    fields still need a concrete marker in the source body. ``answer`` is
    pre-filled from ``answers`` (evidence file / previous wizard answers).
    """
    answers = answers or {}
    body = _body_text(section)
    out: list[EvidenceRequirement] = []
    for field in requirements_for(section.title):
        out.append(
            EvidenceRequirement(
                field=field,
                label=FIELD_LABELS.get(field, field.replace("_", " ").capitalize() + "?"),
                present=_field_present(field, body, evidence=evidence),
                answer=answers.get(field, ""),
            )
        )
    return out


def satisfied(req: EvidenceRequirement) -> bool:
    """A requirement is satisfied by source content or a user answer."""
    return req.present or bool(req.answer.strip())


def missing_fields(reqs: list[EvidenceRequirement]) -> list[str]:
    """Fields that are neither present in source nor answered by the user."""
    return [req.field for req in reqs if not satisfied(req)]


def coverage(reqs: list[EvidenceRequirement]) -> float:
    """Coverage ratio in [0, 1]: satisfied requirements / total."""
    if not reqs:
        return 1.0
    return sum(1 for req in reqs if satisfied(req)) / len(reqs)
