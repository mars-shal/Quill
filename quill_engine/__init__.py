"""quill_engine — section-based technical report generator.

Services are named per ``.agent/agent.md``:
DocumentProcessor, SectionParser, ChunkingService, EmbeddingService,
RetrievalService, ContextBuilder, WritingService, ValidationService,
Orchestrator, ExportService.
"""

from . import (
    chunking_service,
    config,
    context_builder,
    document_processor,
    embedding_service,
    export_service,
    models,
    orchestrator,
    retrieval_service,
    section_parser,
    storage,
    validation_service,
    writing_service,
)

__all__ = [
    "chunking_service",
    "config",
    "context_builder",
    "document_processor",
    "embedding_service",
    "export_service",
    "models",
    "orchestrator",
    "retrieval_service",
    "section_parser",
    "storage",
    "validation_service",
    "writing_service",
]

__version__ = "0.1.0"
