"""Local sentence-embedding utility (sentence-transformers backend).

Lazy-loads a single sentence-transformers model (default all-MiniLM-L6-v2,
override via the EMBEDDING_MODEL env var) and exposes batched embedding plus
cosine similarity ops used across the engines (concept dedup, semantic
plagiarism checks, knowledge-graph querying).
"""

import os
from typing import Iterable, Sequence

from utilis.timing import timed

_SENTENCE_MAX_LEN = 512


class Embedder:
    _instance: "Embedder | None" = None

    def __init__(self, model_name: str | None = None):
        self.model_name = model_name or os.environ.get(
            "EMBEDDING_MODEL", "all-MiniLM-L6-v2"
        )
        self._model = None

    @classmethod
    def get(cls, model_name: str | None = None) -> "Embedder":
        if cls._instance is None:
            cls._instance = cls(model_name)
        return cls._instance

    def _load(self):
        if self._model is not None:
            return self._model
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "sentence-transformers is not installed. Run `uv sync` and verify "
                "torch/sentence-transformers installed cleanly on your Python version."
            ) from exc
        self._model = SentenceTransformer(self.model_name)
        return self._model

    @timed("Embedder.embed")
    def embed(self, texts: Iterable[str], batch_size: int = 32) -> list[list[float]]:
        """Embed a batch of texts; returns a list of float vectors."""
        items = [str(t) for t in texts if t and str(t).strip()]
        if not items:
            return []
        model = self._load()
        vectors = model.encode(
            items,
            batch_size=batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return [vec.tolist() for vec in vectors]

    @timed("Embedder.embed_one")
    def embed_one(self, text: str) -> list[float]:
        return self.embed([text])[0]

    @staticmethod
    def cosine(a: Iterable[float], b: Iterable[float]) -> float:
        import math

        a, b = list(a), list(b)
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(y * y for y in b))
        if na == 0 or nb == 0:
            return 0.0
        return max(-1.0, min(1.0, dot / (na * nb)))

    @classmethod
    def similarity(cls, a: Iterable[float], b: Iterable[float]) -> float:
        """Cosine similarity in 0..1 - use 0.5 as the neutral/independent baseline."""
        return (cls.cosine(a, b) + 1.0) / 2.0