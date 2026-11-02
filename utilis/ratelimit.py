"""Sliding-window token/request rate limiting with retry + backoff.

One process-wide budget shares the provider's TPM/RPM limits across all LLM
calls (which funnel through ``Agent.model``) and all research HTTP fetches, so
one component cannot starve or 429-flood the others.

Knobs (env overrides, see README / .env.example):

- ``QUILL_TPM``   tokens per minute  (default 60000)
- ``QUILL_RPM``   requests per minute (default 60)
- ``QUILL_RETRIES`` hardened retries on 429/5xx (default 3)
- ``QUILL_OUTPUT_TOKENS`` output-token allowance booked per reservation
  (default 1200; billed usage is input + output, so input-only booking
  under-reserves the window)

Usage::

    from utilis.ratelimit import rate_limited, LIMITER

    @rate_limited()
    def trigger(self, prompt: str, ...):
        ...
"""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from functools import wraps
from typing import Callable, Optional

from loguru import logger

from utilis.timing import timed


class TokenBudget:
    """Sliding-window budget: tracks token/request timestamps in a 60s window."""

    def __init__(self, tpm: int, rpm: int) -> None:
        self.tpm = max(1, int(tpm))
        self.rpm = max(1, int(rpm))
        self._lock = threading.Lock()
        self._tokens: deque[float] = deque()
        self._requests: deque[float] = deque()

    @timed("TokenBudget.wait_for")
    def wait_for(self, tokens: int) -> None:
        """Block until ``tokens`` (and one request slot) fit the window.

        ``tokens`` is the *input* estimate; ``OUTPUT_TOKEN_RESERVE`` is added
        here because billed usage includes the model's answer.
        """
        need = max(1, int(tokens)) + OUTPUT_TOKEN_RESERVE
        if OUTPUT_TOKEN_RESERVE:
            logger.debug(
                f"[ratelimit] reserving {need} tokens "
                f"({int(tokens)} input + {OUTPUT_TOKEN_RESERVE} output allowance)"
            )
        with self._lock:
            while True:
                now = time.monotonic()
                while self._tokens and self._tokens[0] <= now - 60.0:
                    self._tokens.popleft()
                while self._requests and self._requests[0] <= now - 60.0:
                    self._requests.popleft()

                tokens_ok = len(self._tokens) + need <= self.tpm
                requests_ok = len(self._requests) + 1 <= self.rpm
                if tokens_ok and requests_ok:
                    self._tokens.append(now)
                    self._requests.append(now)
                    return

                pending = [
                    now - (self._tokens[0] + 60.0)
                    if len(self._tokens) >= self.tpm
                    else 0.0,
                    now - (self._requests[0] + 60.0)
                    if len(self._requests) >= self.rpm
                    else 0.0,
                ]
                hold = max(-min(pending), 0.0)
                logger.debug(
                    f"[ratelimit] holding {hold:.1f}s "
                    f"(tokens {len(self._tokens)}/{self.tpm}, "
                    f"requests {len(self._requests)}/{self.rpm})"
                )
                time.sleep(max(hold, 0.05))


@timed("estimate_tokens")
def estimate_tokens(text: str) -> int:
    """Cheap token estimate (chars / 4), matches Agent.count_tokens."""
    return max(1, len(str(text if text is not None else "").strip()) // 4)


# Hidden chain-of-thought is billed as OUTPUT tokens (groq ledger 2026-10-30:
# ~900 hidden reasoning tokens per section call at the default effort on
# gpt-oss-20b, vs ~190 tokens of visible prose). `reasoning_effort: low` cut
# that ~7x in a live A/B, which is the difference between a section-writing
# run fitting in the free tier's 8000 TPM and spending a minute of every
# minute rate-limited. Applied only to models that accept the parameter;
# anything else must not learn about it.
REASONING_EFFORT = os.environ.get("QUILL_REASONING_EFFORT", "low").strip().lower() or None

# Models where `reasoning_effort` is honoured. Matched by prefix -- Groq's
# openai/gpt-oss-20b and -120b, plus any bare gpt-oss spelling.
_REASONING_MODEL_PREFIXES = ("openai/gpt-oss", "gpt-oss")

def _reasoning_kwargs(model_name: str) -> dict:
    """The `reasoning_effort` kwarg when the model accepts one, else {}."""
    if not REASONING_EFFORT:
        return {}
    for prefix in _REASONING_MODEL_PREFIXES:
        if model_name.startswith(prefix):
            return {"reasoning_effort": REASONING_EFFORT}
    return {}


# Billed tokens per call are input + OUTPUT, but ``Agent.model`` only knows its
# input size at reservation time. Reserving input alone under-books the
# sliding window by roughly half (live runs 2026-10-30: ~1.6-1.8k combined per
# call, input estimate ~1.4k of that), so a burst back-to-back calls can push
# past 8000 TPM inside a minute even when the limiter thought it was fine --
# and a 429 retry then re-bills the whole request into the same window. Every
# reservation therefore adds this constant output allowance on top of the
# input estimate. ~1200 covers a section-length answer with `low` reasoning;
# long-form runs still arena well because the window rolls each 60s. Set 0 to
# restore input-only reservations.
OUTPUT_TOKEN_RESERVE = int(os.environ.get("QUILL_OUTPUT_TOKENS", "1200"))


LIMITER = TokenBudget(
    tpm=int(os.environ.get("QUILL_TPM", "60000")),
    rpm=int(os.environ.get("QUILL_RPM", "60")),
)
logger.info(
    f"[ratelimit] budget {LIMITER.tpm} TPM / {LIMITER.rpm} RPM "
    f"+ {OUTPUT_TOKEN_RESERVE} output reserve (built at import: LIMITER = TokenBudget(...))"
)


class RateLimitError(RuntimeError):
    """Raised once retries are exhausted on a 429/5xx."""


def _status_from_exc(exc: BaseException) -> Optional[int]:
    for holder in (getattr(exc, "response", None), exc):
        status = getattr(holder, "status_code", None)
        if status:
            try:
                return int(status)
            except (TypeError, ValueError):
                continue
    return None


# Transport failures carry no HTTP status, so a status-only retry check treats
# them as permanent. Matched by class name to keep the vendor SDK out of here.
_TRANSPORT_ERROR_NAMES = frozenset({
    "APIConnectionError", "APITimeoutError", "ConnectError", "ConnectTimeout",
    "ConnectionError", "ConnectionResetError", "ConnectionAbortedError",
    "ReadError", "ReadTimeout", "WriteError", "WriteTimeout", "PoolTimeout",
    "RemoteProtocolError", "ProtocolError", "ProxyError", "SSLError",
    "TimeoutError", "Timeout",
})


def _is_transport_error(exc: BaseException) -> bool:
    if any(cls.__name__ in _TRANSPORT_ERROR_NAMES for cls in type(exc).__mro__):
        return True
    cause = exc.__cause__ or exc.__context__
    return cause is not None and _is_transport_error(cause)


def retryable(exc: BaseException) -> bool:
    if is_exhausted_quota(exc):
        return False
    if _status_from_exc(exc) in (408, 409, 429, 500, 502, 503, 504):
        return True
    return _is_transport_error(exc)


# Groq reports exhausted *daily* allowances with a 429 that will not clear by
# backing off; the allowance resets on a calendar boundary, not in seconds.
_QUOTA_PATTERNS = (
    "tokens per day",
    "requests per day",
    "(tpd)",
    "(rpd)",
    "daily limit",
)


def is_exhausted_quota(exc: BaseException) -> bool:
    """True when a 429 means a daily allowance is spent, not a transient burst."""
    text = str(exc).lower()
    if not any(p in text for p in _QUOTA_PATTERNS):
        return False
    return _status_from_exc(exc) == 429


class DailyQuotaExceeded(RuntimeError):
    """Raised instead of burning retries against an exhausted daily allowance."""


def _quota_hint(exc: BaseException) -> str:
    return (
        "\n\nThe provider's DAILY token/request allowance for this model is spent. "
        "Retrying cannot help: the allowance resets on a calendar boundary, not "
        "in seconds. Stop the run, then either wait for the reset, upgrade the "
        "tier, or point QUILL at a different model or key."
    )


def _retry_after(exc: BaseException) -> Optional[float]:
    try:
        headers = getattr(getattr(exc, "response", None), "headers", {}) or {}
        raw = (headers.get("Retry-After") or headers.get("retry-after") or "").strip()
        if not raw:
            return None
        try:
            return max(0.0, float(raw))
        except (TypeError, ValueError):
            return None
    except Exception:
        return None


def rate_limited(decorated) -> Callable:
    """Wait on the shared budget, then run ``fn`` with hardened retry/backoff."""

    return decorated


@timed("run_with_retry")
def run_with_retry(
    fn: Callable,
    max_retries: Optional[int] = None,
    base_delay: float = 0.8,
    retries_placeholder: bool = False,
) -> Callable:
    """Wrap ``fn`` so 429/5xx are retried with exponential backoff + Retry-After."""

    retries_max = max_retries if max_retries is not None else int(
        os.environ.get("QUILL_RETRIES", "3")
    )

    def wrapper(*args, **kwargs):
        attempt = 0
        while True:
            try:
                return fn(*args, **kwargs)
            except Exception as exc:
                if is_exhausted_quota(exc):
                    logger.error(f"[ratelimit] daily allowance exhausted: {exc}")
                    raise DailyQuotaExceeded(str(exc) + _quota_hint(exc)) from exc
                if not retryable(exc) or attempt >= retries_max:
                    raise RateLimitError(
                        f"still failing after {attempt} attempts: {exc}"
                    ) from exc
                delay = _retry_after(exc) or (base_delay * (2 ** attempt))
                logger.warning(
                    f"[ratelimit] retryable {type(exc).__name__}: {exc}; "
                    f"backing off {delay:.1f}s (attempt {attempt + 1}/{retries_max})"
                )
                attempt += 1
                time.sleep(delay)

    return wrapper


@timed("Agent.model.rate_limited")
def _wait_then(fn: Callable):
    return fn
