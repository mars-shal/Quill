"""Generation ledger: one metadata record per long-form run.

The record is deliberately metadata-only. It answers "what ran, on which model,
how long did each stage take, what evidence did it have, and how much did it
produce?" without copying the reader's prompt or document into a telemetry
server. The prompt is represented by a SHA-256 hash and its length; a short
preview is sent only when ``QUILL_TELEMETRY_PROMPT=1`` is set explicitly.

Every record is appended to a local JSONL file first, so the feature works
offline and the local copy is the source of truth. If ``QUILL_CONVEX_URL`` and
``QUILL_CONVEX_TOKEN`` are set, the same record is POSTed to the Convex HTTP
action in ``convex/http.ts``. A failed POST is logged and does not affect the
generation.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from pathlib import Path

from loguru import logger


def _ledger_path() -> Path:
    raw = os.environ.get("QUILL_GENERATIONS_PATH", "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path("output") / "generations.jsonl"


# The pipeline calls this with Python-style names; Convex validators are
# camelCase. Normalise at the boundary so a new metric cannot be silently
# rejected by the HTTP action.
_FIELD_ALIASES = {
    "document_id": "documentId",
    "session_id": "sessionId",
    "prompt_chars": "promptChars",
    "prompt_sha256": "promptSha256",
    "prompt_preview": "promptPreview",
    "total_ms": "totalMs",
    "research_ms": "researchMs",
    "writing_ms": "writingMs",
    "corpus_chars": "corpusChars",
    "relevant_pages": "relevantPages",
    "low_research": "lowResearch",
    "prompt_tokens": "promptTokens",
    "completion_tokens": "completionTokens",
}


def _prompt_fields(prompt: str) -> dict:
    text = str(prompt or "")
    fields = {
        "promptChars": len(text),
        "promptSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }
    if os.environ.get("QUILL_TELEMETRY_PROMPT", "").strip().lower() in (
        "1", "true", "yes", "on",
    ):
        fields["promptPreview"] = text[:280]
    return fields


def record_generation(**metrics) -> dict:
    """Append one generation record locally, then mirror it to Convex.

    ``prompt`` is accepted as a keyword for convenience but is never copied
    into the payload. Extra keyword arguments become top-level record fields,
    which keeps the call sites readable next to the pipeline stages they time.
    """
    prompt = str(metrics.pop("prompt", "") or "")
    payload = {
        "runId": str(metrics.pop("run_id", "") or uuid.uuid4().hex),
        "createdAt": int(time.time() * 1000),
        "source": "quill",
        "appVersion": os.environ.get("QUILL_APP_VERSION", "0.35.0"),
        # Defaults keep a partial caller (or a smoke test) ingestible; the
        # pipeline always supplies the real numbers.
        "task": "WRITE",
        "provider": "",
        "model": "",
        "status": "unknown",
        "totalMs": 0,
        "researchMs": 0,
        "writingMs": 0,
        "corpusChars": 0,
        "sources": 0,
        "relevantPages": 0,
        "quality": 0.0,
        "lowResearch": False,
        "words": 0,
        "sections": 0,
        "placeholders": 0,
        "promptTokens": 0,
        "completionTokens": 0,
        **_prompt_fields(prompt),
    }
    for key, value in metrics.items():
        if value is None:
            continue
        key = _FIELD_ALIASES.get(key, key)
        if isinstance(value, float):
            value = round(value, 3)
        payload[key] = value

    try:
        path = _ledger_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError as exc:
        logger.warning("generation ledger: could not write {}: {}", _ledger_path(), exc)

    url = os.environ.get("QUILL_CONVEX_URL", "").strip()
    token = os.environ.get("QUILL_CONVEX_TOKEN", "").strip()
    if url and token:
        try:
            import urllib.request

            request = urllib.request.Request(
                url,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {token}",
                },
            )
            with urllib.request.urlopen(request, timeout=8) as response:
                response.read()
        except Exception as exc:  # noqa: BLE001 - telemetry must never fail a run
            logger.warning("generation ledger: Convex post failed: {}", exc)
    return payload
