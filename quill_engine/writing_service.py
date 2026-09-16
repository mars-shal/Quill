"""Service 7 — WritingService: PromptPackage -> generated text.

Constraints (``.agent/agent.md`` §7):
* no external retrieval — only what's in the PromptPackage
* no filesystem access
* deterministic temperature for MVP (0.2–0.4)

Generation walks the provider failover chain (config ``LLM_PROVIDERS``,
default Groq -> OpenRouter -> Google): a provider that is rate-limited or
otherwise failing is marked down and the next one is tried. When every
provider is in cooldown, the call waits for the earliest cooldown to
expire (up to ``LLM_ALL_DOWN_MAX_WAIT_S``) and retries, so one exhausted
provider never fails the run.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

from openai import APIError, RateLimitError

from . import config, providers
from .models import PromptPackage

logger = logging.getLogger(__name__)

# Compact evidence used by the staged planning pass: per-chunk char cap and
# chunk count, so the plan call stays tiny even for small-context models.
_PLAN_CHUNKS = 10
_PLAN_CHUNK_CHARS = 300
_PLAN_MAX_TOKENS = 512

_PLAN_SYSTEM = (
    "You are a writing planner. From the evidence below, list the key beats "
    "the section body must cover, one per line, as short imperatives. Use "
    "only facts present in the evidence. Output only the numbered list."
)


class WritingError(RuntimeError):
    """Raised when every provider in the chain failed."""


class GenerationCancelled(RuntimeError):
    """Raised mid-stream when the caller's ``cancel`` callback fires."""


def _parse_duration(raw: str) -> float | None:
    try:
        return float(raw[:-1]) if raw.endswith("s") else float(raw)
    except (TypeError, ValueError):
        return None


def _retry_after(exc: RateLimitError) -> float | None:
    """Retry-After from the response header, then the body's retryDelay."""
    headers = getattr(getattr(exc, "response", None), "headers", None) or {}
    raw = headers.get("retry-after")
    if raw is not None:
        delay = _parse_duration(raw)
        if delay is not None:
            return delay
    body = getattr(exc, "body", None)
    if isinstance(body, list):
        for item in body:
            error = item.get("error") if isinstance(item, dict) else None
            if not isinstance(error, dict):
                continue
            for detail in error.get("details", []):
                if not isinstance(detail, dict):
                    continue
                raw_delay = detail.get("retryDelay")
                if isinstance(raw_delay, str):
                    delay = _parse_duration(raw_delay)
                    if delay is not None:
                        return delay
    return None


def _complete(
    provider: providers.LLMProvider,
    messages: list[dict],
    *,
    cancel: Callable[[], bool] | None = None,
    on_delta: Callable[[str], None] | None = None,
) -> str:
    """One writing completion via the shared providers.complete helper.

    The call streams whenever ``cancel`` or ``on_delta`` is given —
    ``on_delta`` receives each raw text fragment as it arrives so callers
    can surface token-level progress (the full text is still returned).
    """
    return providers.complete(provider, messages, cancel=cancel, on_delta=on_delta)


def _staged_enabled() -> bool:
    """Staged (plan -> draft) writing on/off, per ``config.WRITING_STAGED``.

    ``auto`` enables it when the first provider in the chain is a local
    endpoint (Ollama/LM Studio/vLLM) or the profile is ``small`` — exactly
    the setups where a cheap planning pass buys the most coherence.
    """
    mode = config.WRITING_STAGED
    if mode in {"1", "true", "yes", "on"}:
        return True
    if mode in {"0", "false", "no", "off"}:
        return False
    if config.LLM_PROFILE == "small":
        return True
    return providers.chain()[0].name in providers.LOCAL_PROVIDERS


def _plan_beats(
    package: PromptPackage,
    *,
    cancel: Callable[[], bool] | None = None,
) -> str | None:
    """Cheap planning pass before the draft (small-model aid; never fails).

    The plan call is optional by design: any failure (no provider, API
    error, empty output) returns ``None`` and generation proceeds
    single-pass. ``GenerationCancelled`` still propagates so a cancel
    during planning aborts the section.
    """
    provider = next(iter(providers.active_chain()), None)
    if provider is None:
        return None
    evidence_lines = [
        chunk.text[:_PLAN_CHUNK_CHARS]
        for chunk in package.evidence[:_PLAN_CHUNKS]
        if chunk.text.strip()
    ]
    if not evidence_lines:
        return None
    beats = min(8, max(3, package.target_words // 80))
    user = (
        f"Section: {package.section_title}\n"
        f"Target length: {package.target_words} words "
        f"(plan about {beats} beats).\n\n"
        "Evidence:\n" + "\n".join(f"- {line}" for line in evidence_lines)
    )
    try:
        raw = providers.complete(
            provider,
            [
                {"role": "system", "content": _PLAN_SYSTEM},
                {"role": "user", "content": user},
            ],
            cancel=cancel,
            temperature=0.2,
            max_tokens=_PLAN_MAX_TOKENS,
            max_retries=0,
        )
    except GenerationCancelled:
        raise
    except Exception as exc:  # noqa: BLE001 — planning is best-effort
        logger.warning("planning pass skipped (%s)", exc)
        return None
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    return "\n".join(lines) if lines else None


def generate(
    package: PromptPackage,
    *,
    cancel: Callable[[], bool] | None = None,
    on_delta: Callable[[str], None] | None = None,
) -> str:
    """Generate the section body for ``package`` (pure function of it).

    Tries providers in configured order; on any OpenAI API failure the
    provider is marked down (honoring Retry-After/retryDelay) and the next
    one is tried. When every provider is down, waits for the earliest
    cooldown and retries. Raises ``WritingError`` only when no provider
    recovers within ``LLM_ALL_DOWN_MAX_WAIT_S``. When ``cancel`` is given
    it is polled between stream chunks and ``GenerationCancelled`` is
    raised as soon as it turns true (the caller aborts the section).
    ``on_delta`` (when given) is invoked with each raw stream fragment as
    it arrives; the completed text is still returned as one string.
    """
    messages = [
        {"role": "system", "content": package.system_instructions},
        {"role": "user", "content": package.template},
    ]
    if _staged_enabled():
        plan = _plan_beats(package, cancel=cancel)
        if plan:
            messages[1]["content"] = (
                f"{package.template}\n\nWriting plan (cover these beats in "
                f"order; expand each with specifics from the evidence):\n{plan}"
            )
            logger.info("staged writing: %d-line plan prepared", len(plan.splitlines()))

    failures: list[str] = []
    deadline = time.monotonic() + config.LLM_ALL_DOWN_MAX_WAIT_S

    while True:
        for provider in providers.active_chain():
            try:
                text = _complete(provider, messages, cancel=cancel, on_delta=on_delta)
            except RateLimitError as exc:
                providers.mark_down(provider.name, retry_after=_retry_after(exc))
                failures.append(f"{provider.name}: {exc}")
                continue
            except APIError as exc:
                providers.mark_down(provider.name)
                failures.append(f"{provider.name}: {exc}")
                continue
            if not text:
                failures.append(f"{provider.name}: empty response")
                providers.mark_down(provider.name)
                continue
            providers.record_success(provider.name, provider.model)
            logger.info("generated via provider %s (%s)", provider.name, provider.model)
            return text

        delay = providers.next_retry_delay()
        if delay is None or time.monotonic() + delay > deadline:
            break
        logger.warning("all providers down; waiting %.0fs to retry", delay)
        # Sleep in short slices so cancel is honored promptly instead of
        # hanging for the full cooldown (up to LLM_ALL_DOWN_MAX_WAIT_S).
        waited = 0.0
        while waited < delay:
            if cancel is not None and cancel():
                raise GenerationCancelled()
            time.sleep(min(1.0, delay - waited))
            waited += 1.0

    raise WritingError(
        "all LLM providers failed: "
        + "; ".join(failures)
        + f"; state: {providers.down_summary()}"
    )
