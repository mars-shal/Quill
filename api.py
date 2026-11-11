"""HTTP API for the Quill pipeline, for the Tauri GUI to drive over the network.

    uv run python api.py                    # 0.0.0.0:8000
    uv run python api.py --port 9000

Why SSE rather than polling: a run takes 400-1400s. Polling for twenty minutes
is wasted requests and a stale progress bar, and the engine already emits one
structured record per section, so the progress a user wants is already being
produced and simply is not being forwarded.

Why the pipeline is not modified: events come from a loguru sink that parses the
JSON records the engine already writes (COHERENCE {...}, GROUNDING {...},
write gate result: ...). An event bus inside the pipeline would make every CLI
run pay for a feature only the GUI needs.

Intended deployment is a private compose network with the Tauri backend calling
in, so there is deliberately no authentication here. Do not expose this port to a
network you do not control: a single POST starts a run that spends LLM quota.
"""

from __future__ import annotations

import argparse
import os
import json
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from loguru import logger

from components.orchestrator import TaskRouter, is_format_request
from components.sessionManager import SessionManager

# ---------------------------------------------------------------------------
# run registry
# ---------------------------------------------------------------------------


class Run:
    """One pipeline run: status snapshot plus an append-only event log."""

    def __init__(self, run_id: str, prompt: str, document_id: str,
                 session_name: str, concept_mode: str,
                 provider: dict | None = None) -> None:
        self.id = run_id
        self.prompt = prompt
        self.document_id = document_id
        self.session_name = session_name
        self.concept_mode = concept_mode
        # Resolved by the GUI from the provider registry and the credential
        # store. Present on every request the current client makes; optional only
        # so an older GUI still reaches the pipeline's own configuration.
        self.provider = provider or {}
        self.status = "queued"          # queued|running|done|failed|cancelled
        self.created = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.events: list[dict] = []
        self.result: dict | None = None
        self.error: str = ""
        self.cancelled = False
        self._seq = 0
        self._cv = threading.Condition()

    def emit(self, event: str, **data) -> None:
        with self._cv:
            self._seq += 1
            self.events.append({"seq": self._seq, "event": event,
                                "t": round(time.time() - (self.started_at or time.time()), 2),
                                **data})
            self._cv.notify_all()

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "prompt": self.prompt,
            "document_id": self.document_id,
            "concept_mode": self.concept_mode,
            "created": self.created,
            "elapsed": round((self.finished_at or time.time()) - (self.started_at or time.time()), 1)
            if self.started_at else 0.0,
            "error": self.error,
            "written": (self.result or {}).get("written"),
            "placeholders": (self.result or {}).get("placeholder"),
            "session_name": (self.result or {}).get("session_name"),
            "event_count": len(self.events),
        }

    def since(self, seq: int, timeout: float):
        """Yield events newer than ``seq``, blocking until one arrives or timeout."""
        cursor = seq
        deadline = time.time() + timeout
        while True:
            with self._cv:
                pending = [e for e in self.events if e["seq"] > cursor]
                if not pending and self.status in ("done", "failed", "cancelled"):
                    return
                if not pending:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        return
                    self._cv.wait(min(remaining, 1.0))
                    continue
            for event in pending:
                cursor = event["seq"]
                yield event


class ChatTurn:
    """One chat turn's live stage feed.

    A chat turn has no run object: it is classified, dispatched once, and
    answered once. It still *does* things on the way there -- classifies, works
    out the subject, searches, writes -- and the timing wrapper already records
    every one of them. They went to the terminal and nowhere else, because the
    only thing wired to the sink was `Run`.

    `emit` deliberately matches `Run.emit`, so the same sink can feed both and a
    stage is just an event carrying a label a reader can read.
    """

    def __init__(self) -> None:
        self.id = uuid.uuid4().hex
        self.events: list[dict] = []
        self.done = False
        self.cancelled = False
        self.reply: dict | None = None
        self.error = ""
        # The last label emitted. The timing wrapper fires once per call, and a
        # retry re-enters the same engine, so without this the panel would list
        # "Searching the web" four times in a row.
        self.last_stage = ""
        self._seq = 0
        self._started = time.time()
        self._cv = threading.Condition()

    def emit(self, event: str, **data) -> None:
        with self._cv:
            self._seq += 1
            self.events.append({
                "seq": self._seq,
                "event": event,
                "t": round(time.time() - self._started, 2),
                **data,
            })
            self._cv.notify_all()

    def finish(self) -> None:
        with self._cv:
            self.done = True
            self._cv.notify_all()

    def cancel(self) -> None:
        with self._cv:
            self.cancelled = True
            self.done = True
            self._cv.notify_all()

    def stream(self):
        """Yield events as they arrive, returning once the turn is over."""
        cursor = 0
        while True:
            with self._cv:
                pending = [e for e in self.events if e["seq"] > cursor]
                if not pending and self.done:
                    return
                if not pending:
                    self._cv.wait(0.5)
                    continue
            for event in pending:
                cursor = event["seq"]
                yield event


RUNS: dict[str, Run] = {}
CHAT_TURNS: dict[str, ChatTurn] = {}
_CHAT_LOCK = threading.Lock()
_RUNS_LOCK = threading.Lock()
_CURRENT = threading.local()


# ---------------------------------------------------------------------------
# loguru tap -> run events
# ---------------------------------------------------------------------------

_COHERENCE = re.compile(r"COHERENCE (\{.*\})")
_GROUNDING = re.compile(r"GROUNDING (\{.*\})")
_WRITE_GATE = re.compile(r"write gate result: written=(\d+) placeholder=(\d+)")
_DRIFT = re.compile(r"research gate: DRIFT \((\w+)\)")
_ENTITY = re.compile(r"entity resolution: (.+)")
_EMBED_STAGE = re.compile(r"^EMBEDDING_(DOWNLOAD|READY)\b")

# `utilis.timing`'s own line: "DocumentParser.parse_text took 0.001s (call #1, ...)".
_TIMING = re.compile(r"^([A-Za-z_][\w.]*) took ([\d.]+)s")

# A search call's CALL line carries the query, and the query is the part a
# reader recognises: `Sleuthing: what dogs perceive against domestication
# theories` reads as the work, while the completion line can only say that a
# search happened.
_CALL_QUERY = re.compile(r"^CALL\s+([A-Za-z_][\w.]*)\s+query=(.*)$")

# The handler id of the last sink registration. `logger.add` returns a new id
# every call, so re-installing without holding this would stack handlers.
_SINK_ID: int | None = None

# The engine's call names, as the sentence a reader should see.
#
# This table is the whole point of the streaming endpoint: the panel is not
# meant to print "SqliteDatabase.get took 0.000s". Only calls a reader would
# recognise as progress are listed, the first match wins, and anything else is
# dropped -- a missing entry means "not worth showing", not "show it raw".
_STAGE_LABELS = (
    (re.compile(r"^DocumentParser\."), "Reading the document"),
    (re.compile(r"^ConceptEngine\._prompt_concept"), "Working out the subject"),
    (re.compile(r"^ResearchEngine\.search"), "Sleuthing"),
    (re.compile(r"^Agent\.Nous"), "Reading the question"),
    (re.compile(r"^Agent\.Sage"), "Thinking it through"),
    # The writer's class is `WritingEngine`. These entries named `Writer` and
    # `SectionWriter`, which no module defines, so the writing half of every
    # write turn was dropped as noise -- "Thinking" was the last thing the
    # panel ever heard before the document appeared.
    (re.compile(r"^WritingEngine\.planner"), "Planning the document"),
    (re.compile(r"^WritingEngine\._outline"), "Laying out the sections"),
    (re.compile(r"^WritingEngine\._write_body"), "Writing a section"),
    (re.compile(r"^WritingEngine\.writer"), "Writing the answer"),
    (re.compile(r"^WritingEngine\.dedupe"), "Tidying up the draft"),
    (re.compile(r"^ResearchEngine\.(validate|_think)"), "Checking the sources"),
    (re.compile(r"^PlagiarismEngine\.(check|document_check|run)"), "Checking for plagiarism"),
)


def _human_stage(name: str) -> str:
    """The readable sentence for one engine call, or empty if it is noise."""
    for pattern, label in _STAGE_LABELS:
        if pattern.match(name):
            return label
    return ""


def _install_sink() -> None:
    """Register the log tap so it survives timing's own handler reset.

    utilis.timing._configure() calls logger.remove() before adding its file and
    console handlers, and it runs lazily on the first @timed call - that is, the
    instant a run starts. A sink registered at startup is therefore removed
    moments later and no events ever reach the GUI. Registering from inside the
    worker, after timing has configured itself, is the only point at which the
    handler set is stable.

    The previous registration is dropped first. This is called per chat turn as
    well as per run, and `logger.add` returns a new handler every time: without
    the removal, a session with twenty questions would carry twenty sinks and
    every stage would be emitted twenty times.
    """
    global _SINK_ID
    from utilis import timing
    timing._configure()
    if _SINK_ID is not None:
        try:
            logger.remove(_SINK_ID)
        except ValueError:
            # timing._configure() already removed it, which is its privilege.
            pass
    _SINK_ID = logger.add(_sink, level="INFO")


def _parse_json_object(text: str, prefix: str) -> dict | None:
    """Pull a JSON object out of a log line, tolerating a truncated tail.

    The engine's records are long - a GROUNDING line runs to several hundred
    characters - and loguru's own formatting clips them on some sinks, so the
    tail can be missing mid-object. json.loads would then raise and the event
    would be dropped silently. raw_decode reads as far as it can and yields the
    keys that did arrive, which is exactly what a progress stream needs: a
    partial verdict beats no verdict.
    """
    start = text.find("{")
    if start == -1:
        return None
    decoder = json.JSONDecoder()
    try:
        obj, _ = decoder.raw_decode(text[start:])
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        # Truncated: close the last incomplete value and retry once.
        for cut in range(len(text) - 1, start, -1):
            if text[cut] not in ",{":
                continue
            try:
                obj, _ = decoder.raw_decode(text[start:cut] + "}")
                return obj if isinstance(obj, dict) else None
            except json.JSONDecodeError:
                continue
    return None


def _sink(message) -> None:
    """Forward engine records onto the current run's, or chat turn's, log.

    A loguru sink is global and every run logs to the same place, so the active
    consumer is tracked per-thread: the pipeline is synchronous inside its own
    thread, so thread-local attribution is exact and needs no run id in the log
    line itself. A chat turn publishes the same thread-local under `turn`.
    """
    run = getattr(_CURRENT, "run", None) or getattr(_CURRENT, "turn", None)
    if run is None:
        return
    text = message.record["message"]

    if isinstance(run, ChatTurn) and (m := _EMBED_STAGE.match(text)):
        stage = "Downloading resources" if m.group(1) == "DOWNLOAD" else "Loading the local model"
        if stage != run.last_stage:
            run.last_stage = stage
            run.emit("stage", step=stage)
        return

    # The timing wrapper's line, which is what a chat turn shows as progress.
    # Only a turn takes these: a run already reports by section, and a per-call
    # list would be noise on top of that -- and `stage` is not one of the run
    # events the panel knows how to read, so forwarding it there would leak an
    # unknown event type into a channel with its own vocabulary.
    if (m := _TIMING.match(text)):
        if not isinstance(run, ChatTurn):
            return
        stage = _human_stage(m.group(1))
        if not stage or stage == run.last_stage:
            return
        # A generic "Sleuthing" straight after a query row is the same search
        # arriving twice -- once from its CALL line (which carries the query)
        # and once from its completion. The query row is the better half.
        if stage == "Sleuthing" and run.last_stage.startswith("Sleuthing:"):
            return
        run.last_stage = stage
        run.emit("stage", step=stage, source=m.group(1), took=float(m.group(2)))
        return

    # The search half of the pair above: the CALL line, with its query.
    if isinstance(run, ChatTurn) and (m := _CALL_QUERY.match(text)):
        query = " ".join(m.group(2).split())[:80]
        stage = f"Sleuthing: {query}"
        if stage != run.last_stage:
            run.last_stage = stage
            run.emit("stage", step=stage, source=m.group(1), took=0.0)
        return

    if _GROUNDING.search(text):
        d = _parse_json_object(text, "GROUNDING")
        if d is None:
            return
        run.emit("grounding", section=d.get("section", "")[:80],
                 claims=d.get("claims"), corroborated=d.get("corroborated"),
                 unverified=len(d.get("unverified") or []),
                 authority_suspects=d.get("authority_suspects"))
        return
    if _COHERENCE.search(text):
        d = _parse_json_object(text, "COHERENCE")
        if d is None:
            return
        section = str(d.get("section") or "")[:80]
        run.emit("section", section=section, attempt=d.get("attempt"),
                 verdict=d.get("verdict"), words=d.get("words"))
        # A write is the one task long enough that its sections *are* the
        # progress: the body is produced section by section, and each section
        # takes minutes. Without this the panel shows one unchanging line for
        # the whole write, because the only other per-section signal is a
        # timing line that names the call and not the section.
        if isinstance(run, ChatTurn) and section:
            step = f"Writing \u201c{section}\u201d"
            if step != run.last_stage:
                run.last_stage = step
                run.emit("stage", step=step, source="COHERENCE")
        return
    if (m := _WRITE_GATE.search(text)):
        run.emit("write_gate", written=int(m.group(1)), placeholder=int(m.group(2)))
        return
    if (m := _DRIFT.search(text)):
        run.emit("drift", signal=m.group(1))
        return
    if (m := _ENTITY.search(text)):
        run.emit("entity", detail=m.group(1)[:200])


# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------


# Every request shape the client knows how to speak. An unknown one is refused
# by name rather than silently defaulted: defaulting is how a provider ends up
# "working" while quietly talking to an endpoint it does not support, and the
# only symptom is output that is subtly wrong.
# `cli` is not a request shape but a transport: the turn is handed to a CLI
# agent's one-shot invocation (`opencode run --format json`, `codex exec
# --json`, ...) and answered on stdout. It lives in this tuple because it is
# still a provider protocol as far as every caller is concerned.
PROTOCOLS = ("openai_chat", "openai_responses", "anthropic_messages", "google_generative", "cli")


# Task types whose engines read an existing document. They are handed the
# ephemeral draft's id; everything else runs against the prompt alone.
_DOCUMENT_TASKS = ("WRITE", "REWRITE", "CRITIQUE", "FORMAT")

# The prefix the chat's throwaway document is stored under. Every key a task
# derives from a document id (`written:{id}`, `research:{id}`, ...) inherits it,
# so one prefix scan removes the whole turn's scratch and nothing of the user's.
_CHAT_DOC_PREFIX = "chat:"


def _chat_sources(research: dict) -> list:
    """The pages a research payload grounded an answer in, as chat sources."""
    return [
        {"title": str(p.get("title") or ""), "url": str(p.get("url") or "")}
        for p in (research.get("pages") or [])
        if p.get("url")
    ]


def _normalise_chat_answer(task_type: str, result) -> dict:
    """Turns any task result into the one shape the chat panel renders.

    The six task types return six different shapes -- a bare string, a markdown
    document, a research payload, a critique. The panel needs one shape, so the
    whole point of this function is that it never lets a raw shape through: a
    result it cannot read is an error, not an empty answer.
    """
    if isinstance(result, str):
        text = result.strip()
        if not text:
            raise RuntimeError(f"{task_type} returned nothing")
        # Only SMALLTALK answers in prose. A bare string from any other type is
        # not an answer -- it is a routing failure (`Unknown task type: ...`) --
        # and rendering it as the reply is exactly how a broken turn reads as a
        # completed one.
        if task_type != "SMALLTALK":
            raise RuntimeError(text)
        return {"reply": text, "task": task_type, "sources": []}

    if not isinstance(result, dict):
        raise RuntimeError(f"{task_type} returned {type(result).__name__}, not a result")

    if result.get("blocked"):
        raise RuntimeError(str(result.get("error") or result["blocked"]))
    if result.get("error"):
        raise RuntimeError(str(result["error"]))

    if task_type in ("WRITE", "REWRITE", "FORMAT"):
        markdown = str(result.get("markdown") or "").strip()
        if not markdown:
            raise RuntimeError(f"{task_type} produced no document")
        # A blocked write still returns markdown -- the writer emits a
        # "Generation Halted" notice where the sections would have gone, because
        # a reader deserves to know why nothing was written. That notice is not
        # a document, so the gate's own count decides whether the panel may put
        # it in the editor or must keep it in the bubble.
        gate = result.get("write_gate") or {}
        produced = gate.get("written") if isinstance(gate, dict) else None
        return {
            "reply": markdown,
            "task": task_type,
            "sources": _chat_sources({"pages": result.get("research_pages") or []}),
            "wrote_document": produced is None or int(produced) > 0,
        }

    if task_type == "CRITIQUE":
        thoughts = str((result.get("critique") or {}).get("thoughts") or "").strip()
        if not thoughts:
            raise RuntimeError("CRITIQUE produced no critique")
        return {"reply": thoughts, "task": task_type, "sources": []}

    if task_type == "EXPLAIN":
        answer = str(result.get("answer") or "").strip()
        if not answer:
            raise RuntimeError("EXPLAIN produced no answer")
        return {
            "reply": answer,
            "task": task_type,
            "sources": _chat_sources(result.get("research") or {}),
        }

    if task_type == "RESEARCH":
        summary = str(result.get("summary") or result.get("corpus") or "").strip()
        if not summary:
            raise RuntimeError("RESEARCH produced no summary")
        return {"reply": summary, "task": task_type, "sources": _chat_sources(result)}

    raise RuntimeError(f"unhandled task type {task_type!r}")


def _parse_questionnaire(reply) -> list[dict]:
    """Read the questionnaire JSON, tolerating a fence or a stray preamble."""
    text = str(reply or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("the model did not return a questionnaire")
    body = text[start : end + 1]
    # Some models emit `,"{header":...` instead of `,{"header":...` between
    # question objects. Repair that exact shape before handing it to the JSON
    # parser, otherwise a permissive repairer can drop the following headers.
    for key in ("header", "question", "multiSelect", "options"):
        body = body.replace(f',"{{{key}"', f',{{"{key}"')
    try:
        payload = json.loads(body)
    except (ValueError, TypeError) as exc:
        # Small models regularly drop a `{` between question objects or leave
        # a trailing comma. json_repair is already a project dependency for the
        # research parser; use it before failing the whole interview.
        try:
            from json_repair import loads as repair_loads

            payload = repair_loads(body)
        except Exception:
            raise RuntimeError(f"the questionnaire was not valid JSON: {exc}") from exc
    raw = payload.get("questions") if isinstance(payload, dict) else None
    if not isinstance(raw, list):
        raise RuntimeError("the model returned no questions")

    questions: list[dict] = []
    for entry in raw[:4]:
        if not isinstance(entry, dict):
            continue
        question = str(entry.get("question") or "").strip()
        if not question:
            continue
        options: list[dict] = []
        for option in entry.get("options") or []:
            if isinstance(option, str):
                label, description = option.strip(), ""
            elif isinstance(option, dict):
                label = str(option.get("label") or "").strip()
                description = str(option.get("description") or "").strip()
            else:
                continue
            if label:
                options.append({"label": label[:80], "description": description[:160]})
        if not options:
            continue
        questions.append({
            "header": str(entry.get("header") or "Question").strip()[:16],
            "question": question[:240],
            "multiSelect": bool(entry.get("multiSelect")),
            "options": options[:4],
        })
    if not questions:
        raise RuntimeError("the model returned no usable questions")
    return questions


def _chat_dispatch(
    provider: dict,
    task_type: str,
    task: str,
    draft: str,
    concept_mode: str = "reference",
    token_saving: bool = False,
    natural_voice: bool = False,
    writing_profile: str = "",
    question: str = "",
) -> dict:
    """Runs one classified chat turn and returns the panel's reply shape.

    A document task needs a document, and a chat turn has none, so the draft is
    parsed into a throwaway one. It is stored under `chat:` so the id every task
    derives its keys from carries the prefix, and the whole lot is deleted in the
    `finally`: a chat turn must not leave a document behind in the user's store.
    """
    from utilis.documentparser import DocumentParser

    router = TaskRouter(provider)
    executor = router.task_executor
    ephemeral_id = f"{_CHAT_DOC_PREFIX}{uuid.uuid4().hex}"

    if task_type in _DOCUMENT_TASKS:
        if task_type == "FORMAT":
            # A formatting pass needs the markdown, not an LLM-restructured
            # section tree. Parsing here would add latency and could change the
            # text before the formatter sees it.
            parsed = {
                "unique_id": ephemeral_id,
                "title": "Chat draft",
                "markdown": draft,
                "sections": [],
            }
        else:
            parsed = DocumentParser(provider=provider).parse_text(
                draft, name="chat-draft.md", persist=False
            )
        # Rewritten before it is stored, so `written:{id}`, `research:{id}` and
        # the rest are all born already namespaced.
        parsed["unique_id"] = ephemeral_id
        executor.database.set(ephemeral_id, parsed)

    try:
        if task_type == "WRITE":
            result = executor.Write(
                task, ephemeral_id, concept_mode=concept_mode,
                token_saving=token_saving, natural_voice=natural_voice,
                writing_profile=writing_profile,
            )
        elif task_type == "REWRITE":
            # ReWrite reads `written:{id}`, which a fresh draft does not have. The
            # chat's "rewrite this" means "produce the document, then rewrite it",
            # so the write happens here rather than being left to a prior turn the
            # ephemeral document will never see.
            executor.Write(
                task, ephemeral_id, concept_mode=concept_mode,
                token_saving=token_saving, natural_voice=natural_voice,
                writing_profile=writing_profile,
            )
            result = executor.ReWrite(
                task, ephemeral_id, natural_voice=natural_voice,
                writing_profile=writing_profile,
            )
        elif task_type == "CRITIQUE":
            # Same reasoning as ReWrite: there is nothing to critique until the
            # draft has been written, so it is written first.
            executor.Write(
                task, ephemeral_id, concept_mode=concept_mode,
                token_saving=token_saving, natural_voice=natural_voice,
                writing_profile=writing_profile,
            )
            result = executor.Critique(task, ephemeral_id)
        elif task_type == "RESEARCH":
            result = executor.Research(task)
        elif task_type == "FORMAT":
            result = executor.Format(question or task, ephemeral_id)
        elif task_type == "EXPLAIN":
            # Explain the open draft when there is one; only search when the
            # turn has no document context. The full history is not a subject.
            result = executor.Explain(question or task, context=draft)
        elif task_type == "SMALLTALK":
            # Spelled out rather than derived: `"SMALLTALK".capitalize()` is
            # "Smalltalk", which is not the method's name, and the AttributeError
            # it raised used to read as a task failure.
            result = executor.SmallTalk(task)
        else:
            raise RuntimeError(f"unhandled task type {task_type!r}")
        return _normalise_chat_answer(task_type, result)
    finally:
        for key in executor.database.list_keys():
            if str(key).startswith(_CHAT_DOC_PREFIX) or str(key).endswith(f":{ephemeral_id}"):
                executor.database.delete(key)


def _usage_row(value) -> dict:
    """Normalise one stored model entry, including the legacy integer shape."""
    if isinstance(value, dict):
        return {
            "prompt": int(value.get("prompt") or 0),
            "completion": int(value.get("completion") or 0),
            "total": int(value.get("total") or 0),
            "calls": int(value.get("calls") or 0),
            "estimated_calls": int(value.get("estimated_calls") or 0),
        }
    try:
        total = int(value or 0)
    except (TypeError, ValueError):
        total = 0
    return {"prompt": 0, "completion": 0, "total": total, "calls": 1 if total else 0, "estimated_calls": 0}


def _usage_totals(models: dict) -> dict:
    totals = {"prompt": 0, "completion": 0, "total": 0, "calls": 0, "estimated_calls": 0}
    for value in models.values():
        row = _usage_row(value)
        for key in totals:
            totals[key] += row[key]
    return totals


_CONVERTER = None
_CONVERTER_LOCK = threading.Lock()


def _converter():
    """One MarkItDown instance: its converter registry is expensive to build."""
    global _CONVERTER
    if _CONVERTER is None:
        with _CONVERTER_LOCK:
            if _CONVERTER is None:
                from markitdown import MarkItDown
                _CONVERTER = MarkItDown(enable_builtins=True, enable_plugins=False)
    return _CONVERTER


def _concept_mode(body: dict) -> str:
    """The two modes ConceptEngine understands; anything else is reference."""
    value = str(body.get("concept_mode") or "reference").strip().lower()
    return value if value in ("reference", "survey") else "reference"


_VARIANT_INSTRUCTIONS = {
    "fast": (
        "\n\nEFFORT: fast. Give the shortest answer that is still complete; "
        "prefer a tight list over a long essay and skip optional context."
    ),
    "deep": (
        "\n\nEFFORT: deep. Think the problem through before answering, check the "
        "draft for specifics, and write the fuller version where it adds evidence."
    ),
}


def _route_chat_turn(
    provider: dict,
    transcript: list,
    draft: str,
    concept_mode: str = "reference",
    token_saving: bool = False,
    variant: str = "balanced",
    natural_voice: bool = False,
    writing_profile: str = "",
    research_mode: bool = False,
    forced_task: str = "auto",
) -> dict:
    """Classifies one chat turn and dispatches it to the matching task engine."""
    from utilis.model import Agent

    if token_saving:
        # Token-saving is a budget, not a different assistant: it trims the
        # draft, caps the answer, and asks for the short version. It does not
        # skip the classifier, because routing is the cheap part of a turn.
        provider = {**provider, "max_output_tokens": 900}
        draft = draft[:6000]

    question = transcript[-1][1]
    history = "\n\n".join(f"{role}: {text}" for role, text in transcript[:-1])
    task = f"{history}\n\nuser: {question}" if history else question

    # A format request is an edit of the open draft, not a new subject. Do this
    # before classification: the classifier has repeatedly read "add
    # definitions" as a request to write about definitions.
    if draft.strip() and is_format_request(question):
        return _chat_dispatch(
            provider, "FORMAT", task, draft,
            concept_mode=concept_mode, token_saving=token_saving,
            natural_voice=natural_voice, writing_profile=writing_profile,
            question=question,
        )
    if token_saving:
        task += "\n\n[Token-saving mode: answer concisely, do not repeat the draft.]"
    task += _VARIANT_INSTRUCTIONS.get(str(variant or "balanced").lower(), "")

    forced = str(forced_task or "auto").strip().lower()
    if research_mode:
        forced = "search"
    if forced == "search":
        forced = "research"
    if forced == "survey":
        concept_mode = "survey"
        forced = "write"
    if forced in ("write", "rewrite", "research", "critique", "explain"):
        return _chat_dispatch(
            provider, forced.upper(), task, draft,
            concept_mode=concept_mode, token_saving=token_saving,
            natural_voice=natural_voice, writing_profile=writing_profile,
            question=question,
        )

    response = Agent(provider).Nous(task)
    if not hasattr(response, "task"):
        raise RuntimeError("the classifier returned no task type")

    task_type = str(response.task or "").strip().upper()
    if not task_type:
        raise RuntimeError("the classifier returned an empty task type")

    if task_type not in _DOCUMENT_TASKS + ("RESEARCH", "EXPLAIN", "SMALLTALK"):
        raise RuntimeError(f"unsupported task type {task_type!r}")

    return _chat_dispatch(
        provider, task_type, task, draft,
        concept_mode=concept_mode, token_saving=token_saving,
        natural_voice=natural_voice,
        writing_profile=writing_profile, question=question,
    )


def _is_local_endpoint(base_url: str) -> bool:
    """Whether a base URL names a server on this machine.

    Mirrors `secrets::is_loopback_endpoint` on the Rust side, which reads a
    missing credential for such an endpoint as an empty key rather than an
    error. Both halves have to agree, or the same provider is usable from one
    and refused by the other.
    """
    from urllib.parse import urlsplit

    try:
        host = urlsplit(base_url.strip()).hostname or ""
    except ValueError:
        return False
    return host in {"localhost", "::1", "0.0.0.0"} or host.startswith("127.")


def _provider_config(body: dict) -> dict:
    """Validates the provider block, or explains precisely what is wrong with it."""
    raw = body.get("provider")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        return {"error": "provider must be an object"}
    protocol = str(raw.get("protocol") or "openai_chat")
    if protocol not in PROTOCOLS:
        return {"error": f"unknown protocol {protocol!r}; expected one of {', '.join(PROTOCOLS)}"}
    # A local model server has no key on purpose. Refusing it here made a running
    # Ollama or LM Studio unusable even though the picker could list its models
    # and the core would happily send the request -- the two halves of the app
    # disagreed about the same provider. The exemption is the address, not the
    # name, so a row called `ollama` pointed at a hosted gateway still needs a
    # key and a custom row pointed at localhost still does not. A `cli` provider
    # is exempt for a different reason: it authenticates through the tool's own
    # stored login (codex login, opencode auth) and never sees a key.
    if (
        protocol != "cli"
        and not str(raw.get("api_key") or "").strip()
        and not _is_local_endpoint(str(raw.get("base_url") or ""))
    ):
        return {"error": "provider.api_key is empty"}
    return {
        "id": str(raw.get("id") or ""),
        "vendor": str(raw.get("vendor") or "compatible"),
        "protocol": protocol,
        "base_url": str(raw.get("base_url") or ""),
        "model": str(raw.get("model") or ""),
        # Persona model split (2026-10-30): thinking and writing may want
        # different models. Rust will send these once Task 6 lands; until then
        # QUILL_THINKING_MODEL / QUILL_WRITING_MODEL env covers the slots.
        "thinking_model": str(raw.get("thinking_model") or ""),
        "writing_model": str(raw.get("writing_model") or ""),
        "api_key": str(raw.get("api_key") or ""),
        # 0 means "provider default". Token-saving mode lowers it per request.
        "max_output_tokens": int(raw.get("max_output_tokens") or 0),
    }


def _execute(run: Run) -> None:
    _install_sink()
    _CURRENT.run = run
    run.started_at = time.time()
    run.status = "running"
    run.emit("started", prompt=run.prompt[:200], document_id=run.document_id)
    try:
        # The provider travels on the run object, and every run executes in its
        # own thread with its own instance -- so concurrent runs on different
        # providers cannot borrow each other's credential. No module-level
        # holder is involved, which is the only arrangement that makes that true.
        router = TaskRouter(run.provider)
        result = router.route_task(
            run.prompt, run.document_id, run.session_name,
            concept_mode=run.concept_mode,
        )
        if run.cancelled:
            run.status = "cancelled"
            run.emit("cancelled")
            return
        if isinstance(result, str):
            raise RuntimeError(result)
        result = result or {}
        gate = result.get("write_gate") or {}
        blocked = result.get("blocked") or ""
        if blocked:
            # An early return (prompt/document mismatch, survey limit) never
            # reaches the writer, so there is no write_gate to report. Saying
            # so is the point: the GUI must not render this as a finished
            # document with unknown counts.
            run.status = "blocked"
            run.error = str(result.get("error") or blocked)
            run.emit("blocked", blocked=blocked, error=run.error)
            return
        # The written document travels with the finish, so the GUI can land it
        # in the library. A run started without a document id gets one minted by
        # the /runs handler, and before this payload existed nothing on the
        # other side ever learned the id -- the 2026-11-01 run wrote a full
        # report that sat in the sidecar's store where no reader could see it.
        written_doc = router.task_executor.database.get(run.document_id) or {}
        run.result = {
            "session_name": result.get("session_name", ""),
            "written": gate.get("written"),
            "placeholder": gate.get("placeholder"),
            "document_id": run.document_id,
            "document_title": str(written_doc.get("title") or "")[:200],
            "document_markdown": str(written_doc.get("markdown") or ""),
            "concept": result.get("concept", ""),
            "research_quality": result.get("research_quality"),
            "relevant_pages": result.get("research_relevant_pages"),
            "sources": _chat_sources({"pages": result.get("research_pages") or []}),
            "low_research": result.get("low_research"),
            "gap_research": result.get("gap_research"),
        }
        run.status = "failed" if result.get("error") else "done"
        if result.get("error"):
            run.error = str(result["error"])
        run.emit("finished", **{k: v for k, v in run.result.items() if k != "gap_research"})
    except BaseException as exc:  # noqa: BLE001 - the run must always report
        run.status = "failed"
        run.error = f"{type(exc).__name__}: {exc}"
        logger.exception("api run {} failed", run.id)
        run.emit("failed", error=run.error)
    finally:
        run.finished_at = time.time()
        _CURRENT.run = None


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, payload) -> None:
        self._send(code, json.dumps(payload, default=str).encode())

    def log_message(self, *args) -> None:  # keep the engine's log readable
        return

    # -- GET ---------------------------------------------------------------
    def do_GET(self) -> None:
        path, _, query = self.path.partition("?")
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)

        if path == "/health":
            return self._json(200, {"ok": True, "runs": len(RUNS),
                                    "searxng": os.environ.get("QUILL_SEARXNG_URL", "(default localhost:8080)"),
                                    "gap_research": bool(os.environ.get("QUILL_GAP_RESEARCH"))})
        if path == "/usage":
            # Today's token spend per model, accumulated by the model layer on
            # every call (provider-reported totals, estimates as fallback) --
            # the Settings usage dashboard reads this. `history` is the same
            # data for the last fortnight so the chart can show a trend instead
            # of one day in isolation.
            from datetime import datetime, timezone, timedelta
            from utilis.store import open_store

            store = open_store()
            today = datetime.now(timezone.utc).date()
            today_key = today.isoformat()
            raw_models = store.get(f"usage:{today_key}")
            if not isinstance(raw_models, dict):
                raw_models = {}
            models = {str(model): _usage_row(value) for model, value in raw_models.items()}
            totals = _usage_totals(models)

            history = []
            for offset in range(13, -1, -1):
                day = (today - timedelta(days=offset)).isoformat()
                raw = store.get(f"usage:{day}")
                day_models = {str(model): _usage_row(value) for model, value in raw.items()} if isinstance(raw, dict) else {}
                day_totals = _usage_totals(day_models)
                history.append({"date": day, **day_totals})

            return self._json(200, {
                "date": today_key,
                "limit": int(os.environ.get("QUILL_TPD", "200000")),
                "models": models,
                "totals": totals,
                "history": history,
            })
        if path == "/runs":
            with _RUNS_LOCK:
                return self._json(200, {"runs": [r.snapshot() for r in RUNS.values()]})

        if (m := re.match(r"^/runs/([0-9a-f-]+)$", path)):
            with _RUNS_LOCK:
                run = RUNS.get(m.group(1))
            if not run:
                return self._json(404, {"error": "no such run"})
            return self._json(200, run.snapshot())

        if (m := re.match(r"^/runs/([0-9a-f-]+)/events$", path)):
            with _RUNS_LOCK:
                run = RUNS.get(m.group(1))
            if not run:
                return self._json(404, {"error": "no such run"})
            return self._sse(run, int(params.get("since", 0)))

        return self._json(404, {"error": "not found"})

    def _sse(self, run: Run, since: int) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            for event in run.since(since, timeout=1800):
                # `id` lets the client resume with ?since=<last id> after a drop.
                self.wfile.write(
                    f"id: {event['seq']}\nevent: {event['event']}\n"
                    f"data: {json.dumps(event, default=str)}\n\n".encode()
                )
                self.wfile.flush()
            self.wfile.write(b"event: end\ndata: {}\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the GUI closed the tab; the run continues

    # -- POST --------------------------------------------------------------
    def _complete(self, body: dict) -> None:
        """A very short inline continuation, not a chat turn.

        This is a separate route because a completion must not research, write a
        document or classify a task. It reads the text before and after the
        caret and asks the configured provider for the next few words only.
        """
        provider = _provider_config(body)
        if provider.get("error"):
            return self._json(400, {"error": provider["error"]})
        before = str(body.get("before") or "")[-4000:]
        after = str(body.get("after") or "")[-1200:]
        if len(before.strip()) < 8:
            return self._json(200, {"completion": ""})
        try:
            from utilis.model import Agent
            prompt = (
                "BEFORE:\n" + before + "\n\nAFTER:\n" + after +
                "\n\nWrite only the continuation that belongs at the caret."
            )
            reply = Agent(provider).model(
                prompt,
                system_prompt=(
                    "You continue a writer's sentence in their own voice. Return only the "
                    "continuation, one line, at most 14 words, no quotes, no explanation. "
                    "If no continuation is obvious, return an empty string."
                ),
            )
            line = next((line.strip() for line in str(reply or "").splitlines() if line.strip()), "")
            return self._json(200, {"completion": line[:180]})
        except Exception as exc:  # noqa: BLE001 - completion is optional
            logger.exception("completion failed")
            return self._json(502, {"error": str(exc)})

    def _profile(self, body: dict) -> None:
        """Build a local writing profile from the reader's own documents."""
        texts = body.get("texts")
        if not isinstance(texts, list) or not texts:
            return self._json(400, {"error": "texts must be a non-empty list"})
        cleaned = [str(text) for text in texts if str(text).strip()]
        if not cleaned:
            return self._json(400, {"error": "texts contained no content"})
        # 200k characters is enough for a useful profile and keeps a huge
        # library from turning one click into a multi-second scan.
        sample = [text[:20_000] for text in cleaned[:50]]
        try:
            from utilis.style import profile, profile_prompt

            data = profile(sample)
            return self._json(200, {"profile": data, "prompt": profile_prompt(data)})
        except Exception as exc:  # noqa: BLE001 - the reason is the result
            logger.exception("api profile failed")
            return self._json(502, {"error": str(exc)})

    def _transcribe(self, body: dict) -> None:
        """Turn a short voice recording into text through the provider's STT."""
        import base64

        provider = _provider_config(body)
        if provider.get("error"):
            return self._json(400, {"error": provider["error"]})
        if not provider:
            return self._json(400, {"error": "no provider configured"})
        encoded = str(body.get("audio") or "").strip()
        if not encoded:
            return self._json(400, {"error": "audio is required"})
        try:
            audio = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            return self._json(400, {"error": "audio must be base64"})
        if len(audio) > 24 * 1024 * 1024:
            return self._json(400, {"error": "recording is too large"})
        filename = str(body.get("filename") or "recording.webm")
        mime = str(body.get("mime") or "audio/webm")
        model = str(
            body.get("model")
            or os.environ.get("QUILL_TRANSCRIBE_MODEL")
            or "whisper-large-v3"
        )
        try:
            from utilis.model import Agent

            client = Agent(provider).OpenAi
            if client is None:
                return self._json(400, {"error": "this provider has no audio endpoint"})
            result = client.audio.transcriptions.create(
                model=model,
                file=(filename, audio, mime),
            )
            text = getattr(result, "text", "") or (
                result.get("text", "") if isinstance(result, dict) else ""
            )
            return self._json(200, {"text": str(text).strip(), "model": model})
        except Exception as exc:  # noqa: BLE001 - the panel shows the reason
            logger.exception("api transcription failed")
            return self._json(502, {"error": str(exc)})

    def _verify(self, body: dict) -> None:
        """Resolve citations and look for copied passages in open indexes.

        This is a slow, explicit action: it talks to Crossref, OpenAlex,
        ORCID, Wikidata and Wikipedia. It never writes to the document and it
        does not need a model provider.
        """
        text = str(body.get("text") or "").strip()
        if len(text) < 80:
            return self._json(400, {"error": "text is too short to verify"})
        if len(text) > 40000:
            text = text[:40000]
        try:
            from utilis.verification import analyse_document

            return self._json(200, analyse_document(text))
        except Exception as exc:  # noqa: BLE001 - the reason is the result
            logger.exception("api verification failed")
            return self._json(502, {"error": str(exc)})

    def _questionnaire(self, body: dict) -> None:
        """Ask the model for a short, answerable interview before a write.

        The hard part of a vague drafting request is not the prose, it is the
        missing decisions: who the reader is, what must be included, and what
        must be left out. This route turns those into a small set of
        multiple-choice questions the panel can render as buttons, and returns
        JSON only. The chat turn that follows carries the answers as context.
        """
        provider = _provider_config(body)
        if provider.get("error"):
            return self._json(400, {"error": provider["error"]})
        if not provider:
            return self._json(400, {"error": "no provider configured"})

        raw = body.get("messages")
        if not isinstance(raw, list) or not raw:
            return self._json(400, {"error": "messages must be a non-empty list"})
        turns = []
        for turn in raw[-8:]:
            if not isinstance(turn, dict):
                continue
            text = str(turn.get("content") or "").strip()
            if text:
                turns.append((str(turn.get("role") or "user"), text))
        if not turns:
            return self._json(400, {"error": "messages contained no text"})

        draft = str(body.get("draft") or "").strip()[:6000]
        if bool(body.get("token_saving")):
            provider = {**provider, "max_output_tokens": 700}
        conversation = "\n\n".join(f"{role}: {text}" for role, text in turns)
        prompt = (
            "A writer asked for this and the request leaves decisions open:\n\n"
            + conversation
            + "\n\nDRAFT (may be empty):\n" + (draft or "(empty)")
            + "\n\nWrite the 2-4 questions that would most change the result. "
            "Each question must be answerable by choosing one of its options. "
            "Return JSON only, with no markdown fences:\n"
            '{"questions":[{"header":"<=12 chars","question":"...",'
            '"multiSelect":false,"options":[{"label":"short answer",'
            '"description":"what choosing it means"}]}]}'
        )
        try:
            from utilis.model import Agent

            reply = Agent(provider).model(
                prompt,
                system_prompt=(
                    "You design concise clarifying questionnaires. Return only "
                    "valid JSON. Never ask for information already present in "
                    "the request or the draft. Prefer 2-4 questions and 2-4 "
                    "options per question."
                ),
                temperature=0.2,
            )
            questions = _parse_questionnaire(reply)
            return self._json(200, {"questions": questions})
        except Exception as exc:  # noqa: BLE001 - the panel shows the reason
            logger.exception("api questionnaire failed")
            return self._json(502, {"error": str(exc)})

    def _convert(self, body: dict) -> None:
        """Convert one file the desktop dialog chose into Markdown.

        PDF is the reason this endpoint exists: MarkItDown's PDF converter uses
        pdfplumber to keep tables and headings, while the Rust fallback can only
        read a flat text layer. The sidecar is local and the path came from the
        dialog, so this is the same one-file grant the rest of import uses.
        """
        path = str(body.get("path") or "").strip()
        if not path or not os.path.isfile(path):
            return self._json(400, {"error": f"file not found: {path}"})
        try:
            result = _converter().convert(path)
            return self._json(200, {
                "markdown": result.text_content or "",
                "title": result.title or "",
            })
        except Exception as exc:  # noqa: BLE001 - the caller falls back to Rust
            logger.exception("markitdown conversion failed")
            return self._json(400, {"error": f"conversion failed: {exc}"})

    def _cancel_chat(self, body: dict) -> None:
        """Stop waiting on one live chat turn.

        Python cannot kill a worker thread mid-call, but this ends the SSE
        stream immediately and marks the turn so its late reply is discarded.
        """
        turn_id = str(body.get("turn_id") or "").strip()
        with _CHAT_LOCK:
            turn = CHAT_TURNS.pop(turn_id, None)
        if turn is None:
            return self._json(404, {"error": "no such turn"})
        turn.cancel()
        return self._json(200, {"cancelled": True})

    def _chat(self, body: dict) -> None:
        """One assistant turn, routed through the task pipeline.

        A chat turn is classified and dispatched like a run, so a question that
        asks for research, an explanation, or a critique reaches the same engines
        a run does. That is a deliberate trade: a turn that lands on a heavy task
        now takes as long as that task, not the second a bare model call took. The
        reply carries the classification so the panel can say what it is doing
        before the answer lands.
        """
        provider = _provider_config(body)
        if provider.get("error"):
            return self._json(400, {"error": provider["error"]})
        if not provider:
            return self._json(400, {"error": "no provider configured"})

        raw = body.get("messages")
        if not isinstance(raw, list) or not raw:
            return self._json(400, {"error": "messages must be a non-empty list"})

        transcript = []
        for turn in raw:
            if not isinstance(turn, dict):
                continue
            role = str(turn.get("role") or "user")
            text = str(turn.get("content") or "").strip()
            if text:
                transcript.append((role, text))
        if not transcript:
            return self._json(400, {"error": "messages contained no text"})

        # The open draft is what a document task operates on. Capped for the same
        # reason it always was: the whole draft is the document, and a document is
        # not a chat turn's context.
        draft = str(body.get("draft") or "").strip()[:12000]

        try:
            answer = _route_chat_turn(
                provider, transcript, draft,
                concept_mode=_concept_mode(body),
                token_saving=bool(body.get("token_saving")),
                variant=str(body.get("variant") or "balanced"),
                natural_voice=bool(body.get("natural_voice")),
                writing_profile=str(body.get("writing_profile") or ""),
                research_mode=bool(body.get("research_mode")),
                forced_task=str(body.get("task") or "auto"),
            )
        except Exception as exc:  # noqa: BLE001 - the reason is the whole answer
            logger.exception("api chat failed")
            return self._json(502, {"error": str(exc)})

        return self._json(200, answer)

    def _chat_stream(self, body: dict) -> None:
        """One assistant turn, with its stages pushed as they happen.

        `/chat` answers once, at the end, so a panel calling it can only ever say
        "Thinking" -- it has no idea whether the turn is classifying, searching or
        writing. The work is identical here; it runs on its own thread so this one
        can keep the connection open and write each stage as the log tap sees it.

        The reply still arrives whole, as a `reply` event, so a client that only
        wants the answer can ignore everything before it. Progress is additive,
        not a change of protocol.
        """
        provider = _provider_config(body)
        if provider.get("error"):
            return self._json(400, {"error": provider["error"]})
        if not provider:
            return self._json(400, {"error": "no provider configured"})

        raw = body.get("messages")
        if not isinstance(raw, list) or not raw:
            return self._json(400, {"error": "messages must be a non-empty list"})

        transcript = []
        for turn in raw:
            if not isinstance(turn, dict):
                continue
            role = str(turn.get("role") or "user")
            text = str(turn.get("content") or "").strip()
            if text:
                transcript.append((role, text))
        if not transcript:
            return self._json(400, {"error": "messages contained no text"})

        draft = str(body.get("draft") or "").strip()[:12000]
        concept_mode = _concept_mode(body)
        turn = ChatTurn()
        with _CHAT_LOCK:
            CHAT_TURNS[turn.id] = turn

        def work() -> None:
            _CURRENT.run = None
            _CURRENT.turn = turn
            try:
                # Installed from inside the worker for the reason in
                # `_install_sink`: timing reconfigures the handlers lazily.
                _install_sink()
                turn.reply = _route_chat_turn(
                    provider, transcript, draft, concept_mode=concept_mode,
                    token_saving=bool(body.get("token_saving")),
                    variant=str(body.get("variant") or "balanced"),
                    natural_voice=bool(body.get("natural_voice")),
                    writing_profile=str(body.get("writing_profile") or ""),
                    research_mode=bool(body.get("research_mode")),
                    forced_task=str(body.get("task") or "auto"),
                )
            except Exception as exc:  # noqa: BLE001 - the reason is the answer
                logger.exception("api chat stream failed")
                turn.error = str(exc) or exc.__class__.__name__
            finally:
                turn.finish()
                with _CHAT_LOCK:
                    CHAT_TURNS.pop(turn.id, None)

        threading.Thread(target=work, daemon=True).start()

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # `Connection: close`, and the socket is actually closed when the
        # handler returns. Keep-alive with no Content-Length and no chunked
        # framing gives the client no way to know the response is over: it
        # waits for EOF, the server waits for another request on the same
        # socket, and the turn that just answered sits finished and unseen.
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            for event in turn.stream():
                self.wfile.write(
                    f"event: {event['event']}\n"
                    f"data: {json.dumps(event, default=str)}\n\n".encode()
                )
                self.wfile.flush()
            if turn.reply is not None:
                self.wfile.write(
                    b"event: reply\ndata: "
                    + json.dumps(turn.reply, default=str).encode()
                    + b"\n\n"
                )
            else:
                self.wfile.write(
                    b"event: error\ndata: "
                    + json.dumps({"error": turn.error or "the turn failed"}).encode()
                    + b"\n\n"
                )
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the panel went away; the turn still finishes on its thread

    def do_POST(self) -> None:
        route = self.path.rstrip("/")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "body must be JSON"})

        if route == "/convert":
            return self._convert(body)
        if route == "/complete":
            return self._complete(body)
        if route == "/questionnaire":
            return self._questionnaire(body)
        if route == "/verify":
            return self._verify(body)
        if route == "/profile":
            return self._profile(body)
        if route == "/transcribe":
            return self._transcribe(body)
        if route == "/chat/cancel":
            return self._cancel_chat(body)
        if route == "/chat":
            return self._chat(body)
        if route == "/chat/stream":
            return self._chat_stream(body)
        if route != "/runs":
            return self._json(404, {"error": "not found"})

        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            return self._json(400, {"error": "prompt is required"})

        # Resolved before the document block: parsing restructures the source
        # with an LLM, so it needs the same provider the run will use. Two
        # clients built from two different sources is how a document gets
        # restructured by a model other than the one being credited for it, and
        # it was invisible because both calls succeeded.
        provider = _provider_config(body)
        if provider.get("error"):
            # Refused before the run exists, so a bad provider cannot leave a
            # queued run behind that later fails for a reason nobody can see.
            return self._json(400, {"error": provider["error"]})

        document_id = str(body.get("document_id") or "").strip()
        if not document_id:
            try:
                from main import SOURCE_DOCUMENT
                from utilis.documentparser import DocumentParser
                document_id = DocumentParser(provider=provider).parse(
                    str(body.get("source") or SOURCE_DOCUMENT))["unique_id"]
            except BaseException as exc:  # noqa: BLE001
                return self._json(400, {"error": f"document parse failed: {exc}"})

        run = Run(uuid.uuid4().hex, prompt, document_id,
                  str(body.get("session_name") or ""),
                  str(body.get("concept_mode") or "reference"),
                  provider)
        with _RUNS_LOCK:
            RUNS[run.id] = run
        threading.Thread(target=_execute, args=(run,), daemon=True).start()
        return self._json(202, {"run_id": run.id, "status": run.status,
                                "events": f"/runs/{run.id}/events"})

    # -- DELETE ------------------------------------------------------------
    def do_DELETE(self) -> None:
        m = re.match(r"^/runs/([0-9a-f-]+)$", self.path)
        if not m:
            return self._json(404, {"error": "not found"})
        with _RUNS_LOCK:
            run = RUNS.get(m.group(1))
        if not run:
            return self._json(404, {"error": "no such run"})
        if run.status in ("done", "failed", "cancelled"):
            return self._json(409, {"error": f"run already {run.status}"})
        # Cooperative: checked between phases, so an in-flight LLM call still
        # completes. Killing mid-call would leave the rate limiter mid-budget.
        run.cancelled = True
        return self._json(202, {"run_id": run.id, "status": "cancelling"})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1",
                    help="interface to bind; loopback unless you are running this "
                         "in a container and need it reachable from outside")
    ap.add_argument("--bind", default="", help="override the output directory for runs")
    args = ap.parse_args()

    if args.bind:
        SessionManager.__init__.__defaults__ = (args.bind,)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    logger.info("quill api listening on http://{}:{}", args.host, args.port)
    print(f"quill api on http://{args.host}:{args.port}  (health: /health)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())