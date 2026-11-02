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