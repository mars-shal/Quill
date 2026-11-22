"""Typed shapes for agent responses and engine plans/verdicts.

Every LLM-backed agent in ``utilis/model.py`` validates its JSON reply into
one of these models (with a lenient fallback when the model returns prose
instead of JSON), and the engines build their structured outputs from them.
"""

import pydantic
from pydantic import Field


class NousResponse(pydantic.BaseModel):
    task: str
    confidence: float = 0.5
    links: list[str] = Field(default_factory=list)


class AtlasPlan(pydantic.BaseModel):
    """Strict (markdown plan) atlas output. Atlas may also return a free-form
    structured dict; that path stays untyped by design."""

    plan: str = ""
    confidence: float = 0.5
    tasks: list[str] = Field(default_factory=list)


class SageConcept(pydantic.BaseModel):
    concept: str = ""
    confidence: float = 0.5

    @pydantic.field_validator("concept", mode="before")
    @classmethod
    def _coerce_concept(cls, value: object) -> str:
        """Never reject a provider that answers with a null concept.

        A reasoning model can legitimately finish with no visible content (the
        whole completion was hidden chain-of-thought), and an empty JSON field
        comes back as ``None``. Pydantic's string type then raised
        ``Input should be a valid string`` and the whole run stopped before the
        concept engine could fall back. An empty concept is recoverable; an
        exception here is not.
        """
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        # Some models wrap the answer: {"concept": {"name": "...", "summary": "..."}}.
        if isinstance(value, dict):
            for key in ("concept", "name", "title", "summary", "description", "text"):
                nested = value.get(key)
                if isinstance(nested, str) and nested.strip():
                    return nested
            return ""
        return str(value)

    @pydantic.field_validator("confidence", mode="before")
    @classmethod
    def _coerce_confidence(cls, value: object) -> float:
        """Clamp a missing or out-of-range confidence to something usable."""
        if value is None:
            return 0.5
        try:
            score = float(value)
        except (TypeError, ValueError):
            return 0.5
        return min(1.0, max(0.0, score))


class ScoutReport(pydantic.BaseModel):
    status: str = "done"  # done | needs_user_input
    summary: str = ""
    questionnaire: list[str] = Field(default_factory=list)


class OracleDecision(pydantic.BaseModel):
    thoughts: str = ""
    decision: str = "done"  # continue_research | ask_user | done
    next_queries: list[str] = Field(default_factory=list)
    confidence: float = 0.5


class WardenReport(pydantic.BaseModel):
    status: str = "clean"  # clean | flagged
    issues: list[str] = Field(default_factory=list)


class Relation(pydantic.BaseModel):
    source: str = ""
    target: str = ""
    relation: str = ""


class ConceptExtraction(pydantic.BaseModel):
    concepts: list[str] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)


class ResearchStrategy(pydantic.BaseModel):
    level: int = 1
    query: str = ""
    goal: str = ""
    sub_queries: list["ResearchStrategy"] = Field(default_factory=list)


class ResearchPlan(pydantic.BaseModel):
    strategies: list[ResearchStrategy] = Field(default_factory=list)


ResearchStrategy.model_rebuild()
ConceptExtraction.model_rebuild()