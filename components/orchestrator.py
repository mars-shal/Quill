import os

from loguru import logger

from utilis.timing import timed
from components.conceptEngine import ConceptEngine
from components.PlagiarismEngine import PlagiarismEngine
from components.researchEngine import ResearchEngine
from components.sessionManager import SessionManager
from components.writingEngine import WritingEngine
from utilis.drift import detect_drift
from utilis.coverage import (
    gap_research_enabled,
    gap_research_pages_budget,
    gap_research_queries_budget,
    gap_research_sections_budget,
)
from utilis.store import SqliteDatabase
from utilis.model import Agent


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

    @staticmethod
    def _survey_guard(document: dict, concept_mode: str) -> str:
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

    @timed("Task.Write")
    def Write(
        self, prompt: str, document_id: str, session_name: str = "",
        concept_mode: str = "reference",
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
        research_engine = ResearchEngine(agent=self.agent)
        research = research_engine.run(concept["concept"], document_id, prompt=prompt)
        plan = WritingEngine(model=self.agent).planner(concept["concept"])
        context = (
            f"{concept['concept']}\n\nRESEARCH:\n{research['corpus']}"
            if research.get("corpus")
            else concept["concept"]
        )
        research_note = _research_note(research)
        evidence = _evidence_of(research)
        writer = WritingEngine(model=self.agent)
        written = writer.writer(plan, context, research_note, evidence=evidence)

        gap = None
        if gap_research_enabled():
            gap = self._close_research_gaps(
                writer, research_engine, research, concept["concept"], prompt
            )
            if gap.get("document") is not None:
                written = gap["document"]
                research = gap["research"]
                research_note = gap["research_note"]

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

    @staticmethod
    def _close_research_gaps(
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

    @timed("Task.ReWrite")
    def ReWrite(self, prompt: str, document_id: str = ""):
        document_id = document_id or self._last_document_id
        if not document_id:
            return {"error": "No document to rewrite. Run WRITE first."}
        existing = self.database.get(f"written:{document_id}") or {}
        document = self.database.get(document_id) or {}
        concept = self.database.get(f"concept:{document_id}") or {}
        research = self.database.get(f"research:{document_id}") or {}

        prompt_text = concept.get("concept") or document.get("title") or prompt
        plan = WritingEngine(model=self.agent).planner(f"{prompt_text}\n\nRewrite guidance: {prompt}")
        context = (
            f"{prompt_text}\n\nRESEARCH:\n{research.get('corpus', '')}"
            if research.get("corpus")
            else prompt_text
        )
        evidence = {
            "corpus_chars": len(research.get("corpus") or ""),
            "relevant_pages": int(research.get("relevant_pages") or 0),
            "quality": float(research.get("quality") or 0.0),
            "page_titles": [p.get("title", "") for p in (research.get("pages") or [])],
        }
        written = WritingEngine(model=self.agent).writer(plan, context, evidence=evidence)
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
            "plagiarism": plagiarism,
        }
        self.database.set(f"written:{document_id}", payload)
        return payload

    @timed("Task.Research")
    def Research(self, prompt: str):
        payload = ResearchEngine(agent=self.agent).run(prompt, prompt=prompt)
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

    @timed("Task.SmallTalk")
    def SmallTalk(self, prompt: str):
        return self.agent.model(prompt)

    @timed("Task.Explain")
    def Explain(self, prompt: str):
        payload = ResearchEngine(agent=self.agent).run(prompt, prompt=prompt)
        answer = self.agent.model(
            f"QUESTION: {prompt}\n\nExplain using only the research below.\n\nRESEARCH:\n{payload.get('corpus', '')}",
            system_prompt="You give concise, well-grounded explanations.",
        )
        return {"answer": answer, "research": payload}


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

            task_type = (response.task or "").strip().upper()
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
