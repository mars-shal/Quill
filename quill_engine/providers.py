"""Provider registry + failover chain for LLM calls.

Defines the built-in OpenAI-compatible providers (Groq, OpenRouter,
Google, Ollama, OpenAI, DeepSeek, Mistral, Together, xAI, Fireworks,
LM Studio, vLLM) plus custom providers from a JSON config file
(``~/.config/quill/providers.json`` or ``$QUILL_PROVIDERS_FILE``), so any
OpenAI-compatible endpoint can be connected with just a base URL, a model
id, and an API-key env var. Tracks per-process failover state: a provider
that errors is marked down (honoring Retry-After where present) and
skipped until its cooldown elapses, so one rate-limited provider cannot
fail the run.

Config file format::

    {
      "providers": {
        "my-relay": {
          "base_url": "https://relay.example.com/v1",
          "api_key_env": "MY_RELAY_KEY",
          "api_key": "sk-...",   // inline alternative (less safe)
          "model": "default-model",
          "requires_key": true
        }
      },
      "chain": ["ollama", "my-relay"]
    }

``chain`` (optional) overrides ``LLM_PROVIDERS``. This module also hosts
:func:`complete` — the single one-shot LLM call helper used by every
service — and per-process token-usage accounting surfaced in the TUI.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace

from openai import APIError, OpenAI, RateLimitError

from . import config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LLMProvider:
    """One OpenAI-compatible endpoint usable by the writing chain."""

    name: str
    base_url: str
    model: str
    api_key: str | None
    requires_key: bool = True


def _builtin(
    name: str,
    base_url: str,
    model: str,
    *,
    key: str | None,
    requires_key: bool = True,
) -> LLMProvider:
    return LLMProvider(name, base_url, model, key, requires_key)


PROVIDER_DEFS: dict[str, LLMProvider] = {
    "groq": _builtin(
        "groq", "https://api.groq.com/openai/v1", config.GROQ_MODEL,
        key=config.GROQ_API_KEY,
    ),
    "openrouter": _builtin(
        "openrouter", "https://openrouter.ai/api/v1", config.OPENROUTER_MODEL,
        key=config.OPENROUTER_API_KEY,
    ),
    "google": _builtin(
        "google",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        config.GOOGLE_MODEL,
        key=config.GOOGLE_API_KEY,
    ),
    "ollama": _builtin(
        "ollama", "http://localhost:11434/v1", config.OLLAMA_MODEL,
        key=None, requires_key=False,
    ),
    "openai": _builtin(
        "openai", "https://api.openai.com/v1", config.OPENAI_MODEL,
        key=os.environ.get("OPENAI_API_KEY", ""),
    ),
    "deepseek": _builtin(
        "deepseek", "https://api.deepseek.com/v1", config.DEEPSEEK_MODEL,
        key=os.environ.get("DEEPSEEK_API_KEY", ""),
    ),
    "mistral": _builtin(
        "mistral", "https://api.mistral.ai/v1", config.MISTRAL_MODEL,
        key=os.environ.get("MISTRAL_API_KEY", ""),
    ),
    "together": _builtin(
        "together", "https://api.together.xyz/v1", config.TOGETHER_MODEL,
        key=os.environ.get("TOGETHER_API_KEY", ""),
    ),
    "xai": _builtin(
        "xai", "https://api.x.ai/v1", config.XAI_MODEL,
        key=os.environ.get("XAI_API_KEY", ""),
    ),
    "fireworks": _builtin(
        "fireworks", "https://api.fireworks.ai/inference/v1",
        os.environ.get(
            "FIREWORKS_MODEL", "accounts/fireworks/models/llama-v3p3-70b-instruct"
        ),
        key=os.environ.get("FIREWORKS_API_KEY", ""),
    ),
    "lmstudio": _builtin(
        "lmstudio", "http://localhost:1234/v1", config.LMSTUDIO_MODEL,
        key=None, requires_key=False,
    ),
    "vllm": _builtin(
        "vllm", "http://localhost:8000/v1", config.VLLM_MODEL,
        key=None, requires_key=False,
    ),
}

LOCAL_PROVIDERS = frozenset({"ollama", "lmstudio", "vllm"})

_down_until: dict[str, float] = {}
_last_used: tuple[str, str] | None = None

# Runtime model selection (GUI): pinned models per provider + primary order.
_model_overrides: dict[str, str] = {}
_chain_override: list[str] | None = None


# ---------------------------------------------------------------------------
# Config-file providers (custom endpoints)
# ---------------------------------------------------------------------------

_file_cache: dict[str, LLMProvider] | None = None
_file_chain: list[str] | None = None


def providers_file_path() -> str:
    return os.environ.get(
        "QUILL_PROVIDERS_FILE",
        os.path.join("~/.config/quill/providers.json"),
    )


def _normalize_base_url(url: str) -> str:
    """API root for an OpenAI-compatible endpoint.

    The OpenAI SDK appends the operation path (``/chat/completions``), and
    model listing appends ``/models``, so a stored ``base_url`` must be the
    API root (``https://host/v1``). Users pasting a full endpoint URL (…
    ``/chat/completions``) would otherwise double-append on every call.
    """
    url = url.strip().rstrip("/")
    if url.endswith("/chat/completions"):
        url = url[: -len("/chat/completions")]
    return url


def _load_providers_file() -> tuple[dict[str, LLMProvider], list[str] | None]:
    """Parse the providers JSON config file (never raises).

    Returns ``({name: provider}, chain_or_None)``; both empty/None when the
    file is missing or malformed.
    """
    path = os.path.expanduser(providers_file_path())
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        if isinstance(exc, json.JSONDecodeError):
            logger.warning("providers config %s is malformed: %s", path, exc)
        return {}, None
    if not isinstance(data, dict):
        return {}, None

    out: dict[str, LLMProvider] = {}
    for name, spec in (data.get("providers") or {}).items():
        if not isinstance(spec, dict) or not spec.get("base_url"):
            logger.warning("providers config: skipping %r (needs base_url)", name)
            continue
        key = spec.get("api_key")
        if key is None and spec.get("api_key_env"):
            key = os.environ.get(str(spec["api_key_env"]), "")
        out[str(name)] = LLMProvider(
            name=str(name),
            base_url=_normalize_base_url(str(spec["base_url"])),
            model=str(spec.get("model") or "default"),
            api_key=key,
            requires_key=bool(spec.get("requires_key", True)),
        )
    chain = data.get("chain")
    if isinstance(chain, list):
        chain = [str(c) for c in chain if str(c).strip()]
    else:
        chain = None
    return out, chain


def file_providers() -> dict[str, LLMProvider]:
    global _file_cache
    if _file_cache is None:
        _file_cache, _ = _load_providers_file()
    return _file_cache


def file_chain() -> list[str] | None:
    global _file_chain
    if _file_cache is None:
        _, _file_chain = _load_providers_file()
    return _file_chain


def reload_config_file() -> None:
    """Re-read the providers config file (used by tests and /connect)."""
    global _file_cache, _file_chain
    _file_cache, _file_chain = _load_providers_file()


def save_custom_provider(
    name: str,
    base_url: str,
    api_key: str,
    model: str | None = None,
) -> None:
    """Persist a bring-your-own-key provider to the config file.

    Writes ``name`` into ``providers`` plus a new chain with the provider
    first (the existing order is kept as failover), then reloads the cache
    so the provider is immediately usable. The API key is stored inline in
    the config file, matching the existing ``api_key`` alternative.
    """
    path = os.path.expanduser(providers_file_path())
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    provider_map = data.get("providers")
    if not isinstance(provider_map, dict):
        provider_map = {}
        data["providers"] = provider_map
    if not api_key:
        existing = provider_map.get(name)
        if isinstance(existing, dict) and existing.get("api_key"):
            api_key = existing["api_key"]
    provider_map[name] = {
        "base_url": _normalize_base_url(base_url),
        "api_key": api_key,
        "model": model or "default",
        "requires_key": True,
    }
    chain = data.get("chain")
    if not isinstance(chain, list):
        chain = list(config.LLM_PROVIDERS)
    data["chain"] = [name] + [entry for entry in chain if entry != name]
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    reload_config_file()


def remove_custom_provider(name: str) -> bool:
    """Delete a custom provider from the config file (never raises).

    Only providers persisted by :func:`save_custom_provider` are removed —
    built-ins (``PROVIDER_DEFS``) are left untouched. The name is also
    dropped from ``chain`` so the deleted provider never comes back via a
    stale ordering. Returns ``False`` (no file write) when the provider does
    not exist in the file or is a built-in.
    """
    path = os.path.expanduser(providers_file_path())
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    provider_map = data.get("providers")
    if not isinstance(provider_map, dict) or name not in provider_map:
        return False

    del provider_map[name]
    chain = data.get("chain")
    if isinstance(chain, list):
        data["chain"] = [entry for entry in chain if entry != name]
    if not provider_map:
        data.pop("providers", None)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
    except OSError:
        return False
    _model_overrides.pop(name, None)
    _down_until.pop(name, None)
    # Purge the runtime selection too: chain() prefers _chain_override over
    # the config file, so a deleted provider (a built-in name especially)
    # would otherwise ghost back into /health until the process restarts.
    global _chain_override
    if _chain_override is not None:
        _chain_override = [entry for entry in _chain_override if entry != name]
    reload_config_file()
    return True


def fetch_provider_models(base_url: str, api_key: str, timeout: float = 8.0) -> list[str]:
    """Live model ids from an OpenAI-compatible ``/models`` endpoint.

    Used by the GUI's BYOK flow to list the models a user-supplied key can
    reach before anything is selected; never raises (returns ``[]`` when the
    endpoint is unreachable or unauthenticated).
    """
    import httpx

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        root = _normalize_base_url(base_url)
        response = httpx.get(f"{root}/models", headers=headers, timeout=timeout)
        response.raise_for_status()
        data = response.json()
        return sorted(m.get("id", "") for m in data.get("data", []) if m.get("id"))
    except Exception:  # noqa: BLE001 — probing a user endpoint, never raise
        return []


def all_providers() -> dict[str, LLMProvider]:
    """Built-ins merged with config-file providers (file wins on clash)."""
    merged = dict(PROVIDER_DEFS)
    merged.update(file_providers())
    return merged


def with_model(provider: LLMProvider, model: str) -> LLMProvider:
    """A copy of ``provider`` pinned to ``model`` (for model overrides)."""
    return replace(provider, model=model) if model and model != provider.model else provider


def chain() -> list[LLMProvider]:
    """Providers in configured order (``LLM_PROVIDERS``, the config file's
    ``chain``, or a single legacy ``LLM_BASE_URL``/``LLM_MODEL`` endpoint
    when that env var is set)."""
    if config.LLM_BASE_URL_EXPLICIT:
        return [
            LLMProvider(
                "local",
                config.LLM_BASE_URL,
                config.LLM_MODEL,
                api_key=None,
                requires_key=False,
            )
        ]
    order = _chain_override or file_chain() or config.LLM_PROVIDERS
    defs = all_providers()
    chain_list: list[LLMProvider] = []
    for name in order:
        provider = defs.get(name)
        if provider is None:
            logger.warning("unknown LLM provider in LLM_PROVIDERS: %s", name)
            continue
        chain_list.append(with_model(provider, _model_overrides.get(name, provider.model)))
    return chain_list


def active_chain() -> list[LLMProvider]:
    """``chain()`` minus providers in cooldown.

    Providers that don't require an API key (local endpoints like Ollama)
    are always active; cloud providers without a key are skipped.
    """
    now = time.monotonic()
    active: list[LLMProvider] = []
    for provider in chain():
        if provider.api_key is None and provider.requires_key:
            continue
        if _down_until.get(provider.name, 0.0) > now:
            continue
        active.append(provider)
    return active


def mark_down(name: str, *, retry_after: float | None = None) -> None:
    """Put ``name`` in cooldown; a Retry-After hint (seconds) extends it."""
    cooldown = float(config.LLM_PROVIDER_COOLDOWN_S)
    if retry_after is not None:
        cooldown = max(cooldown, retry_after)
    _down_until[name] = time.monotonic() + cooldown
    logger.warning(
        "provider %s marked down for %.0fs (retry_after=%s)",
        name,
        cooldown,
        retry_after,
    )


def reset() -> None:
    """Clear failover state (used by tests)."""
    _down_until.clear()


def set_model_selection(name: str, model: str | None = None) -> None:
    """Pin ``name`` (and optionally a specific model) as the primary provider.

    Clears any cooldown so the selection is immediately usable; the rest of
    the configured chain stays as failover.
    """
    global _chain_override
    _model_overrides[name] = model or _model_overrides.get(name, "")
    if not _model_overrides[name]:
        _model_overrides.pop(name)
    base = _chain_override or file_chain() or list(config.LLM_PROVIDERS)
    _chain_override = [name] + [n for n in base if n != name]
    _down_until.pop(name, None)
    logger.info("model selection: %s (%s)", name, _model_overrides.get(name, "default"))


def current_selection() -> tuple[str, str] | None:
    """The active primary ``(provider, model)`` after runtime overrides."""
    order = _chain_override or file_chain() or list(config.LLM_PROVIDERS)
    defs = all_providers()
    for name in order:
        provider = defs.get(name)
        if provider is not None:
            return name, _model_overrides.get(name, provider.model)
    return None


def record_success(name: str, model: str) -> None:
    """Remember the provider/model that last completed a generation."""
    global _last_used
    _last_used = (name, model)


def last_used() -> tuple[str, str] | None:
    """The ``(provider, model)`` of the most recent successful generation."""
    return _last_used


def next_retry_delay() -> float | None:
    """Seconds until the earliest provider cooldown expires (None if none)."""
    if not _down_until:
        return None
    earliest = min(_down_until.values())
    return max(0.0, earliest - time.monotonic())


def down_summary() -> str:
    """Human-readable cooldown state for error messages."""
    now = time.monotonic()
    parts = [
        f"{name} (cooldown {until - now:.0f}s)"
        for name, until in sorted(_down_until.items())
        if until > now
    ]
    return ", ".join(parts) or "no providers in cooldown"


# ---------------------------------------------------------------------------
# One-shot completion helper (the single LLM call used by every service)
# ---------------------------------------------------------------------------


@dataclass
class Usage:
    """Per-process LLM usage totals (estimated when a provider omits them)."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    calls: int = 0
    by_provider: dict[str, int] = field(default_factory=dict)


_usage = Usage()


def estimate_tokens(text: str) -> int:
    """Rough token count via tiktoken (fallback: whitespace words * 1.3)."""
    if not text:
        return 0
    try:
        import tiktoken

        return len(tiktoken.get_encoding("cl100k_base").encode(text))
    except Exception:  # noqa: BLE001 — estimation must never raise
        return int(len(text.split()) * 1.3)


def _record_usage(provider_name: str, prompt_tokens: int, completion_tokens: int) -> None:
    _usage.calls += 1
    _usage.prompt_tokens += prompt_tokens
    _usage.completion_tokens += completion_tokens
    _usage.by_provider[provider_name] = _usage.by_provider.get(provider_name, 0) + 1


def usage() -> dict:
    """Usage totals for display: ``usage()`` -> dict with copies."""
    return {
        "prompt_tokens": _usage.prompt_tokens,
        "completion_tokens": _usage.completion_tokens,
        "calls": _usage.calls,
        "by_provider": dict(_usage.by_provider),
    }


def reset_usage() -> None:
    global _usage
    _usage = Usage()


def complete(
    provider: LLMProvider,
    messages: list[dict],
    *,
    cancel: Callable[[], bool] | None = None,
    on_delta: Callable[[str], None] | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    max_retries: int | None = None,
) -> str:
    """One chat completion against ``provider``; returns the text.

    The single call path shared by writing, thinking, planning, and
    rewriting, so timeout/retry/temperature policy lives in exactly one
    place. With ``cancel`` the call streams and ``GenerationCancelled``
    (from :mod:`quill_engine.writing_service`) is raised as soon as the
    callback turns true. With ``on_delta`` the call also streams and the
    callback receives each raw text fragment as it arrives. Token usage
    is recorded per provider; providers that omit usage in the response
    are estimated via tiktoken.
    """
    from .writing_service import GenerationCancelled

    client = OpenAI(
        api_key=provider.api_key or "ollama",
        base_url=provider.base_url,
        timeout=config.LLM_TIMEOUT_S,
        max_retries=config.LLM_MAX_RETRIES if max_retries is None else max_retries,
    )
    temperature = config.LLM_TEMPERATURE if temperature is None else temperature
    max_tokens = config.LLM_MAX_TOKENS if max_tokens is None else max_tokens
    prompt_estimate = estimate_tokens("".join(m.get("content", "") for m in messages))

    if cancel is None and on_delta is None:
        response = client.chat.completions.create(
            model=provider.model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        text = (response.choices[0].message.content or "").strip()
        usage_obj = getattr(response, "usage", None)
        prompt_tokens = getattr(usage_obj, "prompt_tokens", 0) or prompt_estimate
        completion_tokens = getattr(usage_obj, "completion_tokens", 0) or estimate_tokens(text)
        _record_usage(provider.name, int(prompt_tokens), int(completion_tokens))
        return text

    stream = client.chat.completions.create(
        model=provider.model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        stream=True,
    )
    parts: list[str] = []
    for chunk in stream:
        if cancel is not None and cancel():
            raise GenerationCancelled()
        delta = chunk.choices[0].delta.content
        if delta:
            parts.append(delta)
            if on_delta is not None:
                on_delta(delta)
    text = "".join(parts).strip()
    _record_usage(provider.name, prompt_estimate, estimate_tokens(text))
    return text
