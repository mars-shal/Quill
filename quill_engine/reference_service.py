"""Service — ReferenceService: resolve @-mentions in prompts to file content.

The TUI accepts ``@path`` mentions in prompts (e.g. ``@annex.docx`` or
``@docs/``); each mention is resolved to a file or directory and its
content is attached as always-relevant evidence alongside retrieval.
Resolved mentions are removed from the prompt; unresolved ones stay in
place so the user sees the token was not expanded.
"""

from __future__ import annotations

import os
import re

from . import document_processor

_MENTION_RE = re.compile(r"@([^\s@,;:()]+)")
_TRAILING_PUNCT_RE = re.compile(r"[.,;:!?)]+$")
_MAX_REFERENCE_CHARS = 12_000
_MAX_DIR_ENTRIES = 100


def _clean_mention(token: str) -> str:
    return _TRAILING_PUNCT_RE.sub("", token)


def _load_file(path: str) -> str | None:
    """The file's text (converted for non-plain formats), or ``None``."""
    try:
        doc = document_processor.process(path)
    except Exception:
        return None
    return doc.markdown_text[:_MAX_REFERENCE_CHARS]


def _load_dir(path: str) -> str | None:
    """A top-level listing of ``path``, or ``None`` when unreadable."""
    try:
        entries = sorted(os.listdir(path))
    except OSError:
        return None
    lines = [f"directory listing of {path}:"]
    for entry in entries[:_MAX_DIR_ENTRIES]:
        full = os.path.join(path, entry)
        lines.append(f"- {entry}{'/' if os.path.isdir(full) else ''}")
    if len(entries) > _MAX_DIR_ENTRIES:
        lines.append(f"- ... and {len(entries) - _MAX_DIR_ENTRIES} more")
    return "\n".join(lines)


def expand_references(prompt: str) -> tuple[str, list[tuple[str, str]]]:
    """Expand ``@path`` mentions in ``prompt`` to ``(label, text)`` pairs.

    Paths resolve relative to the current working directory; absolute
    paths work too. A resolved mention is removed from the returned
    prompt; an unresolved one stays in place. Directories contribute a
    listing, files their text, capped per mention.
    """
    references: list[tuple[str, str]] = []
    clean_parts: list[str] = []
    last = 0
    for match in _MENTION_RE.finditer(prompt):
        raw = match.group(1)
        token = _clean_mention(raw)
        if not token:
            continue
        content = _load_dir(token) if os.path.isdir(token) else _load_file(token)
        if content is None:
            continue
        references.append((token, content))
        # Consume only up to the cleaned token; any punctuation stripped by
        # _clean_mention (e.g. the "." in "@annex.md.") stays in the prompt.
        end = match.start() + 1 + len(token)
        clean_parts.append(prompt[last:match.start()])
        last = end
    if not references:
        return prompt, []
    clean_parts.append(prompt[last:])
    return "".join(clean_parts), references
