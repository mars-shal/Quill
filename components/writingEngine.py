"""Writing engine: planner -> section-by-section writer -> dedup pass.

The writer is deliberately incremental. Each section is generated with a
running digest of what earlier sections already said, plus a hard word budget
and an explicit ban on meta-commentary, because long circular drafts come from
generating every section in isolation.
"""

from loguru import logger
from utilis.coherence import score_text
from utilis.grounding import (Profile, extract_claims, strip_unverified, verify,
                               GROUNDING_RULES)
from utilis.timing import timed
import json
import os
import re

from utilis.embeddings import Embedder
from utilis.model import Agent


_META_PATTERNS = (
    r"this (?:essay|paper|document|section|narrative|thesis|chapter) (?:will|shall|aims? to|is going to|explores?|discusses?|delves?|examines?)",
    r"in this (?:essay|paper|document|section|chapter)",
    r"we (?:will |shall )?(?:now )?(?:discuss|explore|examine|delve|look at|dive)",
    r"as (?:we|you) (?:have )?(?:seen|discussed|explored)",
    r"let(?:'s| us)? (?:now )?(?:dive|delve|explore|discuss|turn)",
    r"serves? as a call to action",
    r"remember that",
    r"it is important to (?:note|remember|understand) that",
    r"in order to (?:conduct|perform|carry out|begin|proceed)",
    r"we will (?:start|begin) (?:by|with)",
    r"\b(?:dive|dives|diving|delve|delves|delving) deep(?:ly)?\b",
)

_FILLER_TRANSITIONS = (
    "furthermore",
    "moreover",
    "in addition",
    "additionally",
    "in conclusion",
)

_HEADING_ECHO = re.compile(
    r"^\s{0,3}(?:#{1,6}\s+|(?:chapter|section|phase|part)\s+[0-9ivx]+[.:)]?\s*[-–—:]?\s*).*$",
    re.IGNORECASE,
)


class WritingEngine:
    # Kept as a constant so the coherence scorer can detect the model echoing
    # these instructions back as content. The template lives in this codebase
    # rather than in observed model output, so the check generalises.
    RULES_TEXT = (
        "RULES:\n"
        "- Every sentence must state a fact, a claim, or evidence. Never describe what the"
        " document will do, is doing, or has done.\n"
        "- Be concrete: use names, dates, numbers, quantities, mechanisms.\n"
        "- Do not restate the overall thesis, the introduction, or the conclusion.\n"
        "- Do not open or close with filler transitions or a call to action.\n"
    )

    # Pre-write evidence gate. A section is not written at all unless the
    # research corpus clears these bounds.
    MIN_CORPUS_CHARS = 800
    MIN_RELEVANT_PAGES = 1
    MIN_RESEARCH_QUALITY = 0.35
    # Per-section corpus relevance, using the ResearchEngine.assess floor.
    # Measured separation on a real corpus: on-topic sections 0.72-0.86,
    # mixed 0.64-0.77, off-topic 0.47-0.48. 0.55 sat in the empty gap, but
    # rejected several on-topic sections in practice, so the default moved to
    # 0.4 at the requester's direction. NOTE: 0.47-0.48 is inside the off-topic
    # band, so weak/relevance artefacts are more likely to reach the writer now.
    # Raise QUILL_MIN_SECTION_SUPPORT back toward 0.5 if off-topic paragraphs
    # reappear in output.
    MIN_SECTION_SUPPORT = float(os.environ.get("QUILL_MIN_SECTION_SUPPORT", "0.4"))
    SECTION_RETRIES = 2
    RETRY_TEMPERATURES = (0.5, 0.85)
    MAX_RUN_RETRIES = 12

    def __init__(
        self,
        model: Agent | None = None,
        embedder: Embedder | None = None,
        words_per_section: int = 220,
        max_words_per_section: int = 320,
        dedup_threshold: float = 0.94,
    ):
        self.model = model if model is not None else Agent()
        self.embedder = embedder if embedder is not None else Embedder.get()
        self.words_per_section = words_per_section
        self.max_words_per_section = max_words_per_section
        self.dedup_threshold = dedup_threshold
        self.run_retries = 0
        self.last_gate: dict = {}
        self.last_sections: list[dict] = []
        self._PLANNING_PROMPT = """
        Produce a structured plan for an academic document on the research topic below.

        Every section must advance a DIFFERENT, SPECIFIC claim. A section title is
        not enough: give each section a distinct claim or question that cannot be
        answered by restating another section. Prefer narrow, concrete claims with
        names, dates, mechanisms or numbers over broad themes.

        Bad (all near-synonyms, nothing to say):
          - Phase 1: Relevance
          - Exploring the Historic Context
          - The Impact of Rome's Decline

        Good (each answers a different question):
          - What physically destroyed the structure: earthquakes, stone-robbing, or neglect?
          - How was the 18th-20th century restoration funded, and by which authorities?
          - What evidence exists for the site's use after antiquity?

        Also:
        - Use ONE consistent numbering scheme (1, 1.1, 1.2) across the whole plan.
        - Order sections so each depends on the previous one.
        - Do not plan a section that only repeats the introduction or conclusion.

        Return JSON only, in exactly this shape:
        {
            "sections": [
                {
                    "title": "Section title",
                    "claim": "The one specific, non-overlapping claim or question this section establishes.",
                    "chapters": [
                        {"title": "Chapter title", "claim": "Distinct claim for this chapter."}
                    ]
                }
            ]
        }
        """

    # --- planning -------------------------------------------------------------
    @timed("WritingEngine.planner")
    def planner(self, research_prompt: str) -> dict:
        response = self.model.atlas(
            f"{self._PLANNING_PROMPT}\n\nResearch topic: {research_prompt}"
        )
        if isinstance(response, dict):
            return self._normalise_plan(response)
        return self._normalise_plan({"plan": str(response)})

    @classmethod
    def _normalise_plan(cls, response: dict) -> dict:
        """Atlas may answer with real sections, a JSON plan string, or markdown.

        Anything that parses into a ``sections`` list wins, otherwise a JSON
        string sitting under ``plan`` is unwrapped so ``_outline`` can see it.
        Atlas regularly emits structurally invalid JSON, so a salvage pass
        recovers the title/claim pairs when strict parsing fails.
        """
        if isinstance(response.get("sections"), list):
            return response
        plan = response.get("plan")
        if isinstance(plan, str) and plan.lstrip().startswith(("{", "[")):
            decoded = None
            try:
                decoded = json.loads(plan)
            except (ValueError, TypeError):
                decoded = None
            if isinstance(decoded, dict):
                if isinstance(decoded.get("sections"), list):
                    return decoded
                return response
            salvaged = cls._salvage_sections(plan)
            if salvaged:
                logger.warning(
                    "planner JSON was malformed; salvaged {} sections by field scan",
                    len(salvaged),
                )
                return {"sections": salvaged}
        return response

    @staticmethod
    def _salvage_sections(text: str) -> list[dict]:
        """Recover title/claim pairs from a structurally broken plan.

        Titles and claims are matched in document order, so nesting damage
        inside ``chapters``/``subsections`` does not matter.
        """
        pattern = re.compile(
            r'"(title|claim)"\s*:\s*"((?:[^"\\]|\\.)*)"', re.IGNORECASE
        )
        sections: list[dict] = []
        for match in pattern.finditer(text):
            name, value = match.group(1).lower(), match.group(2)
            value = re.sub(r"\\(['\"\\/])", r"\1", value)
            value = value.replace("\\n", " ").replace("\\t", " ").strip()
            if not value:
                continue
            if name == "title":
                sections.append({"title": value, "claim": ""})
            elif sections and not sections[-1]["claim"]:
                sections[-1]["claim"] = value
        return [s for s in sections if s["title"]]

    # --- writing --------------------------------------------------------------
    @timed("WritingEngine.writer")
    def writer(
        self,
        sections: dict,
        context: str,
        research_note: str = "",
        evidence: dict | None = None,
    ) -> str:
        evidence = evidence or {}
        corpus_chars = int(evidence.get("corpus_chars") or 0)
        relevant_pages = int(evidence.get("relevant_pages") or 0)
        quality = float(evidence.get("quality") or 0.0)
        titles = [str(t) for t in (evidence.get("page_titles") or [])]

        # Logged at the exact point the context reaches the writer, which is
        # where the "research.md is empty" question is actually answered.
        logger.info(
            "write gate input: corpus_chars={} relevant_pages={} quality={} "
            "page_titles={} sections={}",
            corpus_chars, relevant_pages, quality, len(titles),
            len(self._outline(sections, "")),
        )

        topic = ""
        head = (context or "").split("\n\nRESEARCH:")[0].strip()
        if head and "\n" not in head:
            topic = head

        nodes = self._outline(sections, topic)
        blocks: list[str] = []
        digests: list[str] = []
        seen_claims: set[str] = set()
        self.run_retries = 0
        stats = {"written": 0, "placeholder": 0, "retried": 0}
        outcomes: list[dict] = []

        for level, title, claim in nodes:
            key = self._normalise(title or claim)
            if key and key in seen_claims:
                continue
            if key:
                seen_claims.add(key)

            if title:
                blocks.append(f"{'#' * level} {title}")

            block, body, outcome = self._render_section(
                level, title, claim, context, digests, research_note, evidence,
                corpus_chars, relevant_pages, quality,
            )
            blocks.append(block)
            outcomes.append(outcome)
            if outcome["status"] == "written":
                digests.append(self._digest(title, claim, body))
            stats[outcome["status"]] += 1

        self.last_sections = outcomes

        self.last_gate = {
            **evidence,
            "corpus_chars": corpus_chars,
            "relevant_pages": relevant_pages,
            "quality": quality,
            **stats,
        }
        logger.info(
            "write gate result: written={} placeholder={} retried={}",
            stats["written"], stats["placeholder"], stats["retried"],
        )

        if stats["written"] == 0 and stats["placeholder"]:
            return self._run_failure_stub(nodes, corpus_chars, relevant_pages, quality)
        document = "\n\n".join(b for b in blocks if b and b.strip())
        return self.dedupe(document)

    # --- gap pass --------------------------------------------------------------
    # Second pass over a SUBSET of sections, for the writer->research loop. Both
    # methods here are inert unless the caller has already decided to run it:
    # nothing in writer() calls them, so a run that does not opt in cannot
    # reach this code at all.
    def rewrite_sections(
        self,
        context: str,
        targets: list[dict],
        research_note: str = "",
        evidence: dict | None = None,
    ) -> dict:
        """Re-render only ``targets`` against an updated corpus.

        ``targets`` are ``{"title", "claim"}`` pairs - normally the sections
        that came back as placeholders on the first pass. Returns
        ``{"outcomes": {normalised title: outcome}, "written": n,
        "placeholder": n}``; the caller decides which outcomes to splice, so a
        section that still cannot be written keeps its first-pass block.

        Digests of the sections that already succeeded are replayed into the
        prompt, so a re-written section is told what the rest of the document
        already says and repeats none of it.
        """
        evidence = evidence or {}
        corpus_chars = int(evidence.get("corpus_chars") or 0)
        relevant_pages = int(evidence.get("relevant_pages") or 0)
        quality = float(evidence.get("quality") or 0.0)

        digests = [
            self._digest(section.get("title", ""), section.get("claim", ""), section["body"])
            for section in self.last_sections
            if section.get("status") == "written" and section.get("body")
        ]
        # A fresh retry allowance: the first pass's MAX_RUN_RETRIES is spent on
        # the first pass, and carrying it over would silently deny the gap pass
        # any retry at all.
        self.run_retries = 0
        outcomes: dict[str, dict] = {}
        for target in targets or []:
            outcome = self._render_section(
                int(target.get("level") or 1),
                str(target.get("title") or ""),
                str(target.get("claim") or ""),
                context, digests, research_note, evidence,
                corpus_chars, relevant_pages, quality,
            )[2]
            key = self._normalise(outcome["title"] or outcome["claim"])
            if key:
                outcomes[key] = outcome
        return {
            "outcomes": outcomes,
            "written": sum(1 for o in outcomes.values() if o["status"] == "written"),
            "placeholder": sum(
                1 for o in outcomes.values() if o["status"] == "placeholder"
            ),
        }

    def splice_document(self, replacements: dict[str, str]) -> str:
        """Rebuild the document with ``replacements`` substituted by title.

        Every other section keeps its exact first-pass block, so a gap round can
        only ever add content where there was a placeholder. The result goes
        through the same ``dedupe`` as a normal run, because the splice
        reconstitutes a whole document rather than a fragment.
        """
        blocks: list[str] = []
        for section in self.last_sections:
            key = self._normalise(section.get("title") or section.get("claim"))
            block = replacements.get(key) or section.get("block") or ""
            if block:
                blocks.append(block)
        return self.dedupe("\n\n".join(blocks))

    def _render_section(
        self,
        level: int,
        title: str,
        claim: str,
        context: str,
        digests: list[str],
        research_note: str,
        evidence: dict,
        corpus_chars: int,
        relevant_pages: int,
        quality: float,
    ) -> tuple[str, str, dict]:
        """Render one section to its final block, and report what happened.

        The evidence gate, the per-section relevance gate and the verified write
        live here rather than in ``writer`` so that a second pass over a subset
        of sections runs the SAME code. A forked copy of these three branches
        would be a second opinion about when a section may be written, and the
        defect this loop closes came from the writer and the researcher
        disagreeing about what the corpus supports.

        Returns ``(block, body, outcome)`` where ``block`` is the heading plus
        the body or the placeholder, ``body`` is the generated prose alone
        (empty for a placeholder), and ``outcome`` is the record the gap loop
        needs: which section, whether it was written, and why not. The rendered
        ``block`` is kept on the outcome so a later splice can reuse the exact
        first-pass text of every section it did not rewrite - rebuilding one from
        its parts would have to re-derive the evidence numbers and would
        silently change the words of a placeholder nobody touched.
        """
        outcome = {
            "level": level, "title": title, "claim": claim,
            "status": "placeholder", "body": "", "reason": "",
            "heading": f"{'#' * level} {title}" if title else "",
        }

        def done(body: str, rendered: str) -> tuple[str, str, dict]:
            outcome["block"] = rendered
            return rendered, body, outcome

        def placeholder(reason: str = "") -> str:
            return self._as_block(outcome, self._placeholder(
                title, corpus_chars, relevant_pages, quality, reason=reason
            ))

        if not self._evidence_ok(corpus_chars, relevant_pages, quality):
            self._log_attempt(title, evidence, "evidence_blocked", attempt=0)
            outcome["reason"] = "evidence_blocked"
            return done("", placeholder())

        support = self._section_support(title, claim, context)
        if support is not None and support < self.MIN_SECTION_SUPPORT:
            self._log_attempt(
                title, evidence, "no_matching_source", attempt=0,
                score={"ttr": 0.0, "top_share": 0.0, "echo": 0.0, "chrome": 0.0,
                       "support": round(support, 3)},
            )
            outcome["reason"] = (
                f"no research source is close to this section "
                f"(relevance {support:.3f} < {self.MIN_SECTION_SUPPORT})"
            )
            return done("", placeholder(outcome["reason"]))

        body, score = self._write_verified(
            context, title, claim, digests, research_note, evidence
        )
        if body.strip() and score.get("verdict") == "coherent":
            outcome.update({"status": "written", "body": body, "reason": ""})
            return done(body, self._as_block(outcome, body))

        outcome["reason"] = "; ".join(score.get("reasons") or ["incoherent output"])
        return done("", placeholder(outcome["reason"]))

    @staticmethod
    def _as_block(outcome: dict, body: str) -> str:
        heading = outcome.get("heading") or ""
        return f"{heading}\n\n{body}" if heading else body

    def _evidence_ok(self, corpus_chars: int, relevant_pages: int, quality: float) -> bool:
        """Thin research is treated as hard as absent: 0.321 quality already
        produced tier-1-grade output, so advisory warnings are not enough."""
        return (
            corpus_chars >= self.MIN_CORPUS_CHARS
            and relevant_pages >= self.MIN_RELEVANT_PAGES
            and quality >= self.MIN_RESEARCH_QUALITY
        )

    def _section_support(self, title: str, claim: str, context: str) -> float | None:
        """Relevance of the research corpus to one section, or None if unknown.

        Uses the same embedder and normalised floor as ``ResearchEngine.assess``
        (calibrated floor 0.491, on-topic 0.517) rather than keyword matching,
        which cannot tell that a page titled "Colosseum - Wikipedia" supports a
        section titled "History".
        """
        corpus = (context or "").split("\n\nRESEARCH:", 1)[-1].strip()
        probe = " ".join(x for x in (title, claim) if x).strip()
        if not corpus or not probe or self.embedder is None:
            return None
        try:
            return round(
                self.embedder.similarity(
                    self.embedder.embed_one(probe), self.embedder.embed_one(corpus[:6000])
                ),
                3,
            )
        except Exception:
            return None

    def _write_verified(
        self,
        context: str,
        title: str,
        claim: str,
        digests: list[str],
        research_note: str,
        evidence: dict,
    ) -> tuple[str, dict]:
        body, score = "", {}
        corpus = self._corpus(context)
        profile = Profile.from_env(
            Profile.detect(str(evidence.get("concept") or ""), f"{title} {claim}")
        )
        logger.info(
            "GROUNDING_PROFILE section={} profile={} decimal_signal={} round_signal={}",
            (title or "")[:40], profile.name,
            profile.decimal_precision_is_signal, profile.round_specificity_is_signal,
        )
        for attempt in range(self.SECTION_RETRIES + 1):
            temperature = None
            if attempt:
                if self.run_retries >= self.MAX_RUN_RETRIES:
                    break
                self.run_retries += 1
                temperature = self.RETRY_TEMPERATURES[
                    min(attempt - 1, len(self.RETRY_TEMPERATURES) - 1)
                ]
            body = self._write_body(
                context, title, claim, digests, research_note, temperature=temperature
            )
            score = score_text(body, template=self.RULES_TEXT)
            grounding = verify(extract_claims(body, profile), corpus, profile)
            self._log_grounding(title, evidence, grounding, profile)
            if score.get("verdict") == "coherent":
                if grounding["escalate"]:
                    # Authority clusters are the highest-risk fabrication; never
                    # let one through un-escalated.
                    body, dropped = strip_unverified(body, self._unverified(body, profile, corpus))
                    logger.info(
                        "GROUNDING section={} escalated {} authority claim(s); dropped {} sentence(s)",
                        (title or "")[:40], grounding["authority_suspects"], dropped,
                    )
                elif grounding["unverified"]:
                    body, dropped = strip_unverified(body, self._unverified(body, profile, corpus))
                    logger.info(
                        "GROUNDING section={} softened {} unverified claim(s); dropped {} sentence(s)",
                        (title or "")[:40], grounding["unverified"], dropped,
                    )
                self._log_attempt(title, evidence, score.get("verdict"), attempt, score)
                if not body.strip():
                    continue
                # Re-score the body as it will actually be published. Grounding
                # can delete every sentence: on 2026-10-12 section 3.1 scored
                # coherent at 254 words with 18 claims of which 0 were
                # corroborated, and strip_unverified left the 7-word remnant
                # "Law No. The permit referenced Law No." - which `body.strip()`
                # accepted as a finished section. A remnant below MIN_WORDS is
                # not a section; score_text already rejects it, so letting the
                # verdict drive the loop turns this into a retry instead.
                final = score_text(body, template=self.RULES_TEXT)
                if final.get("verdict") == "coherent":
                    return body, final
                self._log_attempt(
                    title, evidence,
                    f"stripped_to_{final.get('words')}_words", attempt, final,
                )
            self._log_attempt(title, evidence, score.get("verdict"), attempt, score)
        # Retries exhausted with no acceptable body. Return empty, not the last
        # attempt's remnant: the caller turns an empty body into a placeholder,
        # which is honest, whereas a 7-word fragment reads as finished prose.
        return "", (score or {"verdict": "incoherent", "reasons": ["no output"]})

    def _corpus(self, context: str) -> str:
        """Full research corpus behind a prompt, not the 6,000-char slice."""
        return (context or "").split("\n\nRESEARCH:", 1)[-1]

    def _unverified(self, body: str, profile: Profile, corpus: str) -> list:
        claims = extract_claims(body, profile)
        if claims:
            verify(claims, corpus, profile)
        return [c for c in claims if c.signal != "corroborated"]

    def _log_grounding(self, title: str, evidence: dict, grounding: dict, profile: Profile) -> None:
        logger.info(
            "GROUNDING {}", json.dumps(
                {
                    "section": (title or "")[:80],
                    "profile": profile.name,
                    "quality": evidence.get("quality", 0.0),
                    "corpus_chars": evidence.get("corpus_chars", 0),
                    "claims": grounding["total"],
                    "corroborated": grounding["corroborated"],
                    "unverified": grounding["unverified"],
                    "precision_suspects": grounding["precision_suspects"],
                    "authority_suspects": grounding["authority_suspects"],
                    "escalate": grounding["escalate"],
                },
                ensure_ascii=False,
            )
        )

    def _placeholder(
        self, title: str, corpus_chars: int, relevant_pages: int, quality: float,
        reason: str = "",
    ) -> str:
        detail = reason or (
            f"corpus {corpus_chars} chars, {relevant_pages} relevant pages, "
            f"quality {quality:.2f}"
        )
        return (
            f"> **⚠ INSUFFICIENT EVIDENCE — NOT GENERATED CONTENT.**\n"
            f"> This section was skipped rather than invented: {detail}.\n"
            f"> No claim is made here."
        )

    def _run_failure_stub(
        self, nodes: list, corpus_chars: int, relevant_pages: int, quality: float
    ) -> str:
        """Total evidence failure: a labelled stub, never a silent exit."""
        lines = [
            "# Generation Halted — Insufficient Research Evidence",
            "",
            "> **⚠ THIS RUN PRODUCED NO CONTENT.** No section could be written "
            "because the research corpus did not meet the minimum evidence "
            "requirements. The outline below is what *would* have been written.",
            "",
            f"- Corpus size: **{corpus_chars} chars** (minimum {self.MIN_CORPUS_CHARS})",
            f"- Relevant pages: **{relevant_pages}** (minimum {self.MIN_RELEVANT_PAGES})",
            f"- Research quality: **{quality:.3f}** (minimum {self.MIN_RESEARCH_QUALITY})",
            "",
            "## Skipped outline",
        ]
        for level, title, claim in nodes:
            if title:
                lines.append(f"{'#' * min(level + 1, 6)} {title}")
            if claim:
                lines.append(f"*{claim}*")
        return "\n".join(lines)

    def _log_attempt(
        self, title: str, evidence: dict, verdict: str, attempt: int = 0,
        score: dict | None = None,
    ) -> None:
        """Paired research-quality vs coherence record.

        Aggregating these across runs is what separates "the model was starved"
        from "the model cannot do this task": if high-quality sections still
        fail coherence, the problem is capacity, not data.
        """
        record = {
            "section": (title or "")[:80],
            "attempt": attempt,
            "quality": evidence.get("quality", 0.0),
            "relevant_pages": evidence.get("relevant_pages", 0),
            "corpus_chars": evidence.get("corpus_chars", 0),
            "verdict": verdict,
        }
        if score:
            for key in ("ttr", "top_share", "refusal", "echo", "chrome", "symbol_noise", "words"):
                if key in score:
                    record[key] = score[key]
        logger.info("COHERENCE {}", json.dumps(record, ensure_ascii=False))

    @timed("WritingEngine._outline")
    def _outline(self, sections: dict, topic: str = "") -> list[tuple[int, str, str]]:
        nodes: list[tuple[int, str, str]] = []
        if isinstance(sections.get("sections"), list):
            for section in sections["sections"]:
                nodes.append(
                    (1, self._title(section), self._claim(section))
                )
                for chapter in section.get("chapters") or []:
                    nodes.append((2, self._title(chapter), self._claim(chapter)))
                    for subsection in chapter.get("subsections") or []:
                        nodes.append(
                            (3, self._title(subsection), self._claim(subsection))
                        )
            nodes = [n for n in nodes if n[1] or n[2]]

        if not nodes:
            plan = sections.get("plan")
            nodes = self._parse_outline(plan) if isinstance(plan, str) else []
        if not nodes:
            nodes = self._default_outline(topic or "the requested topic")
        return self._with_distinct_claims(nodes)

    @classmethod
    def _with_distinct_claims(
        cls, nodes: list[tuple[int, str, str]]
    ) -> list[tuple[int, str, str]]:
        """Give every node a claim the writer can aim at, all of them unique.

        Salvaged plans leave ``claim`` empty, and two sections may restate one
        claim under different titles — which researches the same thing twice
        and scores both sections against an identical probe.
        """
        seen: set[str] = set()
        out: list[tuple[int, str, str]] = []
        for level, title, claim in nodes:
            claim = (claim or "").strip()
            if not claim:
                claim = f"Establish what the research shows about {title or 'this section'}."
            key = cls._normalise(claim)
            if key in seen:
                claim = f"{claim} — as it applies to {title or 'this part'}."
                key = cls._normalise(claim)
            suffix = 2
            while key in seen:
                claim = f"{claim} (part {suffix})"
                key = cls._normalise(claim)
                suffix += 1
            seen.add(key)
            out.append((level, title, claim))
        return out

    @staticmethod
    def _default_outline(topic: str) -> list[tuple[int, str, str]]:
        """Fallback structure; each entry owns a different question."""
        return [
            (1, "Introduction", f"Define {topic}: what it is, its scope, and the question this document answers."),
            (2, "Historical background", f"Establish the timeline and physical evidence for {topic}."),
            (2, "Mechanisms of change", f"Identify the specific causes that produced change in {topic}, and weigh them against each other."),
            (2, "Modern interventions", f"Record what was done to {topic} in the modern period, by whom, when, and at what cost."),
            (1, "Conclusion", f"State what the evidence supports about {topic}, and what remains unresolved."),
        ]

    @timed("WritingEngine._parse_outline")
    def _parse_outline(self, plan: str) -> list[tuple[int, str, str]]:
        nodes: list[tuple[int, str, str]] = []
        level, title, guidance, saw_heading = 1, "", [], False
        for line in (plan or "").splitlines():
            match = re.match(r"^(#{1,6})\s+(.*?)\s*$", line)
            if match:
                if title or guidance:
                    nodes.append((level, title, " ".join(guidance).strip()))
                saw_heading = True
                level = len(match.group(1))
                title = match.group(2).strip()
                guidance = []
            elif line.strip():
                guidance.append(line.strip())
        if title or guidance:
            nodes.append((level, title, " ".join(guidance).strip()))
        if not saw_heading:
            return []
        return [n for n in nodes if n[1] or self._usable_guidance(n[2])]

    @staticmethod
    def _usable_guidance(guidance: str) -> bool:
        lines = [ln.strip() for ln in (guidance or "").splitlines() if ln.strip()]
        if not lines:
            return False
        titleish = sum(1 for ln in lines if ln.lower().startswith("title:"))
        return titleish < max(1, len(lines) // 2)

    @timed("WritingEngine._write_body")
    def _write_body(
        self,
        context: str,
        title: str,
        claim: str,
        digests: list[str],
        research_note: str = "",
        temperature: float | None = None,
    ) -> str:
        prompt = self._build_body_prompt(context, title, claim, digests, research_note)
        body = self.model.Quill(prompt, temperature=temperature) or ""
        body = self._strip_heading_echo(body)
        body = self._clean(body)
        return self._enforce_length(body, self.max_words_per_section)

    def _build_body_prompt(
        self,
        context: str,
        title: str,
        claim: str,
        digests: list[str],
        research_note: str = "",
    ) -> str:
        target, ceiling = self.words_per_section, self.max_words_per_section
        claim = (claim or "").strip()

        prompt = (
            "Write ONE section of an academic document.\n"
            "Output prose only: no headings, no bullet points, no numbering, no markdown.\n\n"
        )
        if title:
            prompt += f"SECTION TITLE: {title}\n"
        if claim:
            prompt += f"THIS SECTION MUST ESTABLISH: {claim}\n"
        prompt += f"\nLENGTH: about {target} words. Never exceed {ceiling}.\n"
        prompt += self.RULES_TEXT
        prompt += GROUNDING_RULES
        if digests:
            listed = "\n".join(f"  - {d}" for d in digests[-6:])
            prompt += (
                "\nThese points were ALREADY made in earlier sections. Do not repeat or"
                f" rephrase them; add something new:\n{listed}\n"
            )
        if research_note:
            prompt += f"\n{research_note}\n"

        context = context or ""
        budget = 6000
        if len(context) > budget:
            context = (
                context[: budget // 2]
                + "\n...[truncated]...\n"
                + context[-budget // 2 :]
            )
        return prompt + f"\nResearch and context to draw on:\n{context}"

    @staticmethod
    def _strip_heading_echo(body: str) -> str:
        """Models often re-emit the section title as the first line."""
        lines = (body or "").splitlines()
        while lines and (not lines[0].strip() or _HEADING_ECHO.match(lines[0])):
            if not lines[0].strip():
                lines.pop(0)
                continue
            if re.match(r"^\s{0,3}#{1,6}\s+", lines[0]):
                lines.pop(0)
                continue
            if re.match(r"^\s*(title|chapter|section|phase)\b", lines[0], re.I) and len(lines) > 1:
                lines.pop(0)
                continue
            break
        return "\n".join(lines)

    @classmethod
    def _clean(cls, text: str) -> str:
        text = re.sub(r"[ \t]+", " ", text or "")
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"^\s*[-*•]\s+", "", text, flags=re.MULTILINE)
        text = re.sub(r"\b(\w+)\s+and\s+\1\b", r"\1", text, flags=re.IGNORECASE)
        text = re.sub(r"\b(\w+)\s+\1\b", r"\1", text, flags=re.IGNORECASE)
        return text.strip()

    def _enforce_length(self, body: str, ceiling: int) -> str:
        words = body.split()
        if len(words) <= ceiling:
            return body
        clipped = " ".join(words[:ceiling])
        cut = max(clipped.rfind(". "), clipped.rfind("! "), clipped.rfind("? "))
        if cut > len(clipped) * 0.6:
            clipped = clipped[: cut + 1]
        return clipped.strip()

    @staticmethod
    def _digest(title: str, claim: str, body: str) -> str:
        """Short carry-forward record of what a section actually said."""
        lead = " ".join((body or "").split()[:45]).strip()
        parts = [p for p in (title, claim, lead) if p]
        return " — ".join(parts)[:400]

    # --- post-processing ------------------------------------------------------
    @classmethod
    def _strip_meta(cls, block: str) -> str:
        """Remove sentences that narrate the document instead of arguing it.

        These are the padding sentences ("In this chapter, we will explore...").
        Dropping whole sentences is safe: by construction they carry no evidence,
        so no factual content is lost.
        """
        kept: list[str] = []
        for line in (block or "").split("\n"):
            sentences = re.split(r"(?<=[.!?])\s+", line)
            line_kept = [
                s for s in sentences
                if not any(re.search(p, s, re.IGNORECASE) for p in _META_PATTERNS)
            ]
            if line_kept:
                kept.append(" ".join(line_kept).strip())
        return "\n".join(x for x in kept if x).strip()

    @timed("WritingEngine.dedupe")
    def dedupe(self, document: str) -> str:
        """Strip meta-padding, then drop repeated headings, sentences and paragraphs.

        Paragraph-level semantic dedupe is deliberately conservative: in a document
        about a single topic, distinct paragraphs routinely score above 0.9 against
        each other, so an aggressive threshold deletes real content. True
        near-verbatim repetition still scores high enough to be removed.
        """
        blocks = [b.strip() for b in (document or "").split("\n\n") if b.strip()]
        kept: list[str] = []
        kept_vectors: list[list] = []
        seen_headings: set[str] = set()
        seen_sentences: set[str] = set()

        for block in blocks:
            if re.match(r"^#{1,6}\s+", block):
                title = re.sub(r"^#{1,6}\s+", "", block).strip()
                key = self._normalise(title)
                if key in seen_headings:
                    continue
                seen_headings.add(key)
                kept.append(block)
                continue

            # Placeholders are intentionally identical across sections, so both
            # dedup passes erase them: sentence-dedup drops their lines after the
            # first one, then the emptied block disappears (run4: 6 of 7
            # placeholders vanished, leaving bare headings).
            if "INSUFFICIENT EVIDENCE" in block:
                kept.append(block)
                continue

            block = self._strip_meta(block)
            block = self._drop_repeated_sentences(block, seen_sentences)
            if not block.strip():
                continue

            vector = self.embedder.embed_one(block) if len(block.split()) >= 8 else None
            if vector is not None:
                duplicate = False
                for other in kept_vectors:
                    try:
                        if self.embedder.similarity(vector, other) >= self.dedup_threshold:
                            duplicate = True
                            break
                    except Exception:
                        continue
                if duplicate:
                    continue
                kept_vectors.append(vector)

            kept.append(block)

        return "\n\n".join(kept)

    @staticmethod
    def _drop_repeated_sentences(block: str, seen: set[str]) -> str:
        kept: list[str] = []
        # Per-line, not per-block: joining across lines turned the placeholder's
        # "> …\n> No claim is made here." into "…0.55). > No claim is made here."
        for line in (block or "").split("\n"):
            out = []
            for sentence in re.split(r"(?<=[.!?])\s+", line):
                key = WritingEngine._normalise(sentence)
                if len(key.split()) < 5:
                    out.append(sentence)
                    continue
                if key in seen:
                    continue
                seen.add(key)
                out.append(sentence)
            if out:
                kept.append(" ".join(out).strip())
        return "\n".join(x for x in kept if x).strip()

    @staticmethod
    def _normalise(text: str) -> str:
        return re.sub(r"[^a-z0-9 ]", " ", (text or "").lower()).strip()

    @staticmethod
    def meta_hits(text: str) -> list[str]:
        """Meta-commentary phrases found in ``text`` (used by the document check)."""
        found = []
        for pattern in _META_PATTERNS:
            for match in re.finditer(pattern, text or "", re.IGNORECASE):
                found.append(match.group(0))
        return found

    @staticmethod
    def filler_hits(text: str) -> list[str]:
        low = (text or "").lower()
        return [phrase for phrase in _FILLER_TRANSITIONS if phrase in low]

    # --- node helpers ---------------------------------------------------------
    @staticmethod
    def _title(node: dict | str | None) -> str:
        if isinstance(node, str):
            return node.strip()
        if isinstance(node, dict):
            return (node.get("title") or "").strip()
        return ""

    @staticmethod
    def _claim(node: dict | str | None) -> str:
        if isinstance(node, str):
            return ""
        if isinstance(node, dict):
            for key in ("claim", "question", "focus", "description"):
                value = node.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return ""
