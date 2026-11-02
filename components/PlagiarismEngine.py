"""Plagiarism validation service.

Two checks per passage against the source material:
  1. direct - normalized 8-gram Jaccard overlap (exact/copied phrasing)
  2. semantic - embedding cosine similarity (reworded but identical meaning)

A 0-100 originality score is produced (100 = fully original), an Oracle judge
issues a verdict, and if plagiarism is judged high the flagged passages are
re-written via the Quill writer ("if plagiarism is high, write").
"""

import re

from utilis.store import SqliteDatabase
from utilis.embeddings import Embedder
from utilis.model import Agent
from utilis.pydanticModels import OracleDecision
from utilis.timing import timed

_NGRAM = 8
_FLAG_DIRECT = 0.35      # 8-gram overlap at/above => flagged
_FLAG_SEMANTIC = 0.85    # embedding similarity at/above => flagged (reworded copy)
_SEM_FLOOR = 0.80        # score contribution starts only above this similarity
_HIGH_PLAGIARISM = 60    # originality score below this => auto-correct
_SOURCE_WINDOW = 400     # chars per source window for semantic comparison
_DUP_PARAGRAPH = 0.85    # paragraph-to-paragraph similarity => near duplicate


class PlagiarismEngine:
    def __init__(
        self,
        agent: Agent | None = None,
        embedder: Embedder | None = None,
        db: SqliteDatabase | None = None,
    ):
        self.agent = agent if agent is not None else Agent()
        self.embedder = embedder if embedder is not None else Embedder.get()
        self.db = db if db is not None else SqliteDatabase()

    @timed("PlagiarismEngine.document_check")
    def document_check(self, document: str) -> dict:
        """Mechanical quality checks on the assembled draft.

        Catches the failure modes that make a draft look padded: repeated
        headings, near-duplicate paragraphs, doubled words, meta-commentary,
        and mixed numbering schemes.
        """
        from components.writingEngine import WritingEngine

        text = document or ""
        blocks = [b.strip() for b in text.split("\n\n") if b.strip()]
        headings = [b for b in blocks if re.match(r"^#{1,6}\s+", b)]

        heading_titles = [re.sub(r"^#{1,6}\s+", "", h).strip() for h in headings]
        normalised = [re.sub(r"[^a-z0-9 ]", " ", t.lower()).strip() for t in heading_titles]
        duplicate_headings = sorted({t for t in normalised if t and normalised.count(t) > 1})

        paragraphs = [b for b in blocks if not re.match(r"^#{1,6}\s+", b)]
        near_duplicates = []
        vectors: list[tuple[int, list]] = []
        for idx, para in enumerate(paragraphs):
            if len(para.split()) < 8:
                continue
            try:
                vec = self.embedder.embed_one(para)
            except Exception:
                continue
            for other_idx, other_vec in vectors:
                try:
                    sim = self.embedder.similarity(vec, other_vec)
                except Exception:
                    continue
                if sim >= _DUP_PARAGRAPH:
                    near_duplicates.append(
                        {
                            "paragraphs": [other_idx, idx],
                            "similarity": round(sim, 3),
                            "preview": para[:120],
                        }
                    )
                    break
            vectors.append((idx, vec))

        doubled = [m.group(0) for m in re.finditer(r"\b(\w+)\s+and\s+\1\b", text, re.IGNORECASE)]
        doubled += [m.group(0) for m in re.finditer(r"\b(\w+)\s+\1\b", text, re.IGNORECASE)]
        doubled = [d for d in doubled if d.split()[0].lower() not in {"had", "that"}]
        meta = WritingEngine.meta_hits(text)
        filler = WritingEngine.filler_hits(text)

        schemes = set()
        for title in heading_titles:
            match = re.match(r"(chapter|section|phase|part)\b", title, re.IGNORECASE)
            if match:
                schemes.add(match.group(1).lower())
        numbering = set()
        for title in heading_titles:
            if re.match(r"^\d+(\.\d+)*\b", title):
                numbering.add("numeric")
            elif re.match(r"^(chapter|section|phase|part)\b", title, re.IGNORECASE):
                numbering.add("named")

        words = re.findall(r"[A-Za-z0-9']+", text)
        issues: list[str] = []
        if duplicate_headings:
            issues.append(f"{len(duplicate_headings)} heading(s) appear more than once.")
        if near_duplicates:
            issues.append(f"{len(near_duplicates)} near-duplicate paragraph pair(s).")
        if doubled:
            issues.append(f"{len(doubled)} doubled word(s), e.g. '{doubled[0]}'.")
        if meta:
            issues.append(f"{len(meta)} meta-commentary sentence(s).")
        if len(schemes) > 1 or len(numbering) > 1:
            issues.append("Mixed section numbering schemes.")

        coherence = self._coherence(paragraphs, headings)

        return {
            "word_count": len(words),
            "paragraph_count": len(paragraphs),
            "heading_count": len(headings),
            "duplicate_headings": duplicate_headings,
            "near_duplicates": near_duplicates,
            "doubled_words": sorted(set(doubled))[:20],
            "meta_phrases": meta[:20],
            "meta_count": len(meta),
            "filler_phrases": filler,
            "numbering_schemes": sorted(schemes | numbering),
            "coherence": coherence["verdict"],
            "coherence_score": coherence["score"],
            "incoherent_sections": coherence["failing"],
            "refusals": coherence["refusals"],
            "coherence_detail": coherence["detail"],
            "issues": issues + coherence["issues"],
        }

    @staticmethod
    def _coherence(paragraphs: list[str], headings: list[str]) -> dict:
        """Per-section coherence signal.

        Structural checks alone rated a document containing four model
        refusals and 70%-single-token repetition as clean. This scores each
        prose block and attributes failures to the nearest preceding heading,
        so a bad section cannot hide behind an overall word count.
        """
        from components.writingEngine import WritingEngine
        from utilis.coherence import score_text

        template = getattr(WritingEngine, "RULES_TEXT", "")
        detail: list[dict] = []
        failing: list[dict] = []
        refusals: list[str] = []
        current = "(preamble)"

        for para in paragraphs:
            if para.startswith("#"):
                current = re.sub(r"^#{1,6}\s+", "", para).strip()
                continue
            score = score_text(para, template=template)
            entry = {
                "section": current[:80],
                "verdict": score["verdict"],
                "words": score["words"],
                "reasons": score["reasons"],
            }
            for key in ("ttr", "top_share", "top_word", "refusal", "echo", "chrome"):
                if key in score:
                    entry[key] = score[key]
            detail.append(entry)
            if score["words"] >= 12 and score["verdict"] != "coherent":
                failing.append({"section": current[:80], "reasons": score["reasons"]})
            if score.get("refusal"):
                refusals.append(f"{current[:60]}: {para[:120]}")

        scored = [d for d in detail if d["words"] >= 12]
        short = len(detail) - len(scored)
        if not scored:
            return {
                "verdict": "unknown", "score": 0.0, "failing": failing,
                "refusals": refusals, "detail": detail, "issues": [],
            }
        ratio = sum(1 for d in scored if d["verdict"] == "coherent") / len(scored)
        issues: list[str] = []
        if refusals:
            issues.append(f"{len(refusals)} section(s) contain refusal or non-answer text.")
        if failing:
            suffix = f" ({short} further block(s) too short to score)" if short else ""
            issues.append(
                f"{len(failing)} of {len(scored)} scored section(s) are incoherent "
                f"(repetition, echo, or off-register vocabulary).{suffix}"
            )
        verdict = "coherent" if ratio == 1.0 else ("degraded" if ratio >= 0.5 else "incoherent")
        return {
            "verdict": verdict,
            "score": round(ratio, 3),
            "failing": failing,
            "refusals": refusals,
            "detail": detail,
            "issues": issues,
        }

    @timed("PlagiarismEngine.run")
    def run(self, document: str, sources: list[str], unique_id: str = "") -> dict:
        """Full flow: check, score, judge; auto-correct if plagiarism is high."""
        report = self.check(document, sources)
        if report["score"] < _HIGH_PLAGIARISM:
            corrected = self.correct(document, report, sources)
            report["original_score"] = report["score"]
            report["corrected_score"] = self.check(corrected, sources, judge=False)["score"]
            report["corrected_text"] = corrected
        report.setdefault("corrected_text", document)
        report["document_check"] = self.document_check(report.get("corrected_text") or document)
        if unique_id:
            self.db.set(f"written:{unique_id}", report)
        return report

    @timed("PlagiarismEngine.check")
    def check(self, document: str, sources: list[str], judge: bool = True) -> dict:
        passages = self._split(document)
        source_windows = [w for src in sources for w in self._windows(src)]

        source_vecs = self.embedder.embed(source_windows) if source_windows else []
        flagged: list[dict] = []
        risks = []

        for passage in passages:
            p_tokens = self._tokens(passage)
            ngrams = set(self._ngrams(p_tokens)) if len(p_tokens) >= _NGRAM else set()

            direct = 0.0
            for src in sources:
                direct = max(direct, self._jaccard(ngrams, set(self._ngrams(self._tokens(src)))))

            sem = 0.0
            if source_vecs and passage.strip():
                pv = self.embedder.embed_one(passage)
                sem = max(
                    (self.embedder.similarity(pv, sv) for sv in source_vecs), default=0.0
                )

            risk = max(direct, self._sem_risk(sem))
            risks.append((risk, len(passage)))

            if direct >= _FLAG_DIRECT or sem >= _FLAG_SEMANTIC:
                flagged.append(
                    {
                        "passage": passage,
                        "direct": round(direct, 3),
                        "semantic": round(sem, 3),
                        "risk": round(risk, 3),
                    }
                )

        total_len = sum(length for _, length in risks) or 1
        overall_risk = sum(r * length for r, length in risks) / total_len
        score = round(100 * (1 - overall_risk))

        verdict: OracleDecision | None = None
        judgment = ""
        if not flagged:
            # No passages: skip the call. An empty prompt yields a generic
            # non-sequitur ("ask the user what they would like to do").
            judgment = (
                f"Originality {score}/100: no passages exceeded the "
                f"direct or semantic similarity thresholds, so nothing was "
                f"flagged for review."
            )
        elif judge:
            verdict = self.agent.Oracle(
                self._judgment_prompt(score, flagged)
            )
            judgment = (verdict.thoughts or "").strip()

        return {
            "score": score,
            "verdict": "high" if score < _HIGH_PLAGIARISM else ("moderate" if score < 85 else "clean"),
            # Review is informational: Oracle must not pause to ask the user.
            "decision": (verdict.decision if verdict and verdict.decision
                         in {"continue_research", "done"} else "done"),
            "judgment": judgment or "No flagged passages.",
            "flagged": flagged,
            "flagged_count": len(flagged),
        }

    @staticmethod
    def _judgment_prompt(score: int, flagged: list[dict]) -> str:
        lines = [
            f"- direct={f['direct']} semantic={f['semantic']} :: {f['passage'][:160]}"
            for f in flagged[:8]
        ]
        return (
            "TASK: You are reviewing a generated document for plagiarism and "
            "originality. This is an informational review only.\n"
            f"Originality score: {score}/100 (100 = fully original).\n"
            f"Flagged passages (direct = verbatim n-gram overlap, semantic = "
            f"embedding similarity to a source):\n" + "\n".join(lines) +
            "\n\nINSTRUCTIONS:\n"
            "1. Judge ONLY this document. Do not ask the reader anything, do not "
            "suggest talking to the user, and do not discuss unrelated next steps.\n"
            "2. State which flagged passages are genuine reuse of a source versus "
            "incidental phrase overlap.\n"
            "3. Give one concrete corrective action if score < 85, else say the "
            "draft is original enough.\n"
            "4. Always set decision to 'done'. Set 'ask_user' or 'continue_research' "
            "only if work is genuinely blocked.\n"
            "Answer in 2-4 sentences." )

    @timed("PlagiarismEngine.correct")
    def correct(self, document: str, report: dict, sources: list[str]) -> str:
        """Rewrite flagged passages in-place via the Quill writer."""
        passages = self._split(document)
        flags = {f["passage"]: f for f in report["flagged"]}
        rebuilt = []
        for passage in passages:
            flag = flags.get(passage)
            if flag and (
                flag["direct"] >= _FLAG_DIRECT or flag["semantic"] >= _FLAG_SEMANTIC
            ):
                rebuilt.append(self._rewrite(passage))
            else:
                rebuilt.append(passage)
        return "\n\n".join(p for p in rebuilt if p)

    @classmethod
    def _sem_risk(cls, similarity: float) -> float:
        """Semantic risk ramps 0..1 only once similarity passes the floor."""
        if similarity <= _SEM_FLOOR:
            return 0.0
        return (similarity - _SEM_FLOOR) / (1.0 - _SEM_FLOOR)

    @timed("PlagiarismEngine._rewrite")
    def _rewrite(self, passage: str) -> str:
        prompt = (
            "Rewrite the following passage to express the same meaning with "
            "substantially different wording and sentence structure, so it does not "
            f"read as copied text:\n\n{passage}"
        )
        rewritten = self.agent.Quill(prompt, skill="Paraphrase: keep every fact and number intact.")
        return rewritten.strip() or passage

    # --- helpers -------------------------------------------------------------
    @classmethod
    def _tokens(cls, text: str) -> list[str]:
        return re.findall(r"[a-z0-9]+", (text or "").lower())

    @classmethod
    def _ngrams(cls, tokens: list[str], n: int = _NGRAM) -> list[tuple[str, ...]]:
        return [tuple(tokens[i : i + n]) for i in range(len(tokens) - n + 1)]

    @classmethod
    def _jaccard(cls, a: set, b: set) -> float:
        if not a or not b:
            return 0.0
        inter = len(a & b)
        return inter / len(a | b)

    @classmethod
    def _split(cls, text: str) -> list[str]:
        parts = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p and p.strip()]
        return parts if parts else [text.strip()] if text.strip() else []

    @classmethod
    def _windows(cls, text: str, size: int = _SOURCE_WINDOW, cap: int = 120) -> list[str]:
        words = (text or "").split()
        if not words:
            return []
        if len(words) // (size // 5) <= cap:
            stride = size // 5
        else:
            stride = size
        windows = []
        for i in range(0, len(words), stride):
            windows.append(" ".join(words[i : i + size]))
            if len(windows) >= cap:
                break
        return [w for w in windows if w]
