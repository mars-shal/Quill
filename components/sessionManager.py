"""Named sessions: a session groups one request, its source document, and the
artifacts it produces. The session name is what gets saved to disk."""

from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timezone

from utilis.store import SqliteDatabase
from utilis.timing import timed


_FILLER = {
    "hey", "hi", "hello", "can", "could", "would", "you", "please", "i", "we",
    "need", "want", "like", "to", "me", "my", "our", "write", "create", "make",
    "generate", "produce", "draft", "prepare", "compose", "a", "an", "the",
    "new", "thesis", "thieasis", "essay", "paper", "article", "report",
    "on", "about", "for", "regarding", "concerning", "that", "is", "this",
    "and", "give", "do",
}

_SMALL_WORDS = {"of", "the", "and", "in", "on", "for", "to", "a", "an"}

_TRAILING = _FILLER | {
    "from", "with", "without", "between", "across", "through", "during",
    "under", "over", "into", "than", "as", "by", "at", "vs", "versus",
    "using", "via", "per",
}

_ACRONYMS = {
    "pir", "iot", "pcb", "cad", "ai", "usb", "hmi", "nlp", "api", "cpu", "gpu",
    "led", "lidar", "radar", "ac", "dc", "vr", "ar", "ui", "ux", "3d", "5g",
}


@timed("SessionManager.derive_name")
def derive_name(prompt: str) -> str:
    """Turn a request into a short human title, e.g.
    'Write a new thesis about the demolition of the stadium of Rome'
    -> 'Desimation of the Stadium of Rome'."""
    text = re.sub(r"[^a-z0-9\s]", " ", (prompt or "").lower())
    words = [w for w in text.split() if w]
    while words and words[0] in _FILLER:
        words.pop(0)
    words = words[:8]
    while words and words[-1] in _TRAILING:
        words.pop()
    if not words:
        return "Untitled Session"
    titled = [
        w.upper() if w in _ACRONYMS else (w if (i and w in _SMALL_WORDS) else w[:1].upper() + w[1:])
        for i, w in enumerate(words)
    ]
    return " ".join(titled)


@timed("SessionManager.slugify")
def slugify(name: str) -> str:
    """Filesystem-safe form of a session name."""
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", (name or "").strip())
    slug = re.sub(r"-{2,}", "-", slug).strip("-._")
    return slug or "untitled-session"


class SessionManager:
    """Create, name, rename, list, and save sessions."""

    def __init__(self, db: SqliteDatabase | None = None, output_dir: str = ""):
        self.db = db if db is not None else SqliteDatabase()
        self.output_dir = output_dir or os.path.join(
            os.path.dirname(__file__), "..", "output"
        )
        self._current_id = ""

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def _index(self) -> list[dict]:
        rows = self.db.get("sessions") or []
        return rows if isinstance(rows, list) else []

    def _write_index(self, rows: list[dict]) -> None:
        self.db.set("sessions", rows)

    @timed("SessionManager.create")
    def create(
        self, prompt: str, document_id: str = "", name: str = ""
    ) -> dict:
        """Start a new session. ``name`` defaults to one derived from the prompt."""
        now = self._now()
        session = {
            "id": uuid.uuid4().hex[:12],
            "name": (name or "").strip() or derive_name(prompt),
            "prompt": prompt or "",
            "document_id": document_id or "",
            "created_at": now,
            "updated_at": now,
        }
        self.db.set(f"session:{session['id']}", session)
        rows = [r for r in self._index() if r.get("id") != session["id"]]
        rows.append(self.summary(session))
        self._write_index(rows)
        self._current_id = session["id"]
        return session

    @staticmethod
    def summary(session: dict) -> dict:
        return {
            "id": session.get("id", ""),
            "name": session.get("name", ""),
            "prompt": session.get("prompt", ""),
            "document_id": session.get("document_id", ""),
            "created_at": session.get("created_at", ""),
            "updated_at": session.get("updated_at", ""),
        }

    @timed("SessionManager.get")
    def get(self, session_id: str) -> dict:
        return self.db.get(f"session:{session_id}") or {}

    @timed("SessionManager.list")
    def list(self) -> list[dict]:
        return self._index()

    @timed("SessionManager.current")
    def current(self) -> dict:
        return self.get(self._current_id) if self._current_id else {}

    @timed("SessionManager.set_current")
    def set_current(self, session_id: str) -> dict:
        session = self.get(session_id)
        if not session:
            return {}
        self._current_id = session_id
        return session

    @timed("SessionManager.rename")
    def rename(self, name: str, session_id: str = "") -> dict:
        """Rename a session (defaults to the current one) and return it."""
        target = session_id or self._current_id
        session = self.get(target)
        if not session:
            return {}
        new_name = (name or "").strip()
        if not new_name:
            return session
        session["name"] = new_name
        session["updated_at"] = self._now()
        self.db.set(f"session:{session['id']}", session)
        rows = [
            self.summary(self.get(r.get("id", "")))
            if r.get("id") != session["id"]
            else self.summary(session)
            for r in self._index()
        ]
        self._write_index([r for r in rows if r.get("id")])
        return session

    @timed("SessionManager.attach_document")
    def attach_document(self, document_id: str, session_id: str = "") -> dict:
        target = session_id or self._current_id
        session = self.get(target)
        if not session or not document_id:
            return session
        session["document_id"] = document_id
        session["updated_at"] = self._now()
        self.db.set(f"session:{session['id']}", session)
        self.rename(session["name"], session["id"])
        return session

    @staticmethod
    def _research_report(payload: dict) -> str:
        """Full research artifact.

        Previously this file received only the Scout summary string, so any
        run that did not reach status "done" wrote a 0-byte file and the
        corpus was never persisted at all.
        """
        research = payload.get("research") or ""
        parts: list[str] = []
        if isinstance(research, str):
            parts.append(research.strip())
        elif research:
            parts.append(str(research))

        pages = payload.get("research_pages") or []
        corpus = payload.get("research_corpus") or ""
        quality = payload.get("research_quality")
        relevant = payload.get("research_relevant_pages")

        metrics = [f"- Corpus size: {len(corpus)} chars"]
        if quality is not None:
            metrics.append(f"- Research quality: {quality}")
        if relevant is not None:
            metrics.append(f"- Relevant pages: {relevant}")
        if payload.get("low_research") is not None:
            metrics.append(f"- Low research: {bool(payload['low_research'])}")
        if any(len(m) > 20 for m in metrics):
            parts.append("\n## Evidence metrics\n" + "\n".join(metrics))

        if pages:
            listing = ["\n## Retrieved sources"]
            for page in pages:
                listing.append(
                    f"\n### [{page.get('level', '?')}] {page.get('title', '(untitled)')}\n"
                    f"- URL: {page.get('url', '')}\n"
                    f"- Snippet: {page.get('snippet', '')[:300]}\n"
                    f"- Chars: {page.get('chars', 0)}"
                )
            parts.append("\n".join(listing))

        if corpus:
            parts.append("\n## Corpus (verbatim)\n\n" + corpus)

        return "\n\n".join(p for p in parts if p.strip()) + "\n"

    @timed("SessionManager.save")
    def save(self, payload: dict, session_id: str = "") -> str:
        """Write artifacts named after the session. Returns the saved path."""
        session = self.get(session_id) if session_id else self.current()
        if not session:
            return ""
        stem = slugify(session.get("name", ""))
        os.makedirs(self.output_dir, exist_ok=True)
        base = os.path.join(self.output_dir, stem)

        with open(f"{base}.md", "w", encoding="utf-8") as fh:
            fh.write(payload.get("markdown", ""))
        with open(f"{base}.research.md", "w", encoding="utf-8") as fh:
            fh.write(self._research_report(payload))
        plagiarism = payload.get("plagiarism")
        if plagiarism:
            text = plagiarism if isinstance(plagiarism, str) else str(plagiarism)
            with open(f"{base}.plagiarism.md", "w", encoding="utf-8") as fh:
                fh.write(text)
            if isinstance(plagiarism, dict):
                voice = (plagiarism.get("document_check") or {}).get("natural_voice")
                if voice:
                    from utilis.style import to_markdown
                    with open(f"{base}.style.md", "w", encoding="utf-8") as fh:
                        fh.write(to_markdown(voice))

        session["output_path"] = f"{stem}.md"
        session["updated_at"] = self._now()
        self.db.set(f"session:{session['id']}", session)
        self.rename(session["name"], session["id"])
        print(f"[SAVED] output/{stem}.md (+research, +plagiarism)")
        return f"{base}.md"
