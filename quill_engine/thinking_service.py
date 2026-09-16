"""Service — ThinkingLayer (Interviewer): structure -> follow-up questions.

After the document structure is extracted, a thinking model reads that
structure plus the user's task instruction and proposes follow-up
questions to refine the rewrite (which sections to focus on, tone, depth,
tables, images...). The questions are then asked interactively via
questionary and the answers merged back into the task instruction, so
both the research phase and every section generation see the user's
preferences.

Design mirrors ResearchPlanner: one small-model completion via the first
active provider, tolerant JSON parsing, and a deterministic fallback —
nothing here raises, and a failed thinking call simply skips the
interview.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from . import config, providers
from .retrieval_service import _dedupe_tokens

logger = logging.getLogger(__name__)


@dataclass
class FollowUpQuestion:
    """One follow-up question proposed by the thinking model."""

    field: str
    question: str
    kind: str = "text"  # text | select | confirm
    options: list[str] = field(default_factory=list)


@dataclass
class TemplateSection:
    """A new report section requested by the task instruction.

    ``description`` is 1-2 sentences of guidance for what the section should
    cover; it becomes the section's description, which drives the evidence
    gate and target length for a section with no source content.
    """

    title: str
    description: str = ""


def _structure_outline(sections, *, limit: int = 60) -> str:
    """Compact text outline of the extracted document structure.

    Walks the full section tree (not just top-level titles) so the
    thinking layer sees every section and subsection that will be
    generated, keeping interview questions and template proposals tied
    to the document's actual contents.
    """
    lines: list[str] = []

    def walk(nodes, depth: int = 0) -> None:
        for section in nodes:
            if len(lines) >= limit:
                return
            indent = "  " * depth
            children = len(section.children)
            lines.append(
                f"{indent}- {section.title} ({section.word_count} words, {children} subsections)"
            )
            walk(section.children, depth + 1)

    walk(sections)
    return "\n".join(lines) or "(no sections)"


_INTERVIEW_SYSTEM = (
    "You are an interview planner for a report-rewriting assistant. The "
    "user has a source document (structure below) and a task instruction. "
    "Propose follow-up questions that would refine how the document should "
    "be rewritten: which sections need the most attention, what tone/depth "
    "to use, whether to render tables or image placeholders, what to add or "
    "cut, etc.\n"
    "Return the questions as STRICT JSON only — an array of objects, no "
    "prose, no markdown fences:\n"
    '[{"field": "tone", "question": "What tone should the rewrite use?", '
    '"kind": "select", "options": ["formal", "casual"]},\n'
    ' {"field": "focus", "question": "Which sections need the most '
    'attention?", "kind": "text"}]\n'
    "Rules: questions must be specific to the structure above, never "
    "generic; at most " + str(config.INTERVIEW_MAX_QUESTIONS) + " questions; kind is \"select\" only when "
    "options are given, \"confirm\" for yes/no, else \"text\". If you "
    "cannot produce JSON, plain questions one per line, each ending in a "
    "question mark, are also acceptable."
)


_TEMPLATE_SYSTEM = (
    "You are a report-section planner. From the user's task instruction "
    "and the source document's structure below, extract the list of report "
    "sections the user explicitly asks to be included in the output. Only "
    "extract sections that are NEW — clearly requested by the instruction "
    "and NOT already present in the source document's structure. Ground "
    "every proposed section in the actual topics the source document "
    "covers or that the instruction explicitly names; never invent generic "
    "or boilerplate sections.\n"
    "Return STRICT JSON only — an array of objects, no prose, no markdown "
    'fences:\n[{"title": "Safety", "description": "Cover hazard '
    'identification and mitigation measures across the site."}]\n'
    '"description" is 1-2 sentences (at least 15 words) of what that '
    "section should cover, usable to generate the section even when the "
    "source document has no content for it.\n"
    f"At most {config.TEMPLATE_MAX_SECTIONS} sections. When the "
    "instruction requests no additional sections, return an empty array []."
)


def _complete(prompt: str, *, system: str = _INTERVIEW_SYSTEM) -> str:
    """One thinking-model completion via the first active provider (never raises)."""
    provider = next(iter(providers.active_chain()), None)
    if provider is None:
        logger.warning("thinking layer: no active LLM provider")
        return ""
    try:
        return providers.complete(
            with_default_model(provider),
            [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=1024,
            max_retries=1,
        )
    except Exception as exc:
        logger.warning("thinking layer call failed: %s", exc)
        return ""


def with_default_model(provider: providers.LLMProvider) -> providers.LLMProvider:
    """``provider`` pinned to INTERVIEW_MODEL when that override is set."""
    return providers.with_model(provider, config.INTERVIEW_MODEL)


def _parse_json_array(raw: str) -> list[dict]:
    """Parse a JSON array from the model, tolerating fences and repetition.

    Small models often repeat the array or wrap it in prose; we scan for
    the first ``[`` and decode one complete JSON value there
    (``raw_decode``), which naturally stops at the array's closing bracket
    instead of swallowing the rest of the text.
    """
    if not raw:
        return []
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    decoder = json.JSONDecoder()
    idx = text.find("[")
    while idx != -1:
        try:
            data, _ = decoder.raw_decode(text[idx:])
        except (ValueError, TypeError):
            idx = text.find("[", idx + 1)
            continue
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict)]
        idx = text.find("[", idx + 1)
    return []


def _parse_question_lines(raw: str) -> list[str]:
    """Extract one-question-per-line output (small-model fallback).

    Accepts numbered/bulleted lines; keeps only lines that look like
    questions (end in ``?``). Never raises.
    """
    if not raw:
        return []
    out: list[str] = []
    for line in raw.splitlines():
        line = line.strip().lstrip("*-0123456789. )")
        line = re.sub(r"^\d+[\.\)]\s*", "", line)
        if line.endswith("?") and line not in out:
            out.append(line)
    return out[: config.INTERVIEW_MAX_QUESTIONS]


_TEMPLATE_ITEM_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s*(.+)$", re.MULTILINE)
_TEMPLATE_BANNED = {
    "task instruction",
    "document structure",
    "structure",
    "sections",
    "list",
}


def _parse_template_lines(raw: str) -> list[str]:
    """Fallback: bulleted/numbered list items as section titles (never raises)."""
    if not raw:
        return []
    out: list[str] = []
    for match in _TEMPLATE_ITEM_RE.finditer(raw):
        title = match.group(1).strip().strip('"').strip("'").rstrip(".,:;")
        if not title or title.lower() in _TEMPLATE_BANNED or len(title) > 80:
            continue
        if title not in out:
            out.append(title)
        if len(out) >= config.TEMPLATE_MAX_SECTIONS:
            break
    return out


_DETAIL_REQUEST_RE = re.compile(
    r"(?:"
    r"i(?:'d|'ll| would| will)?\s+need\s+(?:your\s+)?"
    r"(?:actual\s+)?(?:details|input|information|info)|"
    r"here(?:'s| is)\s+what\s+(?:i|we)\s+(?:'d|'ll| would| will)?\s+need|"
    r"(?:please\s+)?provide\s+(?:me\s+with\s+)?"
    r"(?:the\s+following|your\s+(?:details|input|info)|these)|"
    r"fill\s+in\s+(?:the\s+following|your|these)|"
    r"(?:details|information|info)\s+(?:needed|required)\s+from\s+you|"
    r"i\s+need\s+from\s+you"
    r")",
    re.IGNORECASE,
)
_SECTION_HEADER_RE = re.compile(
    r"^(?:chapter\s+\d+|cover\s+page|dedication|acknowledgements?|"
    r"introduction|conclusion|references?|abstract)\b",
    re.IGNORECASE,
)
_SCANNED_QUESTION_CAP = 20


def extract_detail_requests(prompt: str) -> list[FollowUpQuestion]:
    """Collect the details the task instruction explicitly asks the user for.

    Deterministic fallback for ``build_followups``: when the prompt carries
    an explicit request signal ("I need your details… here's what I'd
    need:"), each listed item becomes a text question, so the interview
    still collects them without a thinking model. Fires ONLY on that
    signal — a prompt without one returns ``[]``. Never raises.
    """
    if not prompt or not prompt.strip():
        return []
    match = _DETAIL_REQUEST_RE.search(prompt)
    if match is None:
        return []
    body = prompt[match.start() :]
    out: list[FollowUpQuestion] = []
    seen: set[str] = set()
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        is_marked = line[:1] in ("-", "*", "•", "·") or bool(
            re.match(r"^\d+[.)]", line)
        )
        if is_marked:
            line = line.lstrip("-*•·").lstrip()
            line = re.sub(r"^\d+[.)]\s*", "", line).strip()
        if not line:
            continue
        if _DETAIL_REQUEST_RE.search(line) or _SECTION_HEADER_RE.search(line):
            continue
        if line.endswith(":"):
            continue
        if " / " in line and len(line) < 40:
            continue
        if not is_marked and line.endswith("."):
            continue
        key = line.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(FollowUpQuestion(field=f"detail{len(out) + 1}", question=line))
        if len(out) >= _SCANNED_QUESTION_CAP:
            break
    return out


def build_followups(prompt: str, sections) -> list[FollowUpQuestion]:
    """Thinking model proposes follow-up questions from structure + prompt.

    Falls back to deterministically scanning the prompt for explicitly
    requested details (``extract_detail_requests``) when the model is
    unavailable or returns nothing usable. Returns ``[]`` only when neither
    path yields questions (the caller then skips the interview). Never
    raises.
    """
    if not config.INTERVIEW_ENABLED:
        return []
    user = (
        f"TASK INSTRUCTION:\n{prompt}\n\n"
        f"DOCUMENT STRUCTURE:\n{_structure_outline(sections)}"
    )
    raw = _complete(user)
    questions: list[FollowUpQuestion] = []
    for item in _parse_json_array(raw):
        question = str(item.get("question") or "").strip()
        if not question:
            continue
        kind = str(item.get("kind") or "text").strip().lower()
        if kind not in ("text", "select", "confirm"):
            kind = "text"
        options = [
            str(o).strip()
            for o in item.get("options") or []
            if str(o).strip()
        ][:5]
        if kind == "select" and not options:
            kind = "text"
        questions.append(
            FollowUpQuestion(
                field=str(item.get("field") or f"q{len(questions)}").strip(),
                question=question,
                kind=kind,
                options=options,
            )
        )
        if len(questions) >= config.INTERVIEW_MAX_QUESTIONS:
            break

    if not questions:
        for line in _parse_question_lines(raw):
            questions.append(
                FollowUpQuestion(field=f"q{len(questions)}", question=line)
            )

    if not questions:
        questions.extend(extract_detail_requests(prompt))

    logger.info(
        "thinking layer: proposed %d follow-up question(s) for %d sections",
        len(questions),
        len(sections),
    )
    return questions


_TITLE_ANNOTATION_RE = re.compile(r"\s*\(\s*\d+\s+words?\s*,\s*\d+\s+subsections?\s*\)\s*$")
_TITLE_EMDASH_RE = re.compile(r"\s*[–—:]\s*$")


def _clean_template_title(title: str) -> str:
    """Strip outline annotations a small model may echo into a title.

    The structure outline renders titles as ``- Title (12 words, 3 subsections)``;
    a weak model can reproduce that annotation verbatim as the proposed
    title. Also drop trailing em-dash/colon separators and collapse runs of
    repeated words (e.g. "CHAPTER TWO CHAPTER TWO CHAPTER ONE").
    """
    cleaned = _TITLE_ANNOTATION_RE.sub("", title.strip())
    cleaned = _TITLE_EMDASH_RE.sub("", cleaned).strip()
    return _dedupe_tokens(cleaned)


def extract_template(prompt: str, sections=None) -> list[TemplateSection]:
    """Extract the NEW report sections the task instruction requests.

    ``sections`` (the extracted document structure) is threaded into the
    model so proposed sections stay grounded in the document's actual
    topics instead of generic boilerplate. Returns ``[]`` when the thinking
    layer is disabled or the model returns nothing usable. Never raises.
    """
    if not config.INTERVIEW_ENABLED or not prompt.strip():
        return []
    outline = _structure_outline(sections) if sections else "(no sections)"
    user = (
        f"TASK INSTRUCTION:\n{prompt}\n\n"
        f"SOURCE DOCUMENT STRUCTURE:\n{outline}"
    )
    raw = _complete(user, system=_TEMPLATE_SYSTEM)
    out: list[TemplateSection] = []
    for item in _parse_json_array(raw):
        title = _clean_template_title(str(item.get("title") or ""))
        if not title:
            continue
        out.append(
            TemplateSection(
                title=title,
                description=str(item.get("description") or "").strip(),
            )
        )
        if len(out) >= config.TEMPLATE_MAX_SECTIONS:
            break

    if not out:
        for title in _parse_template_lines(raw):
            title = _clean_template_title(title)
            if not title:
                continue
            out.append(TemplateSection(title=title))
            if len(out) >= config.TEMPLATE_MAX_SECTIONS:
                break

    logger.info("thinking layer: extracted %d template section(s)", len(out))
    return out


def parse_template_choice(answer: str, template: list[TemplateSection]) -> list[str]:
    """Resolve the user's confirmation into the template titles to add.

    ``yes``/``all``/empty -> every title; ``no``/``none`` -> ``[]``; numbers
    (``"1,3"``, ``"2"``) or exact titles select a subset. Never raises.
    """
    titles = [t.title for t in template]
    if not titles:
        return []
    text = answer.strip().strip('"').strip("'").lower()
    if not text or text in ("yes", "y", "all", "ok", "add", "add all"):
        return list(titles)
    if text in ("no", "n", "none", "skip", "cancel", "0"):
        return []
    picked: list[str] = []
    for token in re.split(r"[,;\s]+", answer.strip().strip('"').strip("'")):
        token = token.strip()
        if not token:
            continue
        if token.isdigit():
            index = int(token)
            if 1 <= index <= len(titles) and titles[index - 1] not in picked:
                picked.append(titles[index - 1])
            continue
        for title in titles:
            if title.lower() == token.lower() and title not in picked:
                picked.append(title)
    return picked


def ask_followups(questions: list[FollowUpQuestion]) -> dict[str, str]:
    """Ask the questions via questionary; returns ``{field: answer}``.

    ``confirm`` yields "yes"/"no", ``select`` yields the chosen option,
    ``text`` yields the typed answer. Empty dict when the user aborts.
    """
    import questionary

    answers: dict[str, str] = {}
    for q in questions:
        if q.kind == "confirm":
            value = questionary.confirm(q.question, default=True).ask()
            answers[q.field] = "yes" if value else "no"
        elif q.kind == "select":
            value = questionary.select(q.question, choices=q.options).ask()
            answers[q.field] = value or ""
        else:
            value = questionary.text(q.question).ask()
            answers[q.field] = (value or "").strip()
        if value is None and q.kind != "confirm":
            return answers
    return answers


def merge_answers(prompt: str, answers: dict[str, str]) -> str:
    """Append the interview answers to the task instruction as constraints.

    The merged text reads like extra user directives, so both the research
    phase and every section generation honor them. Unchanged when empty.
    """
    if not answers:
        return prompt
    constraints = "\n".join(f"- {q}: {a}" for q, a in answers.items() if a)
    if not constraints:
        return prompt
    return f"{prompt}\n\nUser preferences (follow these):\n{constraints}"
