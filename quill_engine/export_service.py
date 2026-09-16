"""Service 10 — ExportService: project -> markdown / DOCX / PDF file.

Preserves section ordering and headings (``.agent/agent.md`` §10).
Markdown is the canonical MVP format; DOCX uses python-docx, PDF uses fpdf2.
"""

from __future__ import annotations

import os
import re
from functools import lru_cache

from docx import Document as DocxDocument
from docx.enum.text import WD_ALIGN_PARAGRAPH

from . import config
from . import md_rewriter, validation_service
from .models import GenerationResult, Section, Warning
from .storage import StorageService


class ExportError(RuntimeError):
    """Raised for unsupported formats or missing content."""


_IMAGE_PLACEHOLDER_RE = re.compile(r"\[IMAGE:\s*(.*?)\]", re.IGNORECASE)


def _render_image_placeholders(text: str) -> str:
    """Turn ``[IMAGE: caption]`` markers into blank-line-padded markdown
    images so the export has a visible, spaced slot for each photo."""
    def _replace(match: re.Match[str]) -> str:
        caption = match.group(1).strip() or "figure"
        return f"\n\n![{caption}](image-placeholder.jpg)\n\n"

    return _IMAGE_PLACEHOLDER_RE.sub(_replace, text)


def _md_heading(level: int) -> str:
    return "#" * min(6, max(2, level + 1))


def _strip_leading_heading(text: str) -> str:
    """Drop a markdown heading at the very start of generated text.

    The section tree is the source of truth for headings; the writer emits
    none, but legacy/lenient outputs may include a ``#`` heading or a bold
    ``**TITLE**`` line, and either must not duplicate the tree heading.
    """
    lines = text.strip().splitlines()
    first = lines[0].lstrip() if lines else ""
    if first.startswith("#") or re.fullmatch(r"\*\*[^*]+\*\*", first.strip()):
        lines = lines[1:]
    return "\n".join(lines).strip()


def _section_source_text(section: Section) -> str:
    """Prose stored on the section tree itself (imported/manual content).

    AI runs store bodies as generations; without one the description and
    content units carry the prose, so the whole-document view and export
    render more than a heading skeleton.
    """
    parts: list[str] = []
    if section.description:
        parts.append(section.description)
    for unit in section.content:
        parts.append(unit.text)
    return "\n\n".join(parts).strip()


def _render_markdown(
    sections: list[Section],
    generations: dict[str, GenerationResult],
    *,
    title: str | None = None,
) -> str:
    lines: list[str] = []
    if title:
        lines.append(f"# {title}")
        lines.append("")
    for section in _walk(sections):
        result = generations.get(section.section_id)
        if result is not None and result.status == "blocked":
            lines.append(f"{_md_heading(section.level)} {section.title}")
            lines.append("")
            lines.append("_[content omitted: missing required evidence]_")
            lines.append("")
            continue
        heading = _md_heading(section.level)
        lines.append(f"{heading} {section.title}")
        if result is not None and result.text:
            body = _strip_leading_heading(_render_image_placeholders(result.text))
        else:
            body = _section_source_text(section)
        if body:
            lines.append("")
            lines.append(body)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _render_docx(
    sections: list[Section],
    generations: dict[str, GenerationResult],
    out_path: str,
) -> None:
    doc = DocxDocument()
    for section in _walk(sections):
        level = min(6, max(2, section.level + 1))
        result = generations.get(section.section_id)
        if result is not None and result.status == "blocked":
            doc.add_heading(section.title, level=level)
            doc.add_paragraph("[content omitted: missing required evidence]")
            continue
        doc.add_heading(section.title, level=level)
        if result is not None and result.text:
            body = _strip_leading_heading(result.text)
        else:
            body = _section_source_text(section)
        for paragraph in body.split("\n"):
            text = paragraph.strip()
            if not text:
                continue
            image_match = _IMAGE_PLACEHOLDER_RE.search(text)
            if image_match:
                p = doc.add_paragraph()
                run = p.add_run(f"[ IMAGE PLACEHOLDER: {image_match.group(1).strip()} ]")
                run.italic = True
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                continue
            p = doc.add_paragraph(text)
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    doc.save(out_path)


@lru_cache(maxsize=1)
def _pdf_font_paths() -> tuple[str, str, str, str]:
    """Locate a serif TTF quartet (regular, bold, italic, bold-italic).

    fpdf2's built-in core fonts are Latin-1 only, which garbles the
    typographic punctuation and non-Latin scripts writers use, so real TTFs
    are preferred. Search a short allow-list of system locations; any missing
    style falls back to the regular/bold file so export never hard-fails.
    """
    families = {
        "dejavu": (
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf",
        ),
        "liberation": (
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf",
        ),
        "liberation2": (
            "/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSerif-Italic.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSerif-BoldItalic.ttf",
        ),
        "georgia-mac": (
            "/System/Library/Fonts/Supplemental/Georgia.ttf",
            "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
            "/System/Library/Fonts/Supplemental/Georgia Italic.ttf",
            "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf",
        ),
    }
    for name, (regular, bold, italic, bold_italic) in families.items():
        if not os.path.exists(regular) or not os.path.exists(bold):
            continue
        # fpdf2 requires a real file for every style we register; fall back
        # to an existing sibling (bold for bold-italic, regular for italic)
        # rather than dropping the style entirely.
        italic_path = italic if os.path.exists(italic) else regular
        bold_italic_path = bold_italic if os.path.exists(bold_italic) else bold
        return regular, bold, italic_path, bold_italic_path
    return "", "", "", ""


def _render_pdf(
    sections: list[Section],
    generations: dict[str, GenerationResult],
    out_path: str,
    *,
    title: str | None = None,
) -> None:
    """Render the assembled document to PDF via fpdf2.

    Markdown emphasises (``**bold**`` / ``*italic*``) are honoured through
    fpdf2's ``markdown=True`` multi_cell mode; ``[IMAGE: …]`` placeholders
    become centred caption lines, matching the DOCX renderer.
"""
    from fpdf import FPDF

    pdf = FPDF(format="letter")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.set_margins(22, 20, 22)
    pdf.add_page()

    regular, bold, italic, bold_italic = _pdf_font_paths()
    if regular:
        pdf.add_font("Body", "", regular)
        pdf.add_font("Body", "B", bold)
        pdf.add_font("Body", "I", italic)
        pdf.add_font("Body", "BI", bold_italic)
        pdf.set_font("Body", "", 11)
    else:
        pdf.set_font("Helvetica", "", 11)

    if title:
        pdf.set_font("Body" if regular else "Helvetica", "B", 20)
        pdf.multi_cell(0, 9, title, align="C", new_x="LMARGIN")
        pdf.ln(6)

    for section in _walk(sections):
        level = min(6, max(2, section.level + 1))
        result = generations.get(section.section_id)
        if result is not None and result.status == "blocked":
            pdf.ln(4)
            pdf.set_font("Body" if regular else "Helvetica", "B", 13)
            pdf.multi_cell(0, 7, section.title, new_x="LMARGIN")
            pdf.set_font("Body" if regular else "Helvetica", "I", 10)
            pdf.multi_cell(
                0, 6, "[content omitted: missing required evidence]",
                new_x="LMARGIN",
            )
            continue

        heading_size = max(11, 16 - level)
        pdf.ln(4)
        pdf.set_font("Body" if regular else "Helvetica", "B", heading_size)
        pdf.multi_cell(0, 7, section.title, new_x="LMARGIN")

        if result is not None and result.text:
            body = _strip_leading_heading(result.text)
            for paragraph in body.split("\n"):
                text = paragraph.strip()
                if not text:
                    continue
                image_match = _IMAGE_PLACEHOLDER_RE.search(text)
                if image_match:
                    pdf.set_font("Body" if regular else "Helvetica", "I", 10)
                    pdf.multi_cell(
                        0, 6, f"[ IMAGE PLACEHOLDER: {image_match.group(1).strip()} ]",
                        align="C",
                        new_x="LMARGIN",
                    )
                    continue
                pdf.set_font("Body" if regular else "Helvetica", "", 11)
                pdf.multi_cell(0, 6.5, text, markdown=True, align="J", new_x="LMARGIN")

    pdf.output(out_path)


def _ensure_generations(
    project_id: str,
    sections: list[Section],
    store: StorageService,
    generations: dict[str, GenerationResult],
) -> dict[str, GenerationResult]:
    """Re-derive (via the rewrite cascade) any section that is missing,
    failed, blocked, or carries severe validation warnings.

    Gated by ``config.EXPORT_REWRITE_SECTIONS`` so the emitted document is
    cleaned up at write time instead of only on generate; disabled, the
    stored generations are used verbatim.
    """
    if not config.EXPORT_REWRITE_SECTIONS:
        return generations

    for section in _walk(sections):
        result = generations.get(section.section_id)
        needs_rewrite = result is None or result.status != "generated"
        if not needs_rewrite and result.text:
            warnings = validation_service.check(section.section_id, result.text)
            needs_rewrite = validation_service.has_severe(warnings)
        if needs_rewrite:
            generations[section.section_id] = md_rewriter.rewrite_section(
                project_id, section.section_id, store
            )
    return generations


def preview(
    project_id: str,
    store: StorageService,
    *,
    title: str | None = None,
) -> str:
    """Return the assembled markdown document without writing any file.

    Same assembly path as :func:`export` (``_render_markdown``) so what the
    user previews is byte-identical to what gets exported; used by the TUI
    preview modal. Raises :class:`ExportError` when the project has no
    sections.
    """
    sections = store.get_sections(project_id)
    if not sections:
        raise ExportError(f"project has no sections: {project_id}")

    generations = {
        section.section_id: store.get_generation(project_id, section.section_id)
        for section in _walk(sections)
    }
    generations = _ensure_generations(project_id, sections, store, generations)
    return _render_markdown(sections, generations, title=title)


def render_document(
    project_id: str,
    store: StorageService,
    *,
    title: str | None = None,
) -> str:
    """Assemble the stored generations read-only (no rewrite cascade).

    Like :func:`preview` but skips ``_ensure_generations``, so a GET of the
    whole-document draft can compare (or surface) the live tree without ever
    triggering an LLM rewrite. Same heading/body rendering as preview.
    """
    sections = store.get_sections(project_id)
    if not sections:
        return ""
    generations = {
        section.section_id: store.get_generation(project_id, section.section_id)
        for section in _walk(sections)
    }
    return _render_markdown(sections, generations, title=title)


def export(
    project_id: str,
    store: StorageService,
    *,
    fmt: str = "markdown",
    out_dir: str | None = None,
    out_path: str | None = None,
    title: str | None = None,
) -> str:
    """Export a project's generated sections; returns the output file path.

    ``fmt`` is one of ``"markdown"``/``"md"``, ``"docx"``, or ``"pdf"``.
    ``title`` becomes the document's ``#`` heading (omitted when None).
    ``out_path`` (when given) is the exact destination, overriding the
    ``out_dir``/``{project_id}.{ext}`` default.
    """
    sections = store.get_sections(project_id)
    if not sections:
        raise ExportError(f"project has no sections: {project_id}")

    generations = {
        section.section_id: store.get_generation(project_id, section.section_id)
        for section in _walk(sections)
    }
    generations = _ensure_generations(project_id, sections, store, generations)

    if out_path:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    normalized = fmt.lower()
    if normalized in {"markdown", "md"}:
        out_path = out_path or os.path.join(out_dir or config.EXPORT_DIR, f"{project_id}.md")
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(_render_markdown(sections, generations, title=title))
        return out_path

    if normalized == "docx":
        out_path = out_path or os.path.join(out_dir or config.EXPORT_DIR, f"{project_id}.docx")
        _render_docx(sections, generations, out_path)
        return out_path

    if normalized == "pdf":
        out_path = out_path or os.path.join(out_dir or config.EXPORT_DIR, f"{project_id}.pdf")
        _render_pdf(sections, generations, out_path, title=title)
        return out_path

    raise ExportError(f"unsupported format: {fmt} (markdown|docx|pdf)")


def _walk(sections: list[Section]) -> list[Section]:
    from .models import walk_sections

    return walk_sections(sections)
