import os
import re

from loguru import logger

from utilis.timing import timed
from components.conceptEngine import ConceptEngine
from components.PlagiarismEngine import PlagiarismEngine
from components.researchEngine import ResearchEngine
from components.sessionManager import SessionManager
from components.writingEngine import NATURAL_VOICE_STYLE, WritingEngine
from utilis.drift import detect_drift
from utilis.coverage import (
    gap_research_enabled,
    gap_research_pages_budget,
    gap_research_queries_budget,
    gap_research_rounds,
    gap_research_sections_budget,
)
from utilis.store import SqliteDatabase
from utilis.model import Agent

# A request to tidy the current document is not a request to write a new one on
# a different subject. Those prompts have no topic of their own to compare with
# the document, so the relevance gate must stand down; otherwise "format this
# and use LaTeX" is refused as an unrelated thesis request.
_FORMAT_INTENT = re.compile(
    r"\b(format|reformat|clean\s*up|cleanup|tidy|typeset|latex|proofread|"
    r"line[- ]edit|copy[- ]?edit|fix\s+(?:the\s+)?formatting)\b",
    re.IGNORECASE,
)
_NEW_SUBJECT_INTENT = re.compile(
    r"\b(write|draft|compose|generate|create|produce|expand|rewrite|"
    r"summari[sz]e|analyse|analyze|critique|review)\b",
    re.IGNORECASE,
)
# The verbs that ask for a new work. "write a thesis about X in LaTeX" mentions
# LaTeX, but it is not an edit of the open draft.
_NEW_WORK_INTENT = re.compile(
    r"\b(write|draft|compose|generate|create|produce)\b",
    re.IGNORECASE,
)


def is_format_request(text: str) -> bool:
    """True when the reader is asking to tidy an existing document.

    These requests must edit the open draft. Sending one through the normal
    WRITE path is what turned "format this and add definitions" into a new
    document about definition formatting.
    """
    return bool(_FORMAT_INTENT.search(text or ""))


# A request that points back at the open document. The verb alone is not
# enough: "rewrite the history of Rome" asks for a new subject. What makes the
# turn an edit is a document noun ("the document", "my draft"), or a pronoun
# that is not attached to some other object -- "simplify this equation" is a
# question about an equation, not an edit of the draft.
_DOCUMENT_NOUN = (
    r"(?:the|my|this|that|our)\s+(?:document|draft|text|note|notes|section|"
    r"paragraph|essay|chapter|wording|prose|writing|language|content)"
)
_BARE_OBJECT = (
    r"(?:this|that|it|above)\b"
    r"(?=\s*(?:[?.!,;:]|$|\b(?:to|for|in|so|and|but|please|now)\b))"
)
# Verbs that can only mean "change the text that is already here". A bare
# pronoun is safe with these; it is not safe with `explain` or `summarise`,
# which usually ask for an answer in the chat rather than a rewritten draft.
_TRANSFORM_VERB = (
    r"(?:rewrite|reword|rephrase|simplify|paraphrase|shorten|condense|"
    r"expand|edit|revise|proofread|format|reformat|clean\s*up|tidy|translate|make)"
)
# The gate also stands down when the reader is talking about the document in
# general ("explain the document"), because a self-referential prompt carries no
# competing subject for the relevance check to compare.
_EDIT_VERB = (
    r"(?:rewrite|reword|rephrase|simplify|paraphrase|shorten|condense|expand|"
    r"summari[sz]e|explain|clarify|edit|revise|proofread|format|reformat|"
    r"clean\s*up|tidy|translate|make)"
)
_DOCUMENT_EDIT_INTENT = re.compile(
    rf"\b{_EDIT_VERB}\b"
    r"(?:(?!\b(?:a|an|the)\s+(?:new|different)\b).){0,80}?"
    rf"\b{_DOCUMENT_NOUN}\b"
    rf"|\b{_TRANSFORM_VERB}\b"
    r"(?:(?!\b(?:a|an|the)\s+(?:new|different)\b).){0,40}?"
    rf"\b{_BARE_OBJECT}",
    re.IGNORECASE | re.DOTALL,
)
# "Rewrite in the words of a 10 year old" names no object, but the style is
# still an edit of whatever is open. Only verbs that cannot mean "produce a new
# work" are here, so "write a story in the words of a child" stays a write.
_DOCUMENT_STYLE_INTENT = re.compile(
    r"\b(?:rewrite|reword|rephrase|simplify|paraphrase)\b"
    r".{0,80}?\b(?:in\s+(?:the\s+)?words\s+of|in\s+(?:simple|plain|everyday))\b",
    re.IGNORECASE | re.DOTALL,
)
_DOCUMENT_TRANSFORM_INTENT = re.compile(
    rf"\b{_TRANSFORM_VERB}\b"
    r"(?:(?!\b(?:a|an|the)\s+(?:new|different)\b).){0,80}?"
    rf"\b(?:{_DOCUMENT_NOUN}|{_BARE_OBJECT})",
    re.IGNORECASE | re.DOTALL,
)


def is_document_edit_request(text: str) -> bool:
    """True when the reader is asking to change the open document itself.

    This is the wider form of `is_format_request`: "format this" and "rewrite
    the document in the words of a 10 year old" are both edits of the draft,
    while "rewrite the history of Rome" asks for a new subject. The write gate
    uses this form because a self-referential prompt carries no competing
    subject for the relevance check.
    """
    value = str(text or "")
    return bool(
        _DOCUMENT_EDIT_INTENT.search(value) or _DOCUMENT_STYLE_INTENT.search(value)
    )


def is_document_transform_request(text: str) -> bool:
    """True when a chat turn should edit the draft instead of answering it.

    Narrower than `is_document_edit_request`: "explain the document" is a
    question for the chat, while "rewrite this" is a write-back. Routing a
    question through FORMAT would replace the reader's document with prose they
    never asked to keep.
    """
    value = str(text or "")
    formats_existing = bool(_FORMAT_INTENT.search(value)) and not _NEW_WORK_INTENT.search(value)
    return bool(
        formats_existing
        or _DOCUMENT_TRANSFORM_INTENT.search(value)
        or _DOCUMENT_STYLE_INTENT.search(value)
    )


_QUESTION_START = re.compile(
    r"^\s*(?:did|does|do|is|are|was|were|has|have|had|can|could|would|will|"
    r"should|where|when|why|how|what|which|who|whose)\b",
    re.IGNORECASE,
)
_DOCUMENT_REFERENCE = re.compile(
    r"\b(?:it|this|that|above|"
    r"the\s+(?:document|draft|text|note|notes|section|paragraph|essay|chapter|"
    r"outline|run|generation|corpus|evidence|conclusion|introduction|abstract|"
    r"argument|wording|prose)|"
    r"my\s+(?:document|draft|text|note|notes|essay|chapter)|"
    r"you\s+(?:remove|removed|keep|kept|change|changed|delete|deleted|add|added|"
    r"write|wrote|include|included|use|used|fix|fixed|miss|missed)|"
    r"in\s+the\s+(?:document|draft|text))\b",
    re.IGNORECASE,
)
_NEW_WORK_QUESTION = re.compile(
    r"\b(?:write|draft|compose|generate|create|produce|rewrite|reword|rephrase|"
    r"simplify|expand|shorten|format|reformat|translate)\b",
    re.IGNORECASE,
)
_EXPLAIN_LEAD = re.compile(
    r"^\s*(?:explain|describe|define|summarise|summarize|compare|tell\s+me)\b",
    re.IGNORECASE,
)


def looks_like_question(text: str) -> bool:
    """True for a turn addressed to the reader's understanding, not a new work.

    The classifier can label a bare topic ("development of a ...") as EXPLAIN.
    Without this distinction an empty document gets a lecture about its own
    placeholder heading instead of a draft.
    """
    value = str(text or "").strip()
    return bool(
        value.endswith("?")
        or _QUESTION_START.search(value)
        or _EXPLAIN_LEAD.search(value)
    )


def is_document_question(text: str) -> bool:
    """True for a question about the open draft rather than a new document.

    The classifier read "did you remove the Miller effect?" as a rewrite and
    wrote a halt stub over the document. A question-shaped turn that refers to
    the draft, and carries no verb that asks for a new work, belongs in Search:
    it reads the document and answers in the chat.
    """
    value = str(text or "")
    return bool(
        _QUESTION_START.search(value)
        and _DOCUMENT_REFERENCE.search(value)
        and not _NEW_WORK_QUESTION.search(value)
    )


def _research_effort(variant: str) -> dict:
    """Research limits for the model-effort variant.

    Fast is a different budget, not just a shorter answer: one planning and
    validation pass, a handful of pages, and no questionnaire or gap rounds.
    Deep spends more time and more pages; balanced keeps the engine defaults.
    """
    effort = str(variant or "balanced").strip().lower()
    if effort == "fast":
        return {
            "max_iterations": 1,
            "pages_per_query": 2,
            "max_pages_total": 8,
            "max_question_rounds": 0,
        }
    if effort == "deep":
        return {
            "max_iterations": 4,
            "pages_per_query": 6,
            "max_pages_total": 48,
            "max_question_rounds": 1,
        }
    return {}


def _research_note(research: dict) -> str:
    """The writer's instruction for a thin corpus, or nothing."""
    if not research.get("low_research"):
        return ""
    return (
        "RESEARCH WARNING: the gathered sources were off-topic or too thin"
        " (quality"
        f" {research.get('quality', 0.0)}). Rely only on what is actually"
        " supported below. Where evidence is missing, state the uncertainty"
        " explicitly instead of inventing detail, and keep claims narrow."
    )


def _evidence_of(research: dict) -> dict:
    """The evidence numbers the write gate reads, from a research payload."""
    return {
        "corpus_chars": len(research.get("corpus") or ""),
        "relevant_pages": int(research.get("relevant_pages") or 0),
        "quality": float(research.get("quality") or 0.0),
        "page_titles": [p.get("title", "") for p in (research.get("pages") or [])],
    }


class TaskRoutingError(RuntimeError):
    """A routing failure that a caller must report, not read as an answer.

    ``route_task`` used to return ``"An error occurred: ..."`` as a plain string,
    which every consumer then had to re-detect by matching that prefix. A typed
    error makes the failure impossible to mistake for a task result and gives the
    chat layer a real reason to hand back instead of a fake reply.
    """


FORMAT_RULES = """
You are a formatting editor working on an existing document.
- Preserve every technical fact, name, number, heading, table, equation and citation.
- Do not research, add sources, change the subject, or remove technical content.
- Improve heading hierarchy, lists, spacing and consistency.
- Where the reader asks for definitions, add one concise sentence for each key
  technical term the first time it appears. Do not invent facts.
- Do not rewrite clear prose merely to change its style.
- Return Markdown only, with the document's existing title and structure.
"""


DOCUMENT_TYPE_RULES = {
    "thesis": (
        "DOCUMENT TYPE — THESIS: write as a formal thesis. Use numbered chapters "
        "and sections, a literature review, methodology, results, discussion and "
        "references. Keep a consistent academic register."
    ),
    "paper": (
        "DOCUMENT TYPE — ACADEMIC PAPER: use an abstract, related work, method, "
        "results, discussion and references. Write for a specialist reader."
    ),
    "report": (
        "DOCUMENT TYPE — REPORT: lead with a summary, then context, findings, "
        "recommendations and next steps. Prefer clear headings and concrete actions."
    ),
    "meeting": (
        "DOCUMENT TYPE — MEETING NOTES: capture attendees, agenda, decisions, "
        "open questions and action items with owners. Keep it terse and scannable."
    ),
    "essay": (
        "DOCUMENT TYPE — ESSAY: state a claim, develop it in movements, answer the "
        "strongest objection and return to the claim in a conclusion."
    ),
    "proposal": (
        "DOCUMENT TYPE — PROPOSAL: describe the problem, approach, scope, "
        "deliverables, timeline, risks and budget. Be concrete and decision-ready."
    ),
    "chapter": (
        "DOCUMENT TYPE — BOOK CHAPTER: write in scenes or movements, carry voice "
        "and continuity, and end somewhere the next chapter can begin."
    ),
}
_TYPE_HINTS = (
    ("meeting", re.compile(r"\bmeeting|minutes|agenda|attendees|action items|stand[- ]?up\b", re.I)),
    ("proposal", re.compile(r"\bproposal|statement of work|deliverables|timeline|budget\b", re.I)),
    ("report", re.compile(r"\breport|findings|recommendations|executive summary|assessment\b", re.I)),
    ("paper", re.compile(r"\bpaper|journal article|abstract|related work|peer[- ]reviewed\b", re.I)),
    ("essay", re.compile(r"\bessay|counterargument|thesis statement\b", re.I)),
    ("thesis", re.compile(r"\bthesis|dissertation|doctoral|master'?s degree|literature review|methodology\b", re.I)),
    ("chapter", re.compile(r"\bchapter|novel|scene|protagonist|narrative\b", re.I)),
)


def infer_document_type(prompt: str) -> str:
    """Infer the document type from the request, not from a control.

    The reader should not have to classify their own sentence. "Write my
    thesis", "draft the meeting minutes" and "a short report on X" each name a
    form; the first hint wins, then the open document's kind is the fallback.
    """
    text = str(prompt or "")
    for name, pattern in _TYPE_HINTS:
        if pattern.search(text):
            return name
    return ""


_KIND_TO_TYPE = {
    "thesis": "thesis",
    "paper": "paper",
    "report": "report",
    "notes": "meeting",
    "meeting": "meeting",
    "essay": "essay",
    "proposal": "proposal",
    "chapter": "chapter",
}


def document_type_style(
    document_type: str = "auto", kind: str = "", prompt: str = "",
) -> str:
    """The structural brief for the inferred document type.

    An explicit value wins; otherwise the request names the form ("a thesis",
    "meeting minutes", "a report"), and the open document's kind is the last
    fallback. No control in the chat has to ask the reader to classify it.
    """
    key = str(document_type or "auto").strip().lower()
    if key in ("", "auto"):
        key = infer_document_type(prompt) or _KIND_TO_TYPE.get(
            str(kind or "").strip().lower(), ""
        )
    return DOCUMENT_TYPE_RULES.get(key, "")


_LEAKED_CHAT = re.compile(
    r"\b(?:assistant:\s*New conversation|user:\s*(?:can|could|please|rewrite|write))\b",
    re.IGNORECASE,
)


def _strip_generated_noise(text: str) -> str:
    """Remove chat text and broken bullets a failed plan wrote into the draft."""
    blocks = re.split(r"\n{2,}", str(text or ""))
    kept = [block for block in blocks if not _LEAKED_CHAT.search(block)]
    cleaned = re.sub(r"(?m)^[ \t]*\*-[ \t]+", "- ", "\n\n".join(kept))
    return cleaned.strip()


def _format_chunks(text: str, limit: int = 12000) -> list[str]:
    """Split a long document at headings/paragraphs so one call fits the budget."""
    text = re.sub(r"\n{3,}", "\n\n", text or "").strip()
    if len(text) <= limit:
        return [text] if text else []
    sections = re.split(r"(?=^#{1,3} )", text, flags=re.M)
    chunks: list[str] = []
    current = ""
    for section in sections:
        if not section:
            continue
        if current and len(current) + len(section) > limit:
            chunks.append(current)
            current = ""
        if len(section) > limit:
            paragraphs = re.split(r"(?<=\n\n)", section)
            for paragraph in paragraphs:
                if current and len(current) + len(paragraph) > limit:
                    chunks.append(current)
                    current = ""
                current += paragraph
            continue
        current += section
    if current:
        chunks.append(current)
    return [chunk[:limit] for chunk in chunks if chunk.strip()]


class Task:
    def __init__(self, sessions: SessionManager | None = None,
                 agent: Agent | None = None, provider: dict | None = None):
        self.database = SqliteDatabase()
        self.sessions = sessions if sessions is not None else SessionManager(self.database)
        # One client for the whole task, built from the provider the caller
        # resolved. Previously every engine constructed its own from the
        # environment, so a run configured for one provider would silently answer
        # half its steps with another.
        self.agent = agent if agent is not None else Agent(provider)
        self._last_document_id = ""

    @staticmethod
    def _prompt_document_mismatch(document: dict, prompt: str, concept_mode: str) -> str:
        """Refuse to write a document about a subject it does not contain.

        The incident this closes: "Write a thesis about the Stadio dei Marmi"
        against a source document titled MOTION DETECTOR ALARM SYSTEM produced
        concept "Comprehensive Significance and Educational Impact of the
        Project" and a thesis on project-based learning. Reference mode blends
        the prompt with the document, so an unrelated pair produces a concept
        that is confidently wrong yet internally consistent - every downstream
        gate then scores it 0.699 and the run reports success.

        Checked BEFORE concept extraction, because once blending has happened
        there is nothing left to compare against: the prompt has been absorbed.
        Opt out with QUILL_ALLOW_UNRELATED_PROMPT=1, which is the right move
        when the document is meant only as a style/structure template.
        """
        if os.environ.get("QUILL_ALLOW_UNRELATED_PROMPT", "").strip().lower() in (
            "1", "true", "yes",
        ):
            return ""
        # "can u format this and use latex" carries no competing subject; the
        # gate exists for prompts that ask for one. Only a formatting or
        # document-edit request without a write verb stands down, so "write a
        # thesis about X, in LaTeX" is still checked.
        if is_document_edit_request(prompt) or (
            _FORMAT_INTENT.search(prompt) and not _NEW_SUBJECT_INTENT.search(prompt)
        ):
            logger.info("prompt/document relevance check skipped: document edit request")
            return ""
        floor = 0.0
        try:
            from utilis.embeddings import Embedder

            title = str(document.get("title") or "")
            body = " ".join(
                str(s.get("text") or s.get("concept") or s.get("title") or "")
                for s in (document.get("sections") or [])
            )[:4000]
            probe = f"{title} {body}".strip()
            if not prompt.strip() or len(probe.split()) < 20:
                # Too little document to judge; never block on absent evidence.
                return ""
            embedder = Embedder.get()
            raw = embedder.similarity(
                embedder.embed_one(prompt[:2000]), embedder.embed_one(probe)
            )
            # Raw similarity between two English sentences is never near zero,
            # so an absolute bar is meaningless: measured against THIS document
            # and this embedder, on-topic prompts score 0.653-0.711 and unrelated
            # ones 0.467-0.540. Normalising against the same neutral reference
            # `ResearchEngine.assess` uses separates them cleanly.
            reference = (
                "This is a general reference sentence used to estimate the "
                "similarity floor between two unrelated English passages written "
                "about any subject."
            )
            floor = embedder.similarity(embedder.embed_one(reference), embedder.embed_one(probe))
            floor = max(0.0, min(floor, 0.95))
            score = (raw - floor) / max(1e-6, 1.0 - floor)
        except Exception as exc:  # noqa: BLE001 - a failed check must not block a run
            logger.warning("prompt/document relevance check skipped: {}", exc)
            return ""

        # Midpoint of the measured gap: the four on-topic TEST_PROMPTS normalised
        # to 0.319-0.432 and the four off-topic ones to -0.046-0.097.
        threshold = 0.21
        if score < threshold:
            logger.warning(
                "prompt/document mismatch: score={:.3f} < {:.2f} (raw={:.3f} "
                "floor={:.3f}) prompt={!r} document={!r} - refusing to write "
                "about a subject the document does not contain",
                score, threshold, raw, floor, prompt[:120], title[:120],
            )
            return (
                f"Prompt and source document are unrelated (score {score:.3f} < "
                f"{threshold}). The document is titled {title[:120]!r}, which does not "
                "cover the requested subject. Refusing to write a thesis about "
                "something the document does not contain. Pass a document on-topic "
                "for the prompt, or set QUILL_ALLOW_UNRELATED_PROMPT=1 to use this "
                "document as a structure template only."
            )
        logger.info("prompt/document relevance: similarity={:.3f}", score)
        return ""

    def _survey_guard(self, document: dict, concept_mode: str) -> str:
        """Block an accidental survey run on a large document.

        Survey extracts an LLM concept for *every* section, so cost scales with
        document size (~12.5M tokens on a 10k-page document). It is an explicit
        opt-in, so it refuses to start past the section limit unless the caller
        also passes --survey-force.
        """
        from components.conceptEngine import _SURVEY_SECTION_LIMIT

        if os.environ.get("SURVEY_FORCE", "").strip().lower() in ("1", "true", "yes"):
            return ""
        sections = ConceptEngine(agent=self.agent)._flatten(document.get("sections", []))
        total = len(sections)
        if total <= _SURVEY_SECTION_LIMIT:
            return ""
        est_k = int(total * 900 / 1000)
        est_days = est_k / 500.0
        return (
            f"Refusing survey mode: {total} sections exceeds the limit of "
            f"{_SURVEY_SECTION_LIMIT}. Survey extracts a concept per section "
            f"(~{est_k}k tokens, ~{est_days:.1f} daily budgets at 500k/day). "
            f"Re-run with --survey-force if that is intended, or use the default "
            f"reference mode."
        )

    @staticmethod
    def _source_plan(document: dict, prompt: str = "") -> dict:
        """A writing plan built from the headings the reader already has.

        The planner used to invent a fresh outline every time, which is why a
        meeting-notes template came back as "Introduction / Historical
        background / Mechanisms of change": useful prose, but not the document
        the reader asked to fill. When the draft has two or more real headings,
        those headings become the plan, in order, and the writer writes under
        them. Placeholder headings ("New section", "Section 2") are ignored so a
        blank template still lets the planner do its job.
        """
        placeholder = re.compile(
            r"^(new section|section\s*\d+|untitled(\s+.*)?|heading\s*\d+)$",
            re.IGNORECASE,
        )

        def text_of(section: dict) -> str:
            parts: list[str] = []
            for block in section.get("blocks") or []:
                if isinstance(block, dict):
                    value = block.get("content")
                else:
                    value = block
                if value:
                    parts.append(str(value).strip())
            return " ".join(part for part in parts if part).strip()

        def node(section: dict, level: int) -> dict | None:
            title = str(section.get("title") or "").strip()
            if not title or placeholder.match(title) or title.lower() == "preamble":
                return None
            body = text_of(section)
            # A real sentence is a better claim than a generic one; a short
            # template cue ("Name — role") is not, so the prompt carries the
            # subject instead.
            if len(body) >= 40:
                claim = " ".join(body.split())[:240]
            else:
                ask = " ".join(str(prompt or "").split())[:220]
                claim = f"Write {title} for: {ask}".strip()
            entry: dict = {"title": title, "claim": claim}
            children = [node(child, level + 1) for child in section.get("children") or []]
            children = [child for child in children if child]
            if children:
                entry["chapters" if level == 1 else "subsections"] = children
            return entry

        sections = [node(section, 1) for section in document.get("sections") or []]
        sections = [section for section in sections if section]
        if len(sections) < 2:
            return {}
        return {"sections": sections}

    @timed("Task.Write")
    def Write(
        self, prompt: str, document_id: str, session_name: str = "",
        concept_mode: str = "reference", token_saving: bool = False,
        natural_voice: bool = False, writing_profile: str = "",
        variant: str = "balanced", on_draft=None, document_type: str = "auto",
    ):
        document = self.database.get(document_id) or {}
        if not document:
            return {"error": f"No parsed document found for id {document_id}"}
        document["unique_id"] = document_id
        self._last_document_id = document_id

        session = self.sessions.create(prompt, document_id, session_name)
        if concept_mode == "survey":
            guard = self._survey_guard(document, concept_mode)
            if guard:
                return {"error": guard, "blocked": "survey_limit"}

        mismatch = self._prompt_document_mismatch(document, prompt, concept_mode)
        if mismatch:
            return {
                "error": mismatch,
                "blocked": "prompt_document_mismatch",
                "session_id": session["id"],
                "session_name": session["name"],
            }

        concept = ConceptEngine(
            agent=self.agent,
            concept_mode=concept_mode,
        ).run(document, prompt_hint=prompt)
        research_engine = ResearchEngine(
            agent=self.agent, **_research_effort(variant)
        )
        research = research_engine.run(concept["concept"], document_id, prompt=prompt)
        plan = WritingEngine(model=self.agent).planner(concept["concept"])
        # The reader's own headings win over the planner's invented ones. This
        # is the difference between filling in a document and replacing it.
        source_plan = self._source_plan(document, prompt)
        if source_plan:
            plan = source_plan
            logger.info(
                "writing against source structure: {} section(s)",
                len(source_plan.get("sections") or []),
            )
        context = (
            f"{concept['concept']}\n\nRESEARCH:\n{research['corpus']}"
            if research.get("corpus")
            else concept["concept"]
        )
        research_note = _research_note(research)
        evidence = _evidence_of(research)
        style_parts = []
        type_style = document_type_style(document_type, str(document.get("kind") or ""), prompt)
        if type_style:
            style_parts.append(type_style)
        if natural_voice:
            style_parts.append(NATURAL_VOICE_STYLE)
        if writing_profile.strip():
            style_parts.append(writing_profile.strip())
        writer = WritingEngine(
            model=self.agent,
            style="\n".join(style_parts),
        )
        written = writer.writer(
            plan, context, research_note, evidence=evidence, on_draft=on_draft,
        )

        gap = None
        if gap_research_enabled() and not token_saving and str(variant).lower() != "fast":
            reports = []
            for _round in range(gap_research_rounds()):
                result = self._close_research_gaps(
                    writer, research_engine, research, concept["concept"], prompt
                )
                reports.append(result["report"])
                if result.get("document") is None:
                    break
                written = result["document"]
                research = result["research"]
                research_note = result["research_note"]
            if reports:
                gap = {
                    "rounds": len(reports),
                    "queries": [
                        query
                        for report in reports
                        for query in (report.get("queries") or [])
                    ],
                    "pages_added": sum(
                        int(report.get("pages_added") or 0) for report in reports
                    ),
                    "rewritten": sorted({
                        title
                        for report in reports
                        for title in (report.get("rewritten") or [])
                    }),
                    "still_placeholder": reports[-1].get("still_placeholder", []),
                    "skipped": reports[-1].get("skipped", ""),
                    "reports": reports,
                }

        plagiarism = PlagiarismEngine(agent=self.agent).run(
            written,
            sources=[concept["concept"], research["corpus"]] if research.get("corpus") else [concept["concept"]],
            unique_id=document_id,
        )

        payload = {
            "unique_id": document_id,
            "session_id": session["id"],
            "session_name": session["name"],
            "title": document.get("title", ""),
            "markdown": written,
            "concept": concept["concept"],
            "research": research["summary"],
            "research_pages": research.get("pages") or [],
            "research_corpus": research.get("corpus") or "",
            "research_quality": research.get("quality", 0.0),
            "research_relevant_pages": research.get("relevant_pages", 0),
            "low_research": bool(research.get("low_research")),
            "write_gate": writer.last_gate,
            "source_structure": [
                str(section.get("title") or "")
                for section in (source_plan.get("sections") or [])
            ] if source_plan else [],
            "plagiarism": plagiarism,
            "gap_research": gap,
        }
        self.database.set(f"written:{document_id}", payload)
        self.sessions.save(payload, session["id"])
        return payload

    @staticmethod
    def _section_research_needs(research_engine, sections, concept) -> dict:
        """Ask what must be known to write each failing section, as search queries.

        This is the pre-write step the placeholder is asking for: before
        rewriting "3.2 Influence of the 1962 Rome Olympic bid on local planning",
        work out what a reader would need - the bid itself, the planning
        decision it drove, the reaction - and research those, rather than
        guessing from word overlap with a corpus that may be about something
        else entirely.
        """
        if not sections:
            return {"queries": [], "needs": []}
        listed = "\n".join(
            f"{i}. TITLE: {s.get('title', '')}\n   THIS SECTION MUST ESTABLISH: "
            f"{s.get('claim', '') or '(none recorded)'}"
            for i, s in enumerate(sections, 1)
        )
        prompt = (
            f"SUBJECT: {concept}\n\n"
            "These sections of a thesis could not be written from the evidence "
            "gathered so far:\n" + listed + "\n\n"
            "For each, list what a researcher would need to find in order to "
            "write it: the specific facts, decisions, dates, actors or "
            "arguments that section must establish. Do not write the section.\n"
            "Respond with JSON only:\n"
            '{"needs": [{"section": "<title>", "must_establish": ["<fact>", "<fact>"]}]}'
        )
        parsed = research_engine._parse_json_like(research_engine.agent.model(prompt))
        needs = parsed.get("needs") if isinstance(parsed, dict) else None
        queries: list[str] = []
        clean: list[dict] = []
        for entry in needs or []:
            if not isinstance(entry, dict):
                continue
            facts = [str(f).strip() for f in (entry.get("must_establish") or []) if str(f).strip()]
            if not facts:
                continue
            clean.append({"section": entry.get("section", ""), "must_establish": facts})
            for fact in facts:
                # A fact plus the subject is a better query than the bare fact,
                # which is often too generic to retrieve anything.
                query = f"{fact} {concept}".strip()
                if query not in queries:
                    queries.append(query)
        return {"queries": queries, "needs": clean}

    def _close_research_gaps(
        self,
        writer: WritingEngine,
        research_engine: ResearchEngine,
        research: dict,
        concept: str,
        prompt: str = "",
    ) -> dict:
        """One budgeted research round for the sections that came back empty.

        Exactly one round, for the whole document, ever: the sections are merged
        into a single term list and a single set of queries. Ten failing
        sections must not become ten searches - the cost of this loop is
        bounded by the ceilings in ``utilis.coverage``, not by how badly the run
        went.

        Returns ``{"document": ...}`` where ``document`` is ``None`` when
        nothing should change, so the caller can leave the first-pass document
        exactly as it was.
        """
        report = {"rounds": 0, "queries": [], "pages_added": 0,
                  "rewritten": [], "skipped": ""}
        failed = [s for s in writer.last_sections if s.get("status") != "written"]
        if not failed:
            report["skipped"] = "every section was written"
            return {"document": None, "report": report}

        corpus = research.get("corpus") or ""
        budget = gap_research_sections_budget()
        targets = failed[:budget]

        # What to research is the section's own REQUIREMENTS, not the words it
        # happens to be missing. The earlier design searched for terms absent
        # from the corpus, which is inverted: measured against a real run,
        # placeholder sections averaged 2.86 such terms and written ones 3.00,
        # so "absent term" selects the sections that already succeeded. Asking
        # what must be known to write the section is independent of that and is
        # the question a researcher would actually ask.
        needs = self._section_research_needs(research_engine, targets, concept)
        terms = needs["queries"]
        if not targets or not terms:
            report["skipped"] = (
                f"{len(failed)} placeholder section(s), but none yielded a "
                "searchable requirement; nothing to research"
            )
            return {"document": None, "report": report}

        round_result = research_engine.targeted_research(
            terms,
            entity=concept,
            limit=gap_research_queries_budget(),
            page_cap=gap_research_pages_budget(),
            seen_urls=[p.get("url") for p in (research.get("pages") or [])],
        )
        report.update({
            "rounds": 1,
            "queries": round_result["queries"],
            "terms": round_result["terms"],
            "pages_added": len(round_result["pages"]),
            "skipped": round_result["skipped"],
            "sections_considered": len(failed),
            "sections_targeted": len(targets),
            "section_budget": budget,
        })
        new_pages = round_result["pages"]
        if not new_pages:
            logger.info(
                "gap research: {} quer(y/ies) for {} section(s) returned no pages; "
                "keeping the first-pass document",
                len(round_result["queries"]), len(targets),
            )
            return {"document": None, "report": report}

        merged_pages = list(research_engine.last_pages or []) + new_pages
        # Make the merge cumulative. A second gap round must assess the corpus
        # produced by the first, not fall back to the original page list.
        research_engine.last_pages = merged_pages
        merged_corpus = research_engine.corpus_from_pages(new_pages)
        if corpus:
            merged_corpus = f"{corpus}\n\n{merged_corpus}"
        assessment = research_engine.assess(concept, merged_pages)
        # The new pages can be off-topic, and the writer grounds sections in
        # whatever the corpus says. Same additive check run() already applies to
        # the first corpus, reported and never used to block.
        merged_drift = detect_drift(concept, prompt, merged_corpus, merged_pages)
        report["merged_drift"] = merged_drift.get("drift_detected")
        report["merged_drift_signal"] = merged_drift.get("signal")
        if merged_drift.get("drift_detected"):
            logger.warning(
                "gap research: merged corpus shows DRIFT ({}) for {!r}; the "
                "re-written sections are grounded in it anyway",
                merged_drift.get("signal"), concept[:80],
            )
        merged = dict(research)
        merged.update({
            "pages": [
                {
                    "level": p["level"], "query": p["query"], "title": p["title"],
                    "url": p["url"], "snippet": p["snippet"], "chars": len(p["text"]),
                }
                for p in merged_pages
            ],
            "corpus": merged_corpus,
            "quality": assessment["quality"],
            "relevant_pages": assessment["relevant_pages"],
            "low_research": ResearchEngine._needs_rescue(
                assessment, research_engine.min_research_quality
            ),
        })
        merged_note = _research_note(merged)

        rewritten = writer.rewrite_sections(
            f"{concept}\n\nRESEARCH:\n{merged_corpus}" if merged_corpus else concept,
            targets,
            merged_note,
            evidence=_evidence_of(merged),
        )
        # Keep the writer's own record in step with the splice. A second gap
        # round reads `last_sections` to decide what is still a placeholder;
        # leaving the first-pass outcome there would re-target the sections
        # that just succeeded and silently ignore the ones that did not.
        for index, section in enumerate(writer.last_sections):
            key = writer._normalise(section.get("title") or section.get("claim"))
            outcome = rewritten["outcomes"].get(key)
            if outcome:
                writer.last_sections[index] = {**section, **outcome}
        replacements = {
            key: outcome["block"]
            for key, outcome in rewritten["outcomes"].items()
            if outcome["status"] == "written" and outcome.get("block")
        }
        report["rewritten"] = sorted(
            o["title"] for o in rewritten["outcomes"].values() if o["status"] == "written"
        )
        report["still_placeholder"] = sorted(
            o["title"] for o in rewritten["outcomes"].values() if o["status"] != "written"
        )
        report["merged_evidence"] = _evidence_of(merged)
        if not replacements:
            logger.info(
                "gap research: merged corpus did not make any of the {} failed "
                "section(s) writable; keeping the first-pass document",
                len(targets),
            )
            return {"document": None, "report": report, "research": merged}

        logger.info(
            "gap research: 1 round, {} quer(y/ies), {} page(s) added, "
            "{}/{} targeted section(s) re-written: {}",
            len(round_result["queries"]), len(new_pages), len(replacements),
            len(targets), report["rewritten"],
        )
        return {
            "document": writer.splice_document(replacements),
            "report": report,
            "research": merged,
            "research_note": merged_note,
        }

    @timed("Task.new_session")
    def new_session(self, prompt: str, document_id: str = "", name: str = "") -> dict:
        """Start a named session without running the pipeline."""
        return self.sessions.create(prompt, document_id, name)

    @timed("Task.rename_session")
    def rename_session(self, name: str, session_id: str = "") -> dict:
        """Rename a session; future saves use the new name."""
        return self.sessions.rename(name, session_id)

    @timed("Task.list_sessions")
    def list_sessions(self) -> list[dict]:
        return self.sessions.list()

    @timed("Task.current_session")
    def current_session(self) -> dict:
        return self.sessions.current()

    @timed("Task.Format")
    def Format(
        self, prompt: str, document_id: str = "", on_draft=None,
        document_type: str = "auto",
    ):
        """Format the existing document, in place, without research.

        This is deliberately separate from Write: a formatting request has no
        new subject, so the concept planner and web research must not run.
        """
        document_id = document_id or self._last_document_id
        document = self.database.get(document_id) or {}
        text = _strip_generated_noise(str(document.get("markdown") or ""))
        if not text:
            return {"error": "No document to format. Open a document first."}
        if "Generation Halted" in text or "THIS RUN PRODUCED NO CONTENT" in text:
            return {
                "error": (
                    "This document is a generation stub, not a draft: it contains "
                    "the 'Generation Halted' notice. Restore a previous version or "
                    "rewrite it from its source; formatting the stub would only "
                    "preserve the notice."
                )
            }
        chunks = _format_chunks(text)
        outputs: list[str] = []
        for index, chunk in enumerate(chunks, start=1):
            part_note = (
                f"\nThis is part {index} of {len(chunks)} of a larger document. "
                "Do not add a document title that is not already in this part."
                if len(chunks) > 1 else ""
            )
            type_style = document_type_style(
                document_type, str(document.get("kind") or ""), prompt
            )
            body = self.agent.Quill(
                f"REQUEST: {prompt}\n{type_style}\n{part_note}\nDOCUMENT:\n{chunk}",
                skill=FORMAT_RULES,
            ) or ""
            body = body.strip()
            if body.startswith("```"):
                body = re.sub(r"^```(?:markdown)?\s*", "", body)
                body = re.sub(r"\s*```$", "", body).strip()
            if body:
                outputs.append(body)
                if on_draft is not None:
                    try:
                        on_draft("\n\n".join(outputs).strip())
                    except Exception:
                        logger.debug("live format sink failed", exc_info=True)
        formatted = "\n\n".join(outputs).strip()
        if not formatted:
            return {"error": "The formatting pass returned no document."}
        payload = {
            "unique_id": document_id,
            "title": document.get("title", ""),
            "markdown": formatted,
            "research_pages": [],
            "write_gate": {"written": 1, "placeholder": 0, "retried": 0},
        }
        self.database.set(f"written:{document_id}", payload)
        return payload

    @timed("Task.ReWrite")
    def ReWrite(
        self, prompt: str, document_id: str = "", natural_voice: bool = False,
        writing_profile: str = "", on_draft=None, document_type: str = "auto",
    ):
        document_id = document_id or self._last_document_id
        if not document_id:
            return {"error": "No document to rewrite. Run WRITE first."}
        existing = self.database.get(f"written:{document_id}") or {}
        document = self.database.get(document_id) or {}
        concept = self.database.get(f"concept:{document_id}") or {}
        research = self.database.get(f"research:{document_id}") or {}

        prompt_text = concept.get("concept") or document.get("title") or prompt
        plan = WritingEngine(model=self.agent).planner(f"{prompt_text}\n\nRewrite guidance: {prompt}")
        # A rewrite of a template is still a fill of that template. Without
        # this the planner invents a new outline and the reader's headings --
        # Attendees / Decisions / Action items -- disappear on the rewrite.
        source_plan = self._source_plan(document, prompt)
        if source_plan:
            plan = source_plan
        # A rewrite is grounded in the document it rewrites. The web corpus, if
        # there is one, is extra context -- never the thing that decides whether
        # the rewrite may run. Passing only the corpus made "rewrite this in
        # simpler words" halt with "insufficient research" while the source
        # text sat unused in the same row.
        source_text = _strip_generated_noise(
            str(existing.get("markdown") or document.get("markdown") or "")
        )
        web_corpus = str(research.get("corpus") or "").strip()
        corpus = "\n\n".join(part for part in (source_text, web_corpus) if part)
        context = f"{prompt_text}\n\nRESEARCH:\n{corpus}" if corpus else prompt_text
        evidence = {
            "corpus_chars": len(corpus),
            "relevant_pages": max(
                int(research.get("relevant_pages") or 0), 1 if source_text else 0
            ),
            "quality": float(research.get("quality") or 0.0),
            "page_titles": [p.get("title", "") for p in (research.get("pages") or [])],
            "source_grounded": bool(source_text),
        }
        style_parts = []
        type_style = document_type_style(document_type, str(document.get("kind") or ""), prompt)
        if type_style:
            style_parts.append(type_style)
        if natural_voice:
            style_parts.append(NATURAL_VOICE_STYLE)
        if writing_profile.strip():
            style_parts.append(writing_profile.strip())
        writer = WritingEngine(
            model=self.agent,
            style="\n".join(style_parts),
        )
        written = writer.writer(plan, context, evidence=evidence, on_draft=on_draft)
        plagiarism = PlagiarismEngine(agent=self.agent).run(
            written,
            sources=[prompt_text, research.get("corpus", "")] if research.get("corpus") else [prompt_text],
            unique_id=document_id,
        )

        payload = {
            "unique_id": document_id,
            "title": existing.get("title") or document.get("title", ""),
            "markdown": written,
            "concept": prompt_text,
            "research": research.get("summary", ""),
            "source_structure": [
                str(section.get("title") or "")
                for section in (source_plan.get("sections") or [])
            ] if source_plan else [],
            "write_gate": getattr(writer, "last_gate", {}) or {},
            "plagiarism": plagiarism,
        }
        self.database.set(f"written:{document_id}", payload)
        return payload

    @timed("Task.Research")
    def Research(self, prompt: str, variant: str = "balanced"):
        payload = ResearchEngine(
            agent=self.agent, **_research_effort(variant)
        ).run(prompt, prompt=prompt)
        return payload

    @timed("Task.Critique")
    def Critique(self, prompt: str, document_id: str = ""):
        document_id = document_id or self._last_document_id
        if not document_id:
            return {"error": "No document to critique. Run WRITE first."}
        written = self.database.get(f"written:{document_id}") or {}
        research = self.database.get(f"research:{document_id}") or {}
        document = self.database.get(document_id) or {}

        warden = self.agent.Warden(research.get("corpus", "") or document.get("markdown", ""), written.get("markdown", ""))
        critique = self.agent.Oracle(
            f"Critique this document critically against its concept.\n\n"
            f"CONCEPT:\n{written.get('concept', '')}\n\nDOCUMENT:\n{written.get('markdown', '')[:3000]}"
        )
        payload = {
            "unique_id": document_id,
            "issues": warden.get("issues", []) if isinstance(warden, dict) else [],
            "warden_status": warden.get("status", "") if isinstance(warden, dict) else str(warden),
            "critique": critique if isinstance(critique, dict) else {"thoughts": str(critique)},
        }
        self.database.set(f"critique:{document_id}", payload)
        return payload

    @timed("Task.Search")
    def Search(self, prompt: str, context: str = ""):
        """Answer a question about the open document, not the web.

        The whole draft is searched; the model only sees the passages that
        matched. A structural question -- a halt stub, an outline, a broken
        section -- is answered deterministically, because those answers must be
        exact and a model must not invent a cause.
        """
        from components.documentSearch import (
            audit_document,
            is_structural_question,
            is_yes_no_question,
            render_audit,
            render_no_hits,
            render_presence,
            search_document,
        )

        text = (context or "").strip()
        if not text:
            return {"error": "No document to search. Open a document first."}

        found = search_document(text, prompt)
        audit = audit_document(text)

        # A reader often pastes the halt stub into the chat instead of leaving
        # it in the draft. Audit that copy too, or the answer would describe a
        # healthy document while the evidence of the failure sits in the prompt.
        if not audit.get("gate"):
            pasted = audit_document(prompt)
            if pasted.get("halted") or pasted.get("gate"):
                audit = pasted

        if is_structural_question(prompt) or audit.get("halted"):
            return {"answer": render_audit(audit, prompt, found), "sources": []}

        if not found["has_evidence"]:
            return {"answer": render_no_hits(found, audit), "sources": []}

        if is_yes_no_question(prompt) and found.get("missing"):
            missing = ", ".join(f"“{term}”" for term in found["missing"])
            lines = [f"The current draft does not contain {missing}."]
            if found["hits"]:
                lines.extend(["", "**Related passages it does contain**", ""])
                for hit in found["hits"]:
                    where = hit.get("heading") or "top of document"
                    lines.append(f"- **{where}** (line {hit['line']}): {hit['text']}")
            return {"answer": "\n".join(lines), "sources": []}

        evidence = "\n".join(
            f"[{hit.get('heading') or 'top of document'}, line {hit['line']}] {hit['text']}"
            for hit in found["hits"]
        )
        audit_note = render_audit(audit) if audit.get("issues") else ""
        if len(audit_note) > 1800:
            audit_note = audit_note[:1800] + "…"
        answer = self.agent.model(
            f"QUESTION: {prompt}\n\n"
            f"{audit_note}\n\n"
            "EXCERPTS FROM THE OPEN DOCUMENT:\n"
            f"{evidence}\n\n"
            "Answer only from these excerpts. Name the heading and line for each "
            "fact. If the term is still present, say so plainly; if it is absent, "
            "say that instead of guessing.",
            system_prompt=(
                "You answer questions about one document using only the excerpts "
                "you are given."
            ),
        ) or ""
        answer = str(answer).strip()
        presence = render_presence(found)
        if not answer:
            lines = [presence, "", "**Matching passages**", ""]
            for hit in found["hits"]:
                where = hit.get("heading") or "top of document"
                lines.append(f"- **{where}** (line {hit['line']}): {hit['text']}")
            return {"answer": "\n".join(lines), "sources": []}
        return {"answer": f"{presence}\n\n{answer}".strip(), "sources": []}

    @timed("Task.SmallTalk")
    def SmallTalk(self, prompt: str):
        return self.agent.model(prompt)

    @timed("Task.Explain")
    def Explain(self, prompt: str, context: str = ""):
        """Explain the open draft when one exists, not the whole web.

        The log that motivated this passed the entire chat transcript --
        including "hey" and a variant instruction -- to ResearchEngine. The
        planner treated "Can I Help" as the subject, searched for it, and built
        a 39k-token prompt that could never fit the 6k TPM budget. A document
        question should use the document; research is only the fallback.
        """
        context = (context or "").strip()
        if context:
            source = context[:12000]
            answer = self.agent.model(
                f"QUESTION: {prompt}\n\n"
                "Explain the document below to the reader. Use only what it "
                "contains; say when something is not in it.\n\n"
                f"DOCUMENT:\n{source}",
                system_prompt="You give concise, well-grounded explanations.",
            )
            return {"answer": answer, "research": {"summary": "", "pages": [], "corpus": ""}}

        payload = ResearchEngine(agent=self.agent).run(prompt, prompt=prompt)
        corpus = str(payload.get("corpus") or "")[:12000]
        answer = self.agent.model(
            f"QUESTION: {prompt}\n\nExplain using only the research below.\n\nRESEARCH:\n{corpus}",
            system_prompt="You give concise, well-grounded explanations.",
        )
        return {"answer": answer, "research": payload}


# The classifier is a second model, not an enum. A small local model answers
# "development of a ..." with "DEVELOPMENT" instead of one of the six labels,
# and the old dispatch raised "unsupported task type" after the research had
# already run. The label is advice: map the obvious synonyms, then read the
# request itself and default to WRITE, which is what this app is for.
_TASK_TYPE_GROUPS = {
    "WRITE": (
        "WRITE", "WRITING", "DRAFT", "GENERATE", "CREATE", "COMPOSE",
        "DEVELOP", "DEVELOPMENT", "BUILD", "IMPLEMENT", "IMPLEMENTATION",
        "DESIGN", "PLAN", "PROPOSAL", "DOCUMENT", "DOCUMENTATION",
        "REPORT", "ESSAY", "ARTICLE", "THESIS", "DISSERTATION", "PAPER",
    ),
    "REWRITE": (
        "REWRITE", "EDIT", "REVISE", "REVISION", "IMPROVE", "REWORD",
        "PARAPHRASE", "SHORTEN", "EXPAND", "FORMAT", "FORMATTING",
    ),
    "RESEARCH": (
        "RESEARCH", "INVESTIGATE", "INVESTIGATION", "STUDY", "SURVEY",
        "GATHER", "COLLECT",
    ),
    "CRITIQUE": (
        "CRITIQUE", "ANALYZE", "ANALYSIS", "ANALYSE", "EVALUATE",
        "EVALUATION", "REVIEW", "ASSESS", "ASSESSMENT",
    ),
    "EXPLAIN": (
        "EXPLAIN", "EXPLANATION", "TEACH", "DEFINE", "DEFINITION",
        "DESCRIBE", "DESCRIPTION", "SUMMARIZE", "SUMMARY",
    ),
    "SMALLTALK": ("SMALLTALK", "CHAT", "GREETING", "GREET", "HELLO"),
    "SEARCH": ("SEARCH", "LOOKUP", "FIND", "QUESTION", "ASK", "QA", "QUERY"),
}
_TASK_ALIASES = {
    alias: canonical
    for canonical, aliases in _TASK_TYPE_GROUPS.items()
    for alias in aliases
}


def normalize_task_type(
    value: object,
    task: str = "",
    *,
    has_draft: bool = False,
    allow_search: bool = True,
) -> str:
    """Resolve the classifier's answer to a task the dispatcher can run.

    A label the model invents ("DEVELOPMENT" for a prompt that starts with
    "development of a ...") used to end the run with ``unsupported task type``.
    The request itself is the better evidence: a request about this draft is a
    rewrite, a question is an explanation, and everything else is writing.
    """
    token = re.sub(r"[^A-Z0-9]+", "_", str(value or "").strip().upper()).strip("_")
    resolved = _TASK_ALIASES.get(token)
    if resolved is None and token:
        resolved = _TASK_ALIASES.get(token.split("_", 1)[0])
    if resolved is None:
        text = (task or "").strip()
        lower = text.lower()
        if has_draft and re.search(
            r"\b(this|the|my)\s+(draft|document|section|essay|text|chapter)\b",
            lower,
        ):
            resolved = "REWRITE"
        elif re.search(
            r"\b(what|why|how|when|where|who|which|explain|define)\b", lower
        ) or text.rstrip().endswith("?"):
            resolved = "EXPLAIN"
        else:
            resolved = "WRITE"
        logger.warning(
            "task router: {!r} is not a task label; using {}", value, resolved
        )
    if resolved == "SEARCH" and not allow_search:
        return "RESEARCH"
    if (
        resolved in ("EXPLAIN", "CRITIQUE", "REWRITE")
        and not has_draft
        and not looks_like_question(task)
    ):
        logger.warning(
            "task router: {!r} needs a draft; using WRITE for {!r}",
            resolved, str(task or "")[:80],
        )
        resolved = "WRITE"
    return resolved


class TaskRouter:
    def __init__(self, provider: dict | None = None):
        self.agent = Agent(provider)
        self.concept_mode = "reference"
        self.task_executor = Task(agent=self.agent)

    @timed("TaskRouter.route_task")
    def route_task(
        self, task: str, document_id: str = "", session_name: str = "",
        concept_mode: str = "reference",
    ):
        self.concept_mode = concept_mode
        try:
            response = self.agent.Nous(task)

            # ``Nous`` returns the raw response on a JSON decode failure, so
            # ``response.task`` would raise AttributeError on a bare string. That
            # is a classification failure, and naming it as one beats letting an
            # AttributeError surface as "an error occurred".
            if not hasattr(response, "task"):
                raise TaskRoutingError(
                    "classifier returned no task type"
                    f" (got {type(response).__name__})"
                )

            task_type = normalize_task_type(
                response.task, task,
                has_draft=bool(document_id),
                allow_search=False,
            )
            match task_type:
                case "WRITE":
                    print(f"Executing WRITE task: {task}")
                    return self.task_executor.Write(
                        task, document_id, session_name, concept_mode=self.concept_mode
                    )
                case "REWRITE":
                    return self.task_executor.ReWrite(task)
                case "RESEARCH":
                    return self.task_executor.Research(task)
                case "CRITIQUE":
                    return self.task_executor.Critique(task)
                case "SMALLTALK":
                    return self.task_executor.SmallTalk(task)
                case "EXPLAIN":
                    return self.task_executor.Explain(task)
                case _:
                    return f"Unknown task type: {response.task}"
        except TaskRoutingError:
            raise
        except Exception as e:
            # Re-raised, not returned. A caller that wants a run to fail on it
            # catches this; a caller that wants a string can do so at the edge.
            # Returning the message here is how a broken run was rendered as a
            # completed one with an error for a title.
            raise TaskRoutingError(str(e)) from e
