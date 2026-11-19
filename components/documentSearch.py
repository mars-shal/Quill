"""Search and structural audit for the document the reader has open.

Search mode is deliberately not web research. "Did you remove the Miller
effect?" is a question about the draft, and the answer has to come from the
draft -- including the parts outside the first 12,000 characters a chat prompt
usually carries. The functions here are deterministic and cheap: they locate
relevant paragraphs across the whole document, and they report the structural
problems that make a generated document unusable (a halt stub, placeholder
sections, leaked chat history, broken emphasis).

The result is evidence, not prose. ``Task.Search`` decides whether to answer
directly (absence, structure) or to let the model phrase an answer from the
excerpts.
"""

from __future__ import annotations

import re

# Question scaffolding. These are not subjects, and matching them would make
# every document look relevant to every question.
_STOPWORDS = frozenset(
    """
    a about above after again all also am an and any are as at be because been
    before being below between both but by can could did do does doing done
    down during each few for from further had has have having he her here hers
    him his how i if in into is it its itself just me might more most my no nor
    not now of off on once only or other our out over own same she should so
    some such than that the their them then there these they this those through
    to too under until up very was we were what when where which while who whom
    why will with would you your please tell show find check see give removed
    remove eliminate eliminated delete deleted gone still
    """.split()
)

# A structural question asks about the document's shape or a failed generation,
# not about a fact inside it. Those answers are produced deterministically so a
# thin model cannot invent a cause.
_STRUCTURAL = re.compile(
    r"\b(ast|outline|generation|generated|halted|halt|insufficient|corpus|"
    r"placeholder|structure|structural|headings?|sections?|evidence|quality|"
    r"relevant\s+pages?|why\s+(?:did|was|is)|what\s+went\s+wrong)\b",
    re.IGNORECASE,
)
_YES_NO = re.compile(
    r"^\s*(?:did|does|do|is|are|was|were|has|have|had|can|could|should)\b",
    re.IGNORECASE,
)
_HALT = re.compile(r"Generation Halted\s*[—-]\s*Insufficient Research Evidence", re.IGNORECASE)
_NO_CONTENT = re.compile(r"THIS RUN PRODUCED NO CONTENT|INSUFFICIENT EVIDENCE", re.IGNORECASE)
_SKIPPED = re.compile(r"^\s*##\s+Skipped outline\s*$", re.IGNORECASE | re.MULTILINE)
_LEAK = re.compile(r"\b(?:assistant|user)\s*:|New conversation\.|EFFORT:", re.IGNORECASE)
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_GATE_CORPUS = re.compile(
    r"Corpus size:\s*(?:\*\*)?([\d,]+)\s*chars(?:\*\*)?\s*"
    r"\(minimum\s*(\d+)\)",
    re.IGNORECASE,
)
_GATE_PAGES = re.compile(
    r"Relevant pages:\s*(?:\*\*)?(\d+)(?:\*\*)?\s*\(minimum\s*(\d+)\)",
    re.IGNORECASE,
)
_GATE_QUALITY = re.compile(
    r"Research quality:\s*(?:\*\*)?([\d.]+)(?:\*\*)?\s*"
    r"\(minimum\s*([\d.]+)\)",
    re.IGNORECASE,
)


def _normalise_word(word: str) -> str:
    """A rough stem that handles the forms a reader actually types."""
    word = word.lower().replace("\u2019", "'").strip("'")
    if word.endswith("'s"):
        word = word[:-2]
    elif word.endswith("s") and not word.endswith("ss") and len(word) > 4:
        word = word[:-1]
    return word


def search_terms(question: str) -> list[str]:
    """The content words a question is really about, in order, deduplicated."""
    text = str(question or "").lower().replace("\u2019", "'")
    terms: list[str] = []
    for raw in re.findall(r"[a-z0-9][a-z0-9'_-]*", text):
        word = _normalise_word(raw)
        if len(word) < 3 or word in _STOPWORDS or word.isdigit():
            continue
        if word not in terms:
            terms.append(word)
    return terms[:8]


def is_structural_question(question: str) -> bool:
    """Whether the turn asks about the document's shape or a failed run."""
    return bool(_STRUCTURAL.search(str(question or "")))


def is_yes_no_question(question: str) -> bool:
    """Whether the reader expects a present/absent answer rather than prose."""
    return bool(_YES_NO.search(str(question or "")))


def _pattern(term: str) -> re.Pattern:
    # "Miller" also finds "Miller's" and "Millers"; "effect" finds "effects".
    return re.compile(rf"\b{re.escape(term)}(?:'s|s|es)?\b", re.IGNORECASE)


def _blocks(markdown: str) -> list[dict]:
    """Paragraphs with the heading and line they belong to."""
    lines = str(markdown or "").splitlines()
    blocks: list[dict] = []
    heading = ""
    level = 0
    start = 1
    current: list[str] = []

    def flush() -> None:
        if not current:
            return
        text = "\n".join(current).strip()
        if text:
            blocks.append({
                "heading": heading,
                "level": level,
                "line": start,
                "text": text,
            })

    for number, line in enumerate(lines, start=1):
        match = _HEADING.match(line)
        if match:
            flush()
            current = []
            level = len(match.group(1))
            heading = match.group(2).strip()
            start = number + 1
        elif not line.strip():
            flush()
            current = []
            start = number + 1
        else:
            if not current:
                start = number
            current.append(line)
    flush()
    return blocks


def _snippet(text: str, terms: list[str], limit: int = 520) -> str:
    """The most relevant window of a paragraph, not its first 520 characters."""
    lowered = text.lower()
    at = -1
    for term in terms:
        found = lowered.find(term)
        if found >= 0 and (at < 0 or found < at):
            at = found
    if at < 0 or len(text) <= limit:
        return " ".join(text.split())[:limit]
    start = max(0, at - limit // 3)
    end = min(len(text), start + limit)
    body = " ".join(text[start:end].split())
    return f"{'…' if start else ''}{body}{'…' if end < len(text) else ''}"


def search_document(markdown: str, question: str, limit: int = 5) -> dict:
    """Find the passages that answer a question about the whole draft."""
    terms = search_terms(question)
    blocks = _blocks(markdown)
    counts = {term: 0 for term in terms}
    hits: list[dict] = []

    for block in blocks:
        score = 0
        matched: list[str] = []
        for term in terms:
            found = len(_pattern(term).findall(block["text"]))
            if found:
                counts[term] += found
                score += found
                matched.append(term)
        if score:
            hits.append({
                "heading": block["heading"],
                "line": block["line"],
                "score": score,
                "terms": matched,
                "text": _snippet(block["text"], matched),
            })

    hits.sort(key=lambda hit: (-hit["score"], hit["line"]))
    return {
        "terms": terms,
        "counts": counts,
        "missing": [term for term, count in counts.items() if not count],
        "matches": sum(counts.values()),
        "hits": hits[:limit],
        "has_evidence": bool(hits),
    }


def audit_document(markdown: str) -> dict:
    """The document's shape and the defects a reader would have to fix."""
    text = str(markdown or "")
    lines = text.splitlines()
    headings: list[dict] = []
    issues: list[dict] = []

    for number, line in enumerate(lines, start=1):
        match = _HEADING.match(line)
        if match:
            headings.append({
                "line": number,
                "level": len(match.group(1)),
                "title": match.group(2).strip(),
            })

    gate = {}
    corpus = _GATE_CORPUS.search(text)
    pages = _GATE_PAGES.search(text)
    quality = _GATE_QUALITY.search(text)
    if _HALT.search(text) or corpus:
        gate = {
            "corpus": int(corpus.group(1).replace(",", "")) if corpus else 0,
            "corpus_min": int(corpus.group(2)) if corpus else 0,
            "pages": int(pages.group(1)) if pages else 0,
            "pages_min": int(pages.group(2)) if pages else 0,
            "quality": float(quality.group(1)) if quality else 0.0,
            "quality_min": float(quality.group(2)) if quality else 0.0,
        }

    for number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if _NO_CONTENT.search(stripped):
            issues.append({
                "line": number,
                "kind": "placeholder",
                "detail": "This is a generation stub, not document content.",
            })
        if _LEAK.search(stripped):
            issues.append({
                "line": number,
                "kind": "leaked-chat",
                "detail": "Chat transcript text leaked into the outline.",
            })
        if stripped.startswith("*-") or stripped.startswith("*+"):
            issues.append({
                "line": number,
                "kind": "broken-markdown",
                "detail": "A list marker starts with an unmatched emphasis asterisk.",
            })
        elif stripped.startswith("*") and stripped.count("*") % 2 == 1:
            issues.append({
                "line": number,
                "kind": "broken-markdown",
                "detail": "An italic span is never closed on this line.",
            })

    # An empty section is worse than a missing one: the heading promises content
    # and the reader finds nothing under it.
    for index, heading in enumerate(headings):
        end = headings[index + 1]["line"] if index + 1 < len(headings) else len(lines) + 1
        body = " ".join(lines[heading["line"]: end - 1]).strip()
        if not body:
            issues.append({
                "line": heading["line"],
                "kind": "empty-section",
                "detail": f"“{heading['title']}” has no content.",
            })

    words = len(re.findall(r"\b[\w'-]+\b", text))
    duplicates = [
        title for title in {h["title"] for h in headings}
        if sum(1 for h in headings if h["title"] == title) > 1
    ]

    return {
        "words": words,
        "headings": headings,
        "issues": issues,
        "gate": gate,
        "skipped_outline": bool(_SKIPPED.search(text)),
        "duplicate_headings": sorted(duplicates),
        "halted": bool(_HALT.search(text)),
    }


def _gate_lines(gate: dict) -> list[str]:
    if not gate:
        return []
    corpus_ok = gate["corpus"] >= gate["corpus_min"]
    pages_ok = gate["pages"] >= gate["pages_min"]
    quality_ok = gate["quality"] >= gate["quality_min"]
    lines = [
        "**Why the run halted**",
        "",
        "| Gate | Value | Minimum | Result |",
        "| --- | ---: | ---: | --- |",
        f"| Corpus size | {gate['corpus']:,} chars | {gate['corpus_min']:,} | "
        f"{'pass' if corpus_ok else 'fail'} |",
        f"| Relevant pages | {gate['pages']} | {gate['pages_min']} | "
        f"{'pass' if pages_ok else 'fail'} |",
        f"| Research quality | {gate['quality']:.3f} | {gate['quality_min']:.2f} | "
        f"{'pass' if quality_ok else 'fail'} |",
        "",
    ]
    if corpus_ok and not (pages_ok and quality_ok):
        lines.append(
            "The corpus is large enough, but no page in it was judged relevant "
            "to the subject. Size alone does not satisfy this gate."
        )
    return lines


def render_audit(audit: dict, question: str = "", found: dict | None = None) -> str:
    """A deterministic answer for a structural question or a failed run."""
    lines: list[str] = []
    lines.extend(_gate_lines(audit.get("gate") or {}))

    if audit.get("halted"):
        lines.extend([
            "**What happened**",
            "",
            "The writer refused to publish sections because it judged the "
            "research too thin or off-topic. The text above is an outline, not "
            "a document; it should not be treated as written content.",
            "",
            "**How to recover**",
            "",
            "1. A rewrite or reformat of an existing document does not need web "
            "research. The document is its own evidence, so run it as an edit "
            "(Format) rather than a fresh write.",
            "2. For a fresh subject, rerun research against the actual topic and "
            "check that at least one returned page passes the relevance gate.",
            "3. If those pages are unrelated, narrow the prompt: the subject, "
            "the reader and the angle are what the researcher searches for.",
        ])

    issues = audit.get("issues") or []
    if issues:
        lines.extend(["", "**Document problems found**", ""])
        grouped: dict[str, list[dict]] = {}
        for issue in issues:
            grouped.setdefault(issue["kind"], []).append(issue)
        labels = {
            "placeholder": "Placeholder content",
            "leaked-chat": "Chat history leaked into the document",
            "broken-markdown": "Broken Markdown emphasis",
            "empty-section": "Empty sections",
        }
        for kind, entries in grouped.items():
            sample = "; ".join(
                f"line {entry['line']} — {entry['detail']}" for entry in entries[:4]
            )
            more = f" (and {len(entries) - 4} more)" if len(entries) > 4 else ""
            lines.append(f"- **{labels.get(kind, kind)}:** {sample}{more}")

    if audit.get("duplicate_headings"):
        lines.append(
            "- **Duplicate headings:** "
            + ", ".join(f"“{title}”" for title in audit["duplicate_headings"])
        )

    if not issues and not audit.get("halted") and not audit.get("gate"):
        headings = audit.get("headings") or []
        lines.append(
            f"The document is {audit.get('words', 0):,} words with "
            f"{len(headings)} heading(s). No halt stub, placeholder section, "
            "leaked transcript or broken emphasis was found."
        )
        if headings:
            lines.extend(["", "**Outline**", ""])
            for heading in headings[:20]:
                lines.append(f"- {'  ' * (heading['level'] - 1)}{heading['title']}")

    if found and found.get("hits"):
        lines.extend(["", "**Matching passages**", ""])
        lines.extend(_hit_lines(found))

    return "\n".join(lines).strip()


def _hit_lines(found: dict) -> list[str]:
    lines: list[str] = []
    for hit in found.get("hits") or []:
        where = hit.get("heading") or "top of document"
        lines.append(f"- **{where}** (line {hit['line']}): {hit['text']}")
    return lines


def render_presence(found: dict) -> str:
    """A short, trustworthy statement of which query terms exist."""
    if not found.get("terms"):
        return ""
    present = [term for term, count in (found.get("counts") or {}).items() if count]
    missing = found.get("missing") or []
    parts: list[str] = []
    if present:
        parts.append("found " + ", ".join(f"“{term}”" for term in present))
    if missing:
        parts.append("not found " + ", ".join(f"“{term}”" for term in missing))
    return "**In this draft:** " + "; ".join(parts) + "."


def render_no_hits(found: dict, audit: dict) -> str:
    """A deterministic answer when nothing in the draft matches."""
    terms = found.get("terms") or []
    if not terms:
        return "Give me a word or phrase to look for in the draft."
    quoted = ", ".join(f"“{term}”" for term in terms)
    lines = [
        f"No occurrence of {quoted} was found in the open draft.",
        "",
        f"The draft is {audit.get('words', 0):,} words across "
        f"{len(audit.get('headings') or [])} heading(s).",
    ]
    headings = audit.get("headings") or []
    if headings:
        lines.extend(["", "Headings currently in the document:", ""])
        for heading in headings[:12]:
            lines.append(f"- {heading['title']}")
    return "\n".join(lines)
