"""Local sentence-embedding utility (fastembed / ONNX backend).

Lazy-loads one ONNX embedding model and exposes batched embeddings plus cosine
similarity. The default is the same all-MiniLM-L6-v2 model the PyTorch stack
used, so the concept, research and plagiarism thresholds keep their meaning.
Override via ``EMBEDDING_MODEL``; point ``FASTEMBED_CACHE_DIR`` at a bundled or
app-data directory when the model should not live in the user's home cache.
"""

import os
import sys
from pathlib import Path
from typing import Iterable, Sequence

from loguru import logger

from utilis.timing import timed

_DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

# The directory name fastembed/huggingface_hub uses for the default ONNX repo.
# It is what the installer build copies next to the sidecar so the first turn
# does not have to download 87 MB before it can answer.
_BUNDLED_MODEL_DIR = "models--Qdrant--all-MiniLM-L6-v2-onnx"


def _bundled_cache_dir() -> str | None:
    """The model cache shipped inside the one-file sidecar, when there is one."""
    if not getattr(sys, "frozen", False):
        return None
    base = Path(getattr(sys, "_MEIPASS", "")) / "fastembed"
    return str(base) if (base / _BUNDLED_MODEL_DIR).is_dir() else None


class Embedder:
    _instance: "Embedder | None" = None

    def __init__(self, model_name: str | None = None):
        self.model_name = model_name or os.environ.get("EMBEDDING_MODEL", _DEFAULT_MODEL)
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
            from fastembed import TextEmbedding
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "fastembed is not installed. Run `uv sync` and verify the ONNX "
                "embedding dependencies installed on this Python version."
            ) from exc
        cache_dir = os.environ.get("FASTEMBED_CACHE_DIR") or None
        bundled = _bundled_cache_dir()
        if bundled and self.model_name == _DEFAULT_MODEL:
            # The installer already carries this model. Prefer it over the
            # app-data cache: even an empty app-data directory would otherwise
            # send fastembed to the network on the first turn.
            cache_dir = bundled
            logger.info("EMBEDDING_READY bundled resources")
        else:
            # A first load may download the ONNX model. The API tap turns these
            # two lines into a named stage, so a long first turn says what it is
            # waiting for instead of showing an indefinite "Thinking".
            logger.info("EMBEDDING_DOWNLOAD downloading resources")
        self._model = TextEmbedding(model_name=self.model_name, cache_dir=cache_dir)
        if not bundled:
            logger.info("EMBEDDING_READY resources ready")
        logger.info("EMBEDDING_READY resources ready")
        return self._model

    @timed("Embedder.embed")
    def embed(self, texts: Iterable[str], batch_size: int = 32) -> list[list[float]]:
        """Embed a batch of texts; returns a list of float vectors."""
        items = [str(t) for t in texts if t and str(t).strip()]
        if not items:
            return []
        model = self._load()
        vectors = model.embed(items, batch_size=batch_size)
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
