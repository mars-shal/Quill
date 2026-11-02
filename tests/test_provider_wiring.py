"""The request's provider is the one every engine uses.

`Agent()` with no configuration falls back to `OPENAI_API_KEY` in the
environment, which is right for a standalone run and wrong inside the app: the
GUI hands a provider to each task, and a task that quietly built its own agent
would answer with the `.env` credential instead of the one the reader selected.

One call site did exactly that -- `Orchestrator.ReWrite` built a bare
`WritingEngine()` a line below one that correctly passed `self.agent` -- so the
rewrite path authenticated with the environment's key while the plan next to it
used the provider's. The checks below are the two halves of that: the constructor
honours the agent it is given, and no engine in `components/` is built without
one.

Run with `PYTHONPATH=$PWD .venv/bin/python tests/test_provider_wiring.py`.
"""

import os
import pathlib
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from components.writingEngine import WritingEngine
from utilis.model import Agent

ENGINES = (
    "WritingEngine",
    "ResearchEngine",
    "ConceptEngine",
    "PlagiarismEngine",
    "KnowledgeGraph",
)


class _FakeEmbedder:
    """Stands in for `Embedder.get()`, which loads a model this test does not need."""

    def embed_one(self, text):
        return None

    def similarity(self, a, b):
        return 0.0


def _check(results, name, cond, detail=""):
    results.append(cond)
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else f"   [{detail}]"))


def _unwired_constructions():
    pattern = re.compile(r"\b(" + "|".join(ENGINES) + r")\(\s*\)")
    found = []
    for path in sorted(pathlib.Path("components").glob("*.py")):
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if pattern.search(line):
                found.append(f"{path}:{lineno}")
    return found


def _per_call_env_models():
    """A `model=` read from the environment where the call is made, rather than
    once from the provider. One survived in `documentparser.py` and sent the
    document-repair call to `LLM_MODEL`, or to another vendor's `allam-2-7b` when
    it was unset -- while the client it used had been built from the provider.

    A `cfg.get(...) or os.getenv(...)` pair is fine; the provider still wins."""
    pattern = re.compile(r"model\s*=\s*os\.(?:getenv|environ)")
    found = []
    for folder in ("components", "utilis"):
        for path in sorted(pathlib.Path(folder).glob("*.py")):
            for lineno, line in enumerate(path.read_text().splitlines(), 1):
                if pattern.search(line):
                    found.append(f"{path}:{lineno}")
    return found


def main() -> int:
    results: list[bool] = []

    sentinel = object()
    engine = WritingEngine(model=sentinel, embedder=_FakeEmbedder())
    _check(
        results,
        "WritingEngine keeps the agent it is handed",
        engine.model is sentinel,
        repr(engine.model),
    )

    env_key = os.environ.pop("OPENAI_API_KEY", None)
    try:
        detail = ""
        try:
            Agent({"api_key": "sk-from-the-provider", "base_url": "https://example.test/v1"})
            provider_wins = True
        except Exception as exc:
            provider_wins = False
            detail = repr(exc)
        _check(
            results,
            "a provider's key is enough on its own, with the environment empty",
            provider_wins,
            detail,
        )

        try:
            Agent()
            complained = False
        except RuntimeError:
            complained = True
        _check(
            results,
            "no provider and no environment key is reported, not run unauthenticated",
            complained,
        )
    finally:
        if env_key is not None:
            os.environ["OPENAI_API_KEY"] = env_key

    offenders = _unwired_constructions()
    _check(
        results,
        "no engine is built without an agent in components/",
        not offenders,
        ", ".join(offenders),
    )

    env_models = _per_call_env_models()
    _check(
        results,
        "no call resolves its model from the environment instead of the provider",
        not env_models,
        ", ".join(env_models),
    )

    passed = sum(results)
    print(f"\n{'ALL PASS' if passed == len(results) else 'FAILURES'}: {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
