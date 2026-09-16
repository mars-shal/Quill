"""Service 1 — DocumentProcessor: file -> markdown Document.

Port of the former ``GetInspoFile`` plus the validation/OCR-fallback
responsibilities from ``.agent/agent.md`` §1.
"""

from __future__ import annotations

import logging
import os

from markitdown import MarkItDown
from openai import OpenAI

from . import config, providers
from .models import Document

logger = logging.getLogger(__name__)

# Extensions we can hand to MarkItDown today; anything else is rejected
# up front so downstream services never see a partial extraction.
_ALLOWED_EXTENSIONS = {".docx", ".doc", ".pdf", ".pptx", ".md", ".txt", ".html", ".htm"}
MAX_FILE_BYTES = 100 * 1024 * 1024  # NFR: 100 MB

# Text formats MarkItDown's PlainTextConverter would decode with the
# locale charset (ASCII on many systems) — read them as UTF-8 ourselves.
_TEXT_EXTENSIONS = {".txt", ".md", ".markdown"}

# Heuristics for "extraction quality too low -> OCR/fallback needed".
_MIN_CHARS = 200
_MAX_NON_ALNUM_RATIO = 0.5


class DocumentProcessingError(RuntimeError):
    """Raised when a file cannot be converted to markdown."""


def _validate_file(file_path: str) -> None:
    if not os.path.exists(file_path):
        raise DocumentProcessingError(f"file not found: {file_path}")
    if os.path.getsize(file_path) > MAX_FILE_BYTES:
        raise DocumentProcessingError(f"file exceeds 100 MB limit: {file_path}")
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in _ALLOWED_EXTENSIONS:
        raise DocumentProcessingError(
            f"unsupported extension '{ext}' (allowed: {sorted(_ALLOWED_EXTENSIONS)})"
        )


def _extraction_quality_is_low(text: str) -> bool:
    if len(text) < _MIN_CHARS:
        return True
    non_alnum = sum(1 for ch in text if not ch.isalnum() and not ch.isspace())
    return (non_alnum / len(text)) > _MAX_NON_ALNUM_RATIO


def process(file_path: str) -> Document:
    """Convert ``file_path`` to markdown, returning a :class:`Document`.

    MarkItDown handles most formats; when extraction quality looks too low
    we log a warning (real OCR fallback is out of MVP scope, see
    ``.agent/agent.md`` §1 "optional").
    """
    _validate_file(file_path)

    # Plain-text formats: read as UTF-8 directly. MarkItDown's
    # PlainTextConverter decodes bytes with the locale charset (ASCII on
    # many systems) and dies on non-ASCII bytes like U+00E2.
    ext = os.path.splitext(file_path)[1].lower()
    if ext in _TEXT_EXTENSIONS:
        try:
            with open(file_path, encoding="utf-8", errors="replace") as fh:
                markdown_text = fh.read()
        except OSError as exc:
            raise DocumentProcessingError(f"could not read {file_path}: {exc}") from exc
    else:
        # Image-heavy extraction needs a vision-capable LLM client. Prefer
        # the first active provider in the failover chain (so a custom
        # provider or key set in .env just works); fall back to the
        # dedicated extraction endpoint when the chain is empty.
        provider = next(iter(providers.active_chain()), None)
        if provider is not None:
            llm_client = OpenAI(
                api_key=provider.api_key or "ollama", base_url=provider.base_url
            )
            llm_model = provider.model
        else:
            llm_client = OpenAI(
                api_key=config.OPENROUTER_API_KEY, base_url=config.EXTRACTION_BASE_URL
            )
            llm_model = config.EXTRACTION_MODEL
        md = MarkItDown(
            enable_plugins=True,
            llm_client=llm_client,
            llm_model=llm_model,
        )
        # MarkItDown accepts ``file:...`` URIs; normalize a plain path for it.
        uri = file_path if file_path.startswith("file:") else f"file:{file_path}"
        try:
            result = md.convert_uri(uri)
        except Exception as exc:  # MarkItDown raises varied per-format errors
            raise DocumentProcessingError(f"MarkItDown conversion failed: {exc}") from exc
        markdown_text = result.text_content
    if _extraction_quality_is_low(markdown_text):
        logger.warning(
            "extraction quality looks low (%d chars, high non-alphanumeric ratio); "
            "OCR fallback is not implemented in MVP",
            len(markdown_text),
        )

    return Document(
        markdown_text=markdown_text,
        metadata={
            "filename": os.path.basename(file_path.rstrip(":")),
            "source_format": os.path.splitext(file_path)[1].lower(),
            "char_count": len(markdown_text),
        },
    )
