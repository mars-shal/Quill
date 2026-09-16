"""Service 3 — ChunkingService: section tree -> token-bounded chunks.

Implements the ``.agent/agent.md`` §3 rules:
* target 400–800 tokens per chunk
* overlap 50 tokens between consecutive chunks of the same section
* never cross section boundaries
* table rows become their own ``kind="table_row"`` chunks
"""

from __future__ import annotations

import re

import tiktoken

from . import config
from .models import Chunk, ContentUnit, Section, new_chunk

_enc: tiktoken.Encoding | None = None


def _get_encoder() -> tiktoken.Encoding:
    global _enc
    if _enc is None:
        _enc = tiktoken.get_encoding(config.CHUNK_TOKENIZER)
    return _enc


def _split_sentences(paragraph: str) -> list[str]:
    """Split a paragraph into sentences."""
    return [s for s in re.split(r"(?<=[.!?])\s+", paragraph) if s]


def _tokens(text: str) -> int:
    return len(_get_encoder().encode(text))


def _tail_within_budget(sentences: list[str], budget: int) -> list[str]:
    """Last sentences of ``sentences`` whose combined tokens fit ``budget``."""
    tail: list[str] = []
    cost = 0
    for sent in reversed(sentences):
        t = _tokens(sent)
        if cost + t > budget:
            break
        tail.append(sent)
        cost += t
    tail.reverse()
    return tail


def chunk(sections: list[Section]) -> list[Chunk]:
    """Greedy sentence-join per leaf section into 400–800 token chunks.

    Small paragraphs merge into one chunk; oversized single sentences are
    hard-split on a char boundary. Consecutive chunks within the same leaf
    carry the last ~50 tokens as overlap.
    """
    chunks: list[Chunk] = []
    for leaf in _all_leaves(sections):
        chunks.extend(_chunk_leaf(leaf))
    return chunks


def _all_leaves(sections: list[Section]) -> list[Section]:
    leaves: list[Section] = []
    for section in sections:
        leaves.extend(section.leaves())
    return leaves


def _chunk_leaf(section: Section) -> list[Chunk]:
    out: list[Chunk] = []
    buf: list[str] = []
    buf_tokens = 0
    overlap_tail: list[str] = []

    def flush() -> None:
        nonlocal buf, buf_tokens, overlap_tail
        if not buf:
            return
        text = " ".join(buf)
        out.append(new_chunk(section.section_id, text, buf_tokens))
        overlap_tail = _tail_within_budget(buf, config.CHUNK_OVERLAP_TOKENS)
        buf, buf_tokens = [], 0

    for unit in section.content:
        if unit.kind == "table_row":
            # Table rows are atomic chunks — never merged with prose.
            flush()
            out.append(
                new_chunk(
                    section.section_id,
                    unit.text,
                    _tokens(unit.text),
                    kind="table_row",
                    table_data=unit.table_data,
                )
            )
            overlap_tail = []
            continue
        for sent in _split_sentences(unit.text):
            t = _tokens(sent)
            if t > config.CHUNK_MAX_TOKENS:
                # Hard-split oversized sentence on char boundary.
                flush()
                out.extend(_hard_split(section, sent))
                overlap_tail = []
                continue
            if buf and buf_tokens + t > config.CHUNK_MAX_TOKENS:
                flush()
            if not buf and overlap_tail:
                buf = list(overlap_tail)
                buf_tokens = sum(_tokens(s) for s in overlap_tail)
            buf.append(sent)
            buf_tokens += t
            if buf_tokens >= config.CHUNK_MIN_TOKENS:
                flush()
    flush()
    return out


def _hard_split(section: Section, sentence: str) -> list[Chunk]:
    """Split one over-budget sentence into <= CHUNK_MAX_TOKENS chunks."""
    parts: list[Chunk] = []
    budget = config.CHUNK_MAX_TOKENS
    words = sentence.split()
    current: list[str] = []
    current_tokens = 0
    for word in words:
        piece = " ".join(current + [word])
        if _tokens(piece) > budget and current:
            parts.append(new_chunk(section.section_id, " ".join(current), current_tokens))
            current, current_tokens = [], 0
        current.append(word)
        current_tokens += _tokens(word)
    if current:
        parts.append(new_chunk(section.section_id, " ".join(current), current_tokens))
    return parts
