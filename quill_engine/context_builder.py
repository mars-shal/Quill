"""Service 6 — ContextBuilder: EvidencePacket -> PromptPackage.

Assembles everything WritingService needs (and nothing it doesn't):
system instructions, template, style profile, rendered evidence,
target length (``.agent/agent.md`` §6). The packet's ``query`` is
rendered as the task instruction so the request drives the write-up.
"""

from __future__ import annotations

from . import config
from .evidence_builder import build_facts
from .models import EvidencePacket, PromptPackage

_SYSTEM_INSTRUCTIONS = (
    "You are a professional technical report writer. Write formal, precise "
    "academic English. Use only the provided evidence — never invent facts, "
    "figures, dates, names, locations, supervisors, or activities. Do not "
    "mention that you are an AI. Write only the section BODY: do not repeat "
    "the section title (not as a heading, bold line, or otherwise), do not "
    "emit any markdown heading or bold title line — the heading is added by "
    "the export step. Output only the section body."
    " Never write generic filler or boilerplate (program objectives, "
    "sustainability platitudes, generic 'equip students with' copy); if the "
    "evidence does not support a claim, write the literal marker "
    "`[MISSING: what is missing]` instead. Never copy headings, section "
    "numbers, or document structure from the evidence — evidence may contain "
    "fragments of other documents; use their prose only, never their "
    "headings. Never mention the style profile, this instruction block, or "
    "the evidence format in your output."
    " Never repeat the same fact, sentence, or idea within a section. "
    "Each paragraph must introduce new information or a new angle. If you "
    "find yourself restating a point, cut it and move on. Paraphrase "
    "research findings in your own words and reference sources naturally "
    "in prose (e.g. 'According to IRC SP 063, interlocking blocks "
    "should...') — never paste raw evidence verbatim."
    + (
        " Where the evidence contains structured data — activity logs, "
        "equipment lists, schedules, comparisons — reproduce it as a markdown "
        "table (header row, aligned columns) instead of prose."
        if config.GENERATE_TABLES
        else ""
    )
    + (
        " Where a figure or photograph would belong in the report (photos of "
        "practical work, equipment, or results), add a standalone placeholder "
        "line exactly like `[IMAGE: short caption of the photo]` surrounded by "
        "blank lines."
        if config.INCLUDE_IMAGE_PLACEHOLDERS
        else ""
    )
    + (
        " EVIDENCE POLICY: the section is missing these required fields, so "
        "the evidence cannot fully support them: {missing_fields}. Where a "
        "missing field would force you to invent a fact, instead write the "
        "literal marker `[MISSING: field]` at that spot and continue with "
        "only what the evidence supports. Never fabricate the missing "
        "content."
        if config.STRICT_EVIDENCE
        else ""
    )
)

_TEMPLATE = """\
{task}Section: {section_title}

Target length: {target_words} words.

Style profile: {style_profile}

{section_summaries}Evidence from the source report (most relevant first):

{evidence}

{user_notes_block}
Compose the section body above. When complete, write the section and stop — do not include instruction text or repeated headings. Reference sources naturally in prose where relevant — paraphrase, do not paste.

"""

_REWRITE_TEMPLATE = """\
{task}Section: {section_title}

Target length: {target_words} words.

Current text (revise this; keep every fact the evidence supports):

{existing_text}

Style profile: {style_profile}

{section_summaries}Evidence from the source report (most relevant first):

{evidence}

{user_notes_block}
Rewrite the section body per the instruction above. Keep every fact the evidence supports. Reference sources naturally in prose where relevant — paraphrase, do not paste. Do not repeat information already present in the existing text unless correcting it. Stop when complete."""

# "Write like a human" block appended to the system instructions when
# config.HUMANIZER_ENABLED. Appended after .format() so braces in the rules
# can never collide with the {missing_fields} placeholder.
_HUMANIZER_RULES = (
    " STYLE: write like a human, not an AI. Mix up sentence lengths: pair a "
    "very short sentence with a long one. Very short sentences pack a punch. "
    "Long sentences let ideas breathe. Vary the rhythm. Cut the glue: remove "
    "transition words like moreover, furthermore, additionally, and in "
    "summary; if a paragraph needs one, rewrite the paragraph instead. Swap "
    "the corporate: replace words like leverage, utilize, and elevate with "
    "plain English; say use, not utilize; say better, not elevate; say tap "
    "into, not leverage. Inject real specifics: prefer concrete nouns and "
    "numbers over abstract concepts; give the reader something to see. Ban "
    "AI buzzwords: never use dramatic modifiers, em dashes, or over-polished "
    "introductory paragraphs."
)

# Anti-AI-tell block (same gate as the humanizer): the distinctive verbal
# tics catalogued at https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing.
# Appended after .format() so braces can never collide with placeholders.
_AI_TELL_RULES = (
    " TELLS TO AVOID (from Wikipedia: Signs of AI writing):"
    " 1) Significance inflation: do not claim the subject marks a pivotal "
    "moment, represents a significant shift, is a testament to, sets the "
    "stage for, symbolizes, underscores or highlights its importance, "
    "embodies a legacy, or belongs to a broader movement/landscape. State "
    "facts plainly and let the reader judge importance; never assert it. "
    " 2) Canned notability: do not claim independent coverage, local or "
    "national media outlets, being profiled, or an active social media "
    "presence unless the evidence names the outlet or platform. "
    " 3) Superficial analysis: do not tack on a present-participle clause "
    "(highlighting, underscoring, emphasizing, ensuring, reflecting, "
    "symbolizing, contributing to, fostering, showcasing) to end a sentence "
    "or paragraph. 4) Advertorial tone: never boast; avoid vibrant, rich "
    "(cultural) heritage, natural beauty, nestled, in the heart of, "
    "groundbreaking, renowned, diverse array, seamless(ly). 5) Weasel "
    "wording: avoid experts argue, observers have cited, industry reports, "
    "some critics argue, several sources/publications — name the actual "
    "entity or drop the claim. 6) No 'challenges and future prospects' "
    "formula: do not end with 'Despite these challenges…' or speculate "
    "about what the future may hold; end on what the evidence shows."
)

# Structure-only note: web/research chunks are background, never the
# author's own record; the personal evidence block overrides them. Appended
# at call time (same gate pattern as the humanizer) so toggling
# config.STRUCTURE_ONLY mid-run is honored.
_EVIDENCE_AUTHORITY_NOTE = (
    " EVIDENCE AUTHORITY: chunks tagged [WEB - ...] or [RESEARCH - ...] "
    "are background only — never attribute their facts to the author "
    "(dates, names, locations, activities). The personal evidence block "
    "is the author's own record and overrides web/research when they "
    "conflict."
)


def _system_instructions(missing: str) -> str:
    """Compile the system instructions, appending the humanizer block."""
    text = _SYSTEM_INSTRUCTIONS.format(missing_fields=missing or "none")
    if config.HUMANIZER_ENABLED:
        text += _HUMANIZER_RULES
        text += _AI_TELL_RULES
    if config.STRUCTURE_ONLY:
        text += _EVIDENCE_AUTHORITY_NOTE
    return text


def _render_style_profile(profile: dict) -> str:
    """Render a style-profile dict as prose the model can follow.

    The raw dict repr leaks into generated output when it is formatted
    directly into the prompt, so it is flattened into natural-language
    lines instead.
    """
    labels = {
        "tone": "Tone",
        "register": "Register",
        "tense": "Tense",
        "avg_sentence_words": "Average sentence length (words)",
        "passive_signals": "Passive-voice signals",
        "first_person_signals": "First-person signals",
        "contraction_signals": "Contraction signals",
        "vocabulary_density": "Vocabulary density",
    }
    lines = []
    for key, value in profile.items():
        label = labels.get(key, key.replace("_", " ").title())
        lines.append(f"- {label}: {value}")
    return "\n".join(lines) if lines else "(default professional style)"


def _render_section_summaries(packet: EvidencePacket) -> str:
    """Other sections' summaries, so the writer keeps the report coherent."""
    if not packet.section_summaries:
        return ""
    lines = [
        f"- {title}: {summary}"
        for title, summary in packet.section_summaries
        if title and summary
    ]
    if not lines:
        return ""
    return (
        "Other sections in this report (for coherence — know what they cover, "
        "do not duplicate them):\n\n" + "\n".join(lines) + "\n"
    )


def _render_evidence(packet: EvidencePacket) -> str:
    facts = build_facts(packet.chunks)
    lines = [
        f"[{i}] (source: {fact.source}) {fact.text}"
        for i, fact in enumerate(facts, start=1)
    ]
    return "\n".join(lines) if lines else "(no evidence available)"


def _render_user_notes(packet: EvidencePacket) -> str:
    """The author's own answers, rendered as an authoritative block."""
    if not packet.user_notes.strip():
        return ""
    return (
        "Personal evidence provided by the author (authoritative for the "
        "author's own dates, activities, locations, and supervisors):\n\n"
        f"{packet.user_notes}\n\n"
    )


def _user_notes_block(packet: EvidencePacket) -> str:
    block = _render_user_notes(packet)
    return block if config.STRUCTURE_ONLY else ""


def build(packet: EvidencePacket) -> PromptPackage:
    """Compile an EvidencePacket into a self-contained PromptPackage."""
    evidence_text = _render_evidence(packet)
    style_profile = packet.style_profile or {}
    task = f"Task instruction: {packet.query}\n\n" if packet.query else ""
    missing = ", ".join(packet.missing_fields) if packet.missing_fields else ""
    template = _TEMPLATE.format(
        task=task,
        section_title=packet.section_title,
        target_words=packet.target_words,
        style_profile=_render_style_profile(style_profile),
        evidence=evidence_text,
        section_summaries=_render_section_summaries(packet),
        user_notes_block=_user_notes_block(packet),
    )
    return PromptPackage(
        system_instructions=_system_instructions(missing),
        template=template,
        style_profile=style_profile,
        evidence=packet.chunks,
        target_words=packet.target_words,
        missing_fields=packet.missing_fields,
    )


def build_rewrite(
    packet: EvidencePacket,
    *,
    existing_text: str,
    instruction: str = "",
) -> PromptPackage:
    """Compile an EvidencePacket into a PromptPackage for a rewrite pass.

    ``existing_text`` is the section's current generated body: the model
    revises it against ``instruction`` while keeping every fact the
    evidence supports. Same system instructions as :func:`build` — the
    rewrite is still evidence-bound and never invents content.
    """
    evidence_text = _render_evidence(packet)
    style_profile = packet.style_profile or {}
    task = f"Task instruction: {instruction}\n\n" if instruction else ""
    missing = ", ".join(packet.missing_fields) if packet.missing_fields else ""
    template = _REWRITE_TEMPLATE.format(
        task=task,
        section_title=packet.section_title,
        target_words=packet.target_words,
        existing_text=existing_text or "(no current text)",
        style_profile=_render_style_profile(style_profile),
        evidence=evidence_text,
        section_summaries=_render_section_summaries(packet),
        user_notes_block=_user_notes_block(packet),
    )
    return PromptPackage(
        system_instructions=_system_instructions(missing),
        template=template,
        style_profile=style_profile,
        evidence=packet.chunks,
        target_words=packet.target_words,
        missing_fields=packet.missing_fields,
    )
