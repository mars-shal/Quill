"""Unit tests for quill_engine.providers (model tracking + registry)."""

import json

import pytest

from quill_engine import config, providers


@pytest.fixture(autouse=True)
def _clean_provider_state(monkeypatch, tmp_path):
    # Isolate from a real ~/.config/quill/providers.json on the dev machine,
    # otherwise its chain leaks into these unit tests and they fail.
    monkeypatch.setenv("QUILL_PROVIDERS_FILE", str(tmp_path / "providers.json"))
    providers.reset()
    providers.reset_usage()
    providers.reload_config_file()
    yield
    providers.reset()
    providers.reset_usage()
    providers.reload_config_file()


def test_last_used_none_by_default(monkeypatch):
    monkeypatch.setattr(providers, "_last_used", None)
    assert providers.last_used() is None


def test_record_success_then_last_used(monkeypatch):
    monkeypatch.setattr(providers, "_last_used", None)
    providers.record_success("groq", "llama-3.3-70b-versatile")
    assert providers.last_used() == ("groq", "llama-3.3-70b-versatile")


def test_record_success_latest_wins(monkeypatch):
    monkeypatch.setattr(providers, "_last_used", ("groq", "old-model"))
    providers.record_success("openrouter", "new-model")
    assert providers.last_used() == ("openrouter", "new-model")


# ---------------------------------------------------------------------------
# Registry + config file
# ---------------------------------------------------------------------------


def test_builtin_registry_contains_expected_providers():
    names = set(providers.all_providers())
    assert {
        "groq",
        "openrouter",
        "google",
        "ollama",
        "openai",
        "deepseek",
        "mistral",
        "together",
        "xai",
        "lmstudio",
        "vllm",
    } <= names


def test_chain_follows_llm_providers_order_and_skips_unknown(monkeypatch):
    monkeypatch.setattr(config, "LLM_PROVIDERS", ["ollama", "nope", "groq"])
    names = [p.name for p in providers.chain()]
    assert names == ["ollama", "groq"]


def test_active_chain_skips_keyless_cloud_providers(monkeypatch):
    keyless = providers.LLMProvider("groq", "https://x/v1", "m", api_key=None)
    monkeypatch.setitem(providers.PROVIDER_DEFS, "groq", keyless)
    monkeypatch.setattr(config, "LLM_PROVIDERS", ["groq", "ollama"])
    names = [p.name for p in providers.active_chain()]
    assert names == ["ollama"]


def test_config_file_adds_custom_provider_and_chain(tmp_path, monkeypatch):
    cfg = {
        "providers": {
            "my-relay": {
                "base_url": "https://relay.example.com/v1",
                "api_key_env": "MY_RELAY_KEY",
                "model": "relay-large",
            }
        },
        "chain": ["my-relay", "ollama"],
    }
    path = tmp_path / "providers.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("QUILL_PROVIDERS_FILE", str(path))
    monkeypatch.setenv("MY_RELAY_KEY", "sk-test-123")
    providers.reload_config_file()

    provider = providers.all_providers()["my-relay"]
    assert provider.base_url == "https://relay.example.com/v1"
    assert provider.model == "relay-large"
    assert provider.api_key == "sk-test-123"

    monkeypatch.setattr(config, "LLM_PROVIDERS", ["groq"])  # file chain wins
    assert [p.name for p in providers.chain()] == ["my-relay", "ollama"]


def test_config_file_malformed_is_ignored(tmp_path, monkeypatch):
    path = tmp_path / "providers.json"
    path.write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("QUILL_PROVIDERS_FILE", str(path))
    providers.reload_config_file()
    assert providers.file_providers() == {}
    assert providers.file_chain() is None


def test_remove_custom_provider_deletes_entry_and_chain(tmp_path, monkeypatch):
    cfg = {
        "providers": {
            "my-relay": {
                "base_url": "https://relay.example.com/v1",
                "api_key": "sk-test",  # noqa: S105
                "model": "relay-large",
                "requires_key": True,
            },
            "other-relay": {
                "base_url": "https://other.example.com/v1",
                "api_key": "sk-other",  # noqa: S105
                "model": "other",
                "requires_key": True,
            },
        },
        "chain": ["my-relay", "other-relay", "ollama"],
    }
    path = tmp_path / "providers.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("QUILL_PROVIDERS_FILE", str(path))
    providers.reload_config_file()

    assert "my-relay" in providers.all_providers()
    removed = providers.remove_custom_provider("my-relay")
    assert removed is True
    assert "my-relay" not in providers.all_providers()
    assert "other-relay" in providers.all_providers()
    assert "my-relay" not in providers.file_chain()
    assert providers.file_chain() == ["other-relay", "ollama"]


def test_remove_custom_provider_rejects_builtin_and_missing(tmp_path, monkeypatch):
    path = tmp_path / "providers.json"
    path.write_text(
        json.dumps(
            {
                "providers": {
                    "custom-1": {
                        "base_url": "https://x.example.com/v1",
                        "api_key": "sk-x",  # noqa: S105
                        "model": "m",
                        "requires_key": True,
                    }
                },
                "chain": ["custom-1", "ollama"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("QUILL_PROVIDERS_FILE", str(path))
    providers.reload_config_file()

    assert providers.remove_custom_provider("ollama") is False
    assert "ollama" in providers.all_providers()
    assert providers.remove_custom_provider("nope") is False
    assert providers.remove_custom_provider("custom-1") is True
    assert "custom-1" not in providers.all_providers()


def test_remove_custom_provider_purges_runtime_selection(tmp_path, monkeypatch):
    # A built-in name with a file override (the GUI BYOK flow) must not
    # ghost back into chain() after deletion: chain() prefers the in-memory
    # _chain_override, and all_providers() still resolves the built-in.
    cfg = {
        "providers": {
            "openrouter": {
                "base_url": "https://openrouter.ai/api/v1",
                "api_key": "sk-test",  # noqa: S105
                "model": "relay-large",
                "requires_key": True,
            }
        },
        "chain": ["openrouter", "ollama"],
    }
    path = tmp_path / "providers.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("QUILL_PROVIDERS_FILE", str(path))
    providers.reload_config_file()

    providers.set_model_selection("openrouter", "relay-large")
    assert "openrouter" in [p.name for p in providers.chain()]

    assert providers.remove_custom_provider("openrouter") is True
    assert "openrouter" not in [p.name for p in providers.chain()]


def test_save_custom_provider_preserves_existing_key_on_blank(tmp_path, monkeypatch):
    cfg = {
        "providers": {
            "my-relay": {
                "base_url": "https://relay.example.com/v1",
                "api_key": "sk-original",  # noqa: S105
                "model": "relay-large",
                "requires_key": True,
            }
        },
        "chain": ["my-relay", "ollama"],
    }
    path = tmp_path / "providers.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("QUILL_PROVIDERS_FILE", str(path))
    providers.reload_config_file()

    providers.save_custom_provider("my-relay", "https://relay.example.com/v2", "", "relay-large")
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["providers"]["my-relay"]["base_url"] == "https://relay.example.com/v2"
    assert saved["providers"]["my-relay"]["api_key"] == "sk-original"

    providers.save_custom_provider("my-relay", "https://relay.example.com/v3", "sk-new", "relay-large")
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["providers"]["my-relay"]["api_key"] == "sk-new"


def test_with_model_pins_copy_and_handles_empty():
    base = providers.PROVIDER_DEFS["ollama"]
    pinned = providers.with_model(base, "llama3.2:3b")
    assert pinned.model == "llama3.2:3b"
    assert pinned.name == base.name
    assert providers.with_model(base, "") is base


def test_estimate_tokens_basic():
    assert providers.estimate_tokens("") == 0
    count = providers.estimate_tokens("hello world, this is a short sentence.")
    assert isinstance(count, int) and count > 0


def test_usage_round_trip():
    providers.reset_usage()
    assert providers.usage()["calls"] == 0
    providers._record_usage("ollama", 10, 5)
    providers._record_usage("ollama", 7, 3)
    usage = providers.usage()
    assert usage["calls"] == 2
    assert usage["prompt_tokens"] == 17
    assert usage["completion_tokens"] == 8
    assert usage["by_provider"] == {"ollama": 2}
