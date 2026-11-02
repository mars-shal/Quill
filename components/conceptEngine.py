"""ConceptEngine — distill a document tree into one master concept.

Design (embed-first, LLM-skim):
1. **Seed** the running/master concept with the *prompt's own concept* via one
   `Agent.Sage` call (distills the prompt text into its core concept).
2. **Bulk-embed all sections up front** (one cheap embed pass over raw text,
   no LLM at all).
3. Compare every section's raw-text embedding to the running concept (cosine).
   Sections at/above the threshold are ``covered`` and **skip the Sage call
   entirely**.
4. Only genuinely-different sections are folded into the running concept via
   the agent (one `Sage` call per unique concept) — this *merges the
   difference* into the master concept, so the running concept advances.
"""

from __future__ import annotations

import re
import json
import uuid

from loguru import logger
from utilis.model import Agent
from utilis.embeddings import Embedder
from utilis.store import SqliteDatabase
from utilis.timing import timed


_SIM_THRESHOLD = 0.85  # similarity at/above this => section is covered
_RELEVANCE_THRESHOLD = 0.7  # retained for backward compatibility; no longer
# used as the primary gate (see relevance_floor below)
# Measured on theisus.md over 3 relevant + 3 off-topic seeds, scoring each
# section's prose against the seed: 0.60 yields 72% recall at 0% false
# positives. Scoring the LLM-compressed concept string instead discarded ~91%
# of relevant sections.
_RELEVANCE_FLOOR = 0.60
# Ranking cap, not a relevance bar: binds only on large documents.
_RANK_TOP_K = 80
# How many selected sections receive an LLM concept extraction.
_CONCEPT_TOP_N = 30
# survey refuses to start above this section count without --survey-force.
_SURVEY_SECTION_LIMIT = 200
# Concepts folded per merge call. N concepts cost ~N/fanin + log_fanin(N)
# instead of N serial calls.
_MERGE_FANIN = 8
_MAX_SECTION_CHARS = 6000


class ConceptEngine:
    def __init__(
        self,
        agent: Agent | None = None,
        embedder: Embedder | None = None,
        similarity_threshold: float = _SIM_THRESHOLD,
        database: SqliteDatabase | None = None,
        relevance_threshold: float = _RELEVANCE_THRESHOLD,
        relevance_floor: float = _RELEVANCE_FLOOR,
        rank_top_k: int = _RANK_TOP_K,
        concept_top_n: int = _CONCEPT_TOP_N,
        concept_mode: str = "reference",
    ):
        self.agent = agent if agent is not None else Agent()
        self.embedder = embedder if embedder is not None else Embedder.get()
        self.similarity_threshold = similarity_threshold
        self.relevance_threshold = relevance_threshold
        self.relevance_floor = relevance_floor
        self.rank_top_k = rank_top_k
        self.concept_top_n = concept_top_n
        self.concept_mode = concept_mode
        self.database = database if database is not None else SqliteDatabase()

    @timed("ConceptEngine.run")
    def run(self, parsed: dict, prompt_hint: str = "") -> dict:
        """Analyze the tree and synthesize the master concept. ``prompt_hint``
        is the user's actual request and seeds the running concept, so sections
        are matched against the prompt itself rather than the document. Returns
        and persists ``{unique_id, title, concept, sections, unique_concepts,
        confidence, covered_sections, total_sections}``."""
        title = str(parsed.get("title", "") or "")
        unique_id = parsed.get("unique_id", "")
        sections = self.analyze(parsed, prompt_hint=prompt_hint)
        seed_concept = str(getattr(self, "_seed_concept", "") or "").strip()
        if not seed_concept:
            seed_concept = str(
                next(
                    (
                        s.get("concept")
                        for s in sections
                        if not s.get("covered") and (s.get("concept") or "").strip()
                    ),
                    "",
                )
                or ""
            ).strip()
        report = self.synthesize(title, sections, seed_concept=seed_concept)

        # B2: a master that is a near-verbatim source heading means the fold
        # drifted onto the source document instead of the user's request. When
        # no section is relevant (selected == 0) the seed IS the topic, so keep it.
        master = str(report.get("concept") or "").strip()
        if seed_concept and self._is_source_heading(master, sections):
            logger.warning(
                "concept source: folded-document REJECTED - master {!r} is a source "
                "heading; restoring user seed {!r}",
                master[:60], seed_concept[:60],
            )
            report["concept"] = seed_concept
            report["concept_source"] = "seed"
        else:
            report["concept_source"] = "folded-document" if seed_concept else "seed"

        payload = {
            "unique_id": unique_id,
            "title": title,
            "concept": report["concept"],
            "concept_source": report.get("concept_source", "seed"),
            "sections": sections,
            "unique_concepts": report["unique_concepts"],
            "confidence": report["confidence"],
            "covered_sections": report["covered_sections"],
            "off_topic_sections": report.get("off_topic_sections", 0),
            "merged_concepts": report.get("merged_concepts", 0),
            "merge_calls": report.get("merge_calls", 0),
            "total_sections": len(sections),
        }
        if unique_id:
            self.database.set(f"concept:{unique_id}", payload)
        return payload

    @timed("ConceptEngine.analyze")
    def analyze(self, parsed: dict, prompt_hint: str = "") -> list[dict]:
        """Depth-first walk over the tree; -> [{path, no, title, concept,
        confidence, covered, text_chars}, ...].

        Compares each section's raw text to the running concept *first* (a
        cheap embed, no LLM). Sections already covered are marked and skip the
        Sage call entirely; only genuinely-different sections are folded into
        the running concept via the agent (one LLM call per unique concept).
        The running concept is seeded from the prompt's own concept.
        """
        sections = self._flatten(parsed.get("sections", []))
        prompt_seed = self._prompt_concept(
            parsed.get("title", ""), parsed, prompt_hint=prompt_hint
        )
        self._seed_concept = str(prompt_seed.get("concept") or "").strip()
        self._seed_confidence = prompt_seed.get("confidence", 0.0)
        self._seed_embedding = (
            self.embedder.embed_one(self._seed_concept) if self._seed_concept else None
        )
        concepts = []
        rows: list[dict] = []
        for path, no, node_title, text in sections:
            has_text = bool((text or "").strip())
            # Relevance is measured against the section's own prose, falling back
            # to its title when a section has no body text.
            probe = (text or "").strip() or node_title
            probe_emb = self.embedder.embed_one(probe) if probe.strip() else None
            seed_sim = None
            if self._seed_embedding is not None and probe_emb is not None:
                try:
                    seed_sim = round(
                        self.embedder.similarity(self._seed_embedding, probe_emb), 4
                    )
                except Exception:
                    seed_sim = None
            rows.append(
                {
                    "path": path,
                    "no": no,
                    "title": node_title,
                    "_text": text,
                    "_emb": probe_emb,
                    "concept": "",
                    "confidence": 0.0,
                    "covered": not has_text,
                    "seed_similarity": seed_sim,
                    "extracted": False,
                    "text_chars": len(text),
                }
            )

        selected_ids = self._select(rows)

        # Extraction budget: only the best few selected sections pay for an LLM
        # call. Everything else keeps its title as a cheap stand-in concept, so
        # it can still contribute to the master without a token cost.
        extract_count = (
            len(selected_ids)
            if self.concept_mode == "survey"
            else self.concept_top_n
        )
        extract_ids = set(selected_ids[:extract_count])
        deferred = 0

        for index, row in enumerate(rows):
            if index not in selected_ids:
                row["concept"] = row["title"]
                row["covered"] = True
                deferred += 1
                continue
            if index not in extract_ids or row["covered"]:
                row["concept"] = row["title"]
                row["confidence"] = self.similarity_threshold
                row["covered"] = True
                continue
            sage = self._section_concept(row["title"], row["_text"])
            row["concept"] = sage["concept"]
            row["confidence"] = sage["confidence"]
            row["extracted"] = True
            row["covered"] = False

        for row in rows:
            row.pop("_text", None)
            row.pop("_emb", None)
            concepts.append(row)

        self._selection_stats = {
            "total": len(rows),
            "selected": len(selected_ids),
            "extract_budget": extract_count,
            "deferred": deferred,
        }
        return concepts

    def _select(self, rows: list[dict]) -> list[int]:
        """Indices of sections that survive relevance ranking, best first."""
        ranked = sorted(
            range(len(rows)),
            key=lambda i: (rows[i].get("seed_similarity") or 0.0),
            reverse=True,
        )
        selected = [
            i for i in ranked if (rows[i].get("seed_similarity") or 0.0) >= self.relevance_floor
        ]
        return selected[: self.rank_top_k]

    @timed("ConceptEngine._flatten")
    def _flatten(self, sections: list) -> list[tuple]:
        """Depth-first flatten of the section tree into ``[(path, no, title,
        text), ...]`` rows (root section emits path "" and is included). The
        parser nests subsections under ``children`` and stores prose in
        ``blocks[*].content``."""
        rows: list[tuple] = []
        for sec in sections or []:
            if not isinstance(sec, dict):
                continue
            no = sec.get("no")
            no = "" if no is None else str(no)
            path = sec.get("path", "") or ""
            title = (sec.get("title") or "").strip()
            text = self._section_text(sec.get("blocks"))
            rows.append((path, no, title, text))
            rows.extend(self._flatten(sec.get("children") or []))
        return rows

    @staticmethod
    def _is_source_heading(concept: str, sections: list[dict]) -> bool:
        """True when ``concept`` is (near-verbatim) a source section heading."""
        def key(value: str) -> set[str]:
            return {
                w for w in re.findall(r"[a-z0-9]+", str(value or "").lower())
                if len(w) > 3
            }

        target = key(concept)
        if len(target) < 2:
            return False
        for row in sections:
            candidate = key(row.get("title") or row.get("concept"))
            if not candidate:
                continue
            overlap = len(target & candidate) / min(len(target), len(candidate))
            if overlap >= 0.8:
                return True
        return False

    @staticmethod
    def _section_text(blocks: list) -> str:
        """Join a section's block contents into one bounded blob of prose."""
        parts: list[str] = []
        for block in blocks or []:
            if isinstance(block, str):
                content = block
            elif isinstance(block, dict):
                content = block.get("content")
            else:
                content = None
            if isinstance(content, str) and content.strip():
                parts.append(content.strip())
        return "\n\n".join(parts)[:_MAX_SECTION_CHARS]

    @timed("ConceptEngine._prompt_concept")
    def _prompt_concept(self, title: str, parsed: dict, prompt_hint: str = "") -> dict:
        """One Sage call distilling the *prompt itself* into its core concept
        -> ``{concept, confidence}``. This seeds ``running`` so every section is
        matched against what the prompt actually asked for. ``prompt_hint`` (the
        user's real request) takes precedence over the parsed document text.

        B1: when no user prompt exists the concept must come back EMPTY rather
        than silently falling back to the source document's title/text. That
        fallback is what let a *source heading* become the research topic, which
        then anchored every query, entity resolution, and query set on it.
        """
        title = str(title if title is not None else "")
        user_prompt = (prompt_hint or "").strip()
        if not user_prompt:
            logger.warning(
                "concept source: fallback (no user prompt) - research topic is "
                "unanchored; refusing to seed from document text"
            )
            return {"concept": "", "confidence": 0.0}

        prompt_text = user_prompt
        seed_label = user_prompt
        sage = self.agent.Sage(seed_label, prompt_text)
        concept = getattr(sage, "concept", None) or (
            sage.get("concept") if isinstance(sage, dict) else None
        )
        # Never let the distilled concept silently become the document title.
        concept = str(concept or "").strip()
        if concept and concept.lower() == title.strip().lower():
            concept = ""
        logger.info("concept source: seed prompt={!r} concept={!r}", user_prompt[:60], concept[:60])
        return {
            "concept": concept,
            "confidence": getattr(sage, "confidence", None) or (
                sage.get("confidence", 0.0) if isinstance(sage, dict) else 0.0
            ),
        }

    @timed("ConceptEngine._section_concept")
    def _section_concept(self, node_title: str, node_text: str) -> dict:
        """One Sage call distilling a genuinely-different section -> ``{concept,
        confidence}``; compared against the running concept's text."""
        sage = self.agent.Sage(node_title, node_text)
        return {
            "concept": getattr(sage, "concept", None) or (
                sage.get("concept") if isinstance(sage, dict) else None
            ) or node_title,
            "confidence": getattr(sage, "confidence", None) or (
                sage.get("confidence", 0.0) if isinstance(sage, dict) else 0.0
            ),
        }

    @timed("ConceptEngine._merge_concepts")
    def _merge_concepts(self, master: str, other: str, title: str = "") -> dict:
        """Fold ``other`` into the running master via one Sage call; returns the
        merged ``{concept, confidence}``."""
        prompt = (
            f"Fold the new concept into the existing master concept.\n"
            f"MASTER CONCEPT: {master}\nNEW CONCEPT: {other}\n\n"
            "The master concept is the topic the user actually asked for and is the"
            " anchor. Keep the master topic as the result. Use the new concept only"
            " for supporting detail that is relevant to it; if the new concept is"
            " about a different subject, ignore it and restate the master concept."
        )
        sage = self.agent.Sage(title or "master concept", prompt)
        return {
            "concept": getattr(sage, "concept", None) or (
                sage.get("concept") if isinstance(sage, dict) else None
            ) or master,
            "confidence": getattr(sage, "confidence", None) or (
                sage.get("confidence", 0.0) if isinstance(sage, dict) else 0.0
            ),
        }

    @timed("ConceptEngine.synthesize")
    def synthesize(
        self, title: str, sections: list[dict], seed_concept: str = ""
    ) -> dict:
        """Fold every unique (non-covered) section concept into one master
        concept -> ``{concept, unique_concepts, confidence, covered_sections}``.
        The master is anchored on ``seed_concept`` (the user's actual request) so
        off-topic source sections cannot hijack it. Sections whose concept is not
        relevant to ``seed_concept`` are skipped as off-topic. Covered sections
        are skipped — no LLM call for them."""
        covered_sections = sum(1 for s in sections if s.get("covered"))
        unique = [s for s in sections if not s.get("covered")]

        master = str(seed_concept or "").strip()
        confs: list[float] = []
        unique_concepts: list[str] = []
        off_topic = 0

        # Selection is rank-based over each section's similarity to the seed,
        # measured on the section's own prose. Comparing the LLM-compressed
        # concept string instead collapsed the signal: on theisus.md that
        # discarded ~91% of genuinely relevant sections while still admitting
        # nothing off-topic. Prose separates cleanly at this floor.
        ranked = sorted(
            unique, key=lambda s: (s.get("seed_similarity") or 0.0), reverse=True
        )
        selected = []
        for sec in ranked:
            if (sec.get("seed_similarity") or 0.0) < self.relevance_floor:
                off_topic += 1
                continue
            selected.append(sec)
            if len(selected) >= self.rank_top_k:
                break

        scored = [s for s in sections if s.get("seed_similarity") is not None]
        sims = [s["seed_similarity"] for s in scored]
        logger.info(
            "CONCEPT_SELECTION {}", json.dumps(
                {
                    "scored": len(scored),
                    "selected": len(selected),
                    "below_floor": len(scored) - len(selected),
                    "deferred": max(0, len(selected) - self.concept_top_n),
                    "off_topic": off_topic,
                    "sim_min": round(min(sims), 3) if sims else None,
                    "sim_max": round(max(sims), 3) if sims else None,
                    "floor": self.relevance_floor,
                    "rank_top_k": self.rank_top_k,
                    "concept_top_n": self.concept_top_n,
                    "mode": self.concept_mode,
                }
            )
        )

        for sec in selected:
            con = (sec.get("concept") or "").strip()
            if not con:
                continue
            unique_concepts.append(con)
            confs.append(float(sec.get("confidence") or 0.0))

        master, merge_confs = self._merge_tree(
            master, unique_concepts, title
        )
        confs.extend(merge_confs)

        master = str(master.strip() or (title or "").strip() or "Unspecified concept.")
        return {
            "concept": master,
            "unique_concepts": unique_concepts,
            "confidence": round(sum(confs) / len(confs), 4) if confs else 0.0,
            "covered_sections": covered_sections,
            "off_topic_sections": off_topic,
            "merged_concepts": len(unique_concepts),
            "merge_calls": len(merge_confs),
        }

    @timed("ConceptEngine._merge_tree")
    def _merge_tree(
        self, seed: str, concepts: list[str], title: str = ""
    ) -> tuple[str, list[float]]:
        """Fold concepts into one master using batched merge calls.

        Merging pairwise costs one call per concept, and a tree of pairwise
        folds costs the same: collapsing k concepts pairwise still takes k-1
        calls. The saving comes from batching k concepts into a single call, so
        N concepts cost ceil(N/fanin) + ceil(.../fanin) calls.
        """
        pool = [c for c in dict.fromkeys(concepts) if c]
        if not pool:
            return seed, []
        if len(pool) == 1:
            return pool[0], []

        confs: list[float] = []
        anchor = seed or pool[0]
        remaining = pool

        # Fold batches down to one, keeping the seed as the anchor.
        while len(remaining) > 1:
            nxt: list[str] = []
            for start in range(0, len(remaining), _MERGE_FANIN):
                batch = remaining[start : start + _MERGE_FANIN]
                if len(batch) == 1:
                    nxt.append(batch[0])
                    continue
                merged = self._merge_batch(anchor, batch, title)
                confs.append(float(merged.get("confidence") or 0.0))
                nxt.append(merged["concept"])
            if len(nxt) == len(remaining):
                break
            remaining = nxt

        return remaining[0] if remaining else seed, confs

    def _merge_batch(self, master: str, batch: list[str], title: str = "") -> dict:
        """Merge a batch of concepts in one call, with a pairwise fallback."""
        merger = getattr(self.agent, "MergeConcepts", None)
        if merger is not None:
            try:
                result = merger(master, batch)
                concept = getattr(result, "concept", None)
                if concept:
                    return {"concept": concept, "confidence": getattr(result, "confidence", 0.0)}
            except Exception:
                pass
        # Fallback: fold pairwise so a failure never loses the master.
        folded = batch[0]
        for concept in batch[1:]:
            folded = self._merge_concepts(folded, concept, title)["concept"]
        return {"concept": folded, "confidence": 0.0}
