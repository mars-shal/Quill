"""Service 2 — SectionParser: markdown -> section tree.

Port of the former ``SectionFinder`` regex logic (verified against
swep-report.docx), adapted to the ``Section``/``ContentUnit`` contracts.
Pure parsing — no embeddings here (that's EmbeddingService's job).
"""

from __future__ import annotations

import hashlib
import re

from .models import ContentUnit, Section, count_words, new_section

_CHAPTER_RE = re.compile(
    r"^\*{0,2}\s*CHAPTER\s+([0-9]+|[A-Z]+)\s*\*{0,2}\s*:?\s*(.*?)\s*\*{0,2}\s*$",
    re.IGNORECASE,
)
_SECTION_RE = re.compile(r"^(\d+(?:\.\d+)*)\s*\.?\s+(.+)$")
_ABSTRACT_RE = re.compile(r"^\*{0,2}\s*ABSTRACT\s*\*{0,2}\s*$", re.IGNORECASE)
_TOC_RE = re.compile(r"^(?:TABLE OF CONTENT|TABLE OF CONTENTS)$", re.IGNORECASE)
_ALLCAPS_RE = re.compile(r"^[A-Z][A-Z0-9 &'\-/,()?.]{2,80}$")
_IMAGE_RE = re.compile(r"!\[.*?\]\(.*?\)")
_PAGE_NUM_RE = re.compile(r"^\d+$")
_TABLE_SEP_RE = re.compile(r"^\|[\s\-:|]+\|$")
_TABLE_HEADER_RE = re.compile(r"^\|\s*\*\*")
_TABLE_ROW_RE = re.compile(r"^\|.*\|$")


def _strip_md(text: str) -> str:
    """Remove markdown images/bold and collapse whitespace."""
    return " ".join(_IMAGE_RE.sub("", text).replace("**", "").replace("*", "").split())


def _strip_heading(text: str) -> str:
    """Remove markdown heading markers (``#``) so regexes see the heading text."""
    return re.sub(r"^\#{1,6}\s*", "", text)


def _heading_depth(line: str) -> int:
    """Markdown heading depth from ``#`` markers; bold/plain dialect is flat (2)."""
    m = re.match(r"^\s*(#{1,6})", line)
    if m:
        return len(m.group(1))
    return 2


def _is_heading(line: str, title: str) -> bool:
    """True when a numbered probe reads as a heading rather than a list item.

    ``#``-prefixed lines are explicit markdown headings (new markitdown
    dialect) and always win. Numbered list items are otherwise rejected via
    trailing period/colon, a long run of lowercase words, or a bold-wrapped
    title that is not all-caps ("1. **AND Gate**" is a list item, while
    "1. **WHY IS SWEP NECESSARY?**" from the old dialect is a heading).
    """
    if not title or len(title) > 100 or not any(c.isupper() for c in title):
        return False
    if line.lstrip().startswith("#"):
        return True
    if "**" in line and not _ALLCAPS_RE.match(title):
        return False
    if title.endswith(".") or title.endswith(":"):
        return False
    if ":" in title and any(c.islower() for c in title.split(":", 1)[1]):
        return False
    words = title.split()
    if len(words) >= 5:
        lowercase_after_first = sum(1 for w in words[1:] if w.islower())
        if lowercase_after_first >= 3:
            return False
    return True


def _render_table_row(data: dict[str, str]) -> str:
    """Embedding-ready rendering of a table row (matches old _chunk_to_text)."""
    return " | ".join(f"{k}: {v}" for k, v in data.items() if v)


def parse(markdown_text: str, *, include_content: bool = True) -> list[Section]:
    """Find chapters + subsections via regex, returning an ordered tree.

    * chapters -> level 1 sections
    * numbered/bold subheadings -> level 2+ child sections, nested by
      markdown heading depth (``##`` -> level 2, ``###`` -> level 3, ...)
    * paragraphs -> ``ContentUnit(kind="paragraph")`` on leaf sections
    * table data rows -> ``ContentUnit(kind="table_row")`` with table_data
    * byte-identical chapters are dropped (see duplicate CHAPTER FIVE)

    With ``include_content=False`` only the structure is kept: headings,
    levels, ordering, and the parent/child shape — every paragraph and
    table row is discarded. Used for structure-only ingestion, where the
    template's prose must never reach the writer as evidence.
    """
    lines = markdown_text.splitlines()

    # Start at the body (ABSTRACT / first CHAPTER), skipping cover + TOC.
    # Heading markers are stripped first ("# **ABSTRACT**" -> "ABSTRACT").
    start = 0
    for i, line in enumerate(lines):
        if _ABSTRACT_RE.match(_strip_md(_strip_heading(line.strip()))):
            start = i
            break
    else:
        for i, line in enumerate(lines):
            stripped = line.strip()
            if (stripped.startswith("#") or stripped.startswith("*")) and _CHAPTER_RE.match(
                _strip_md(_strip_heading(stripped))
            ):
                start = i
                break

    # Chapters are built as dicts first (mirrors the verified SectionFinder
    # scan order), then normalized into Section objects with stable ids.
    # Subheadings form a tree keyed on markdown heading depth; list items
    # that are not headings fall through to content.
    chapters: list[dict] = []
    current: dict | None = None
    stack: list[dict] = []  # open subheadings, deepest last
    table_columns: list[str] | None = None
    expect_title = False  # next non-empty line may be an all-caps chapter title
    in_toc = False  # inside the table of contents region -> skip entries

    def push_sub(sub: dict) -> None:
        """Attach ``sub`` under the nearest open heading with a shallower depth."""
        while stack and stack[-1]["depth"] >= sub["depth"]:
            stack.pop()
        (stack[-1]["children"] if stack else current["children"]).append(sub)
        stack.append(sub)

    def add_content(line: str) -> None:
        if not include_content:
            return
        if stack:
            stack[-1]["content"].append(line)
        elif current is not None:
            current["description_lines"].append(line)

    for line in map(str.strip, lines[start:]):
        if not line:
            continue
        if _PAGE_NUM_RE.match(line):
            continue
        # Table header row -> remember column names for data-row parsing
        if _TABLE_HEADER_RE.match(line):
            table_columns = [_strip_md(c) for c in line.strip("|").split("|")]
            continue
        if _TABLE_SEP_RE.match(line):
            continue
        if _IMAGE_RE.search(line) and not _strip_md(line):
            continue

        # Strip markdown heading markers + bold ("# **CHAPTER ONE**" -> "CHAPTER ONE").
        probe = _strip_md(_strip_heading(line))

        # TOC entries mirror body headings (with page numbers) — skip them
        # until the first markdown-formatted chapter/abstract heading.
        if in_toc:
            if _CHAPTER_RE.match(probe) or _ABSTRACT_RE.match(probe):
                if line.startswith("#") or line.startswith("*"):
                    in_toc = False
                else:
                    continue
            else:
                continue

        if _TOC_RE.match(probe):
            in_toc = True
            continue

        # Chapter heading: "**CHAPTER ONE**", "CHAPTER FIVE", "CHAPTER 5:"
        m = _CHAPTER_RE.match(probe)
        if m:
            number, title = m.group(1), _strip_md(m.group(2))
            header = f"CHAPTER {number}" + (f": {title}" if title else "")
            current = {"header": header, "description_lines": [], "children": []}
            chapters.append(current)
            stack.clear()
            expect_title = True
            continue

        # ABSTRACT
        if _ABSTRACT_RE.match(probe):
            current = {"header": "ABSTRACT", "description_lines": [], "children": []}
            chapters.append(current)
            stack.clear()
            expect_title = False
            continue

        # Chapter title on its own line, e.g. "CONCLUSION AND RECOMMENDATION"
        if expect_title:
            expect_title = False
            if current and _ALLCAPS_RE.match(probe):
                current["header"] += f": {probe}"
                continue

        # Numbered subheading: "1. **WHY IS SWEP NECESSARY?**", "5.1 Conclusion"
        m = _SECTION_RE.match(probe)
        if m and current is not None:
            number, title = m.group(1), m.group(2)
            if _is_heading(line, title):
                heading = f"{number} {title}" if "." in number else f"{number}. {title}"
                push_sub(
                    {
                        "subheading": heading,
                        "content": [],
                        "children": [],
                        "depth": _heading_depth(line),
                    }
                )
                continue

        # Bold all-caps heading without a number: "**STATEMENT OF PROBLEM**"
        if current is not None and ("**" in line or line.startswith("#")):
            if _ALLCAPS_RE.match(probe):
                push_sub(
                    {
                        "subheading": probe,
                        "content": [],
                        "children": [],
                        "depth": _heading_depth(line),
                    }
                )
                continue

        # Table data row -> structured content unit
        if table_columns is not None and _TABLE_ROW_RE.match(line):
            cells = [_strip_md(c) for c in line.strip("|").split("|")]
            cells = (cells + [""] * len(table_columns))[: len(table_columns)]
            data = dict(zip(table_columns, cells))
            add_content({"type": "table_row", "data": data})
            continue

        table_columns = None  # leaving the table

        if current is not None:
            add_content(line)

    # Drop chapters whose content is byte-identical to an earlier chapter.
    def subtree_body(sub: dict) -> str:
        parts = [_render_content_unit(c) for c in sub["content"]]
        for child in sub["children"]:
            parts.append(subtree_body(child))
        return " ".join(parts)

    seen: set[str] = set()
    deduped = []
    for ch in chapters:
        body = " ".join(subtree_body(s) for s in ch["children"])
        fingerprint = hashlib.md5(
            (ch["header"] + "\x00" + body).encode("utf-8")
        ).hexdigest()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        deduped.append(ch)
    chapters = deduped

    # Normalize into Section objects with global order + ids.
    sections: list[Section] = []
    order = 0

    def build_sub(sub: dict, parent_id: str) -> Section:
        nonlocal order
        order += 1
        node = new_section(
            sub["subheading"], level=sub["depth"], order=order, parent_id=parent_id
        )
        node.content = [
            u for u in (_content_unit(c) for c in sub["content"]) if u is not None
        ]
        for child in sub["children"]:
            node.children.append(build_sub(child, node.section_id))
        return node

    for ch in chapters:
        order += 1
        chapter = new_section(
            ch["header"], level=1, order=order, parent_id=None
        )
        sections.append(chapter)

        description_units = [_content_unit(l) for l in ch["description_lines"]]
        if not ch["children"]:
            # Leaf chapter: description lines ARE the body -> content.
            chapter.content = [
                u for u in description_units if u is not None
            ] or chapter.content
        else:
            chapter.description = " ".join(
                _strip_md(l) for l in ch["description_lines"] if _strip_md(l)
            )

        for sub in ch["children"]:
            chapter.children.append(build_sub(sub, chapter.section_id))

    for chapter in sections:
        count_words(chapter)

    return sections


def _content_unit(raw) -> ContentUnit | None:
    """Convert a raw scan entry (str or table_row dict) into a ContentUnit."""
    if isinstance(raw, dict):  # {"type": "table_row", "data": {...}}
        data = raw["data"]
        return ContentUnit(
            text=_render_table_row(data), kind="table_row", table_data=data
        )
    text = _strip_md(raw)
    return ContentUnit(text=text, kind="paragraph") if text else None


def _render_content_unit(unit) -> str:
    if isinstance(unit, dict):
        return _render_table_row(unit["data"])
    return _strip_md(unit)
