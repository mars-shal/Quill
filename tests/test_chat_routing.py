"""A chat turn is classified and dispatched, and leaves no document behind.

The chat panel used to answer every turn with one bare model call, so a question
that asked for research quietly got a shorter, ungrounded answer instead. Routing
a turn through the task pipeline fixes that and creates two obligations this test
pins down: a turn that lands on a document task must run against a throwaway
document rather than the reader's own, and the whole turn's scratch must be gone
when the answer comes back. The six task types also return six different shapes,
so the third obligation is that none of them reaches the panel unnormalised.

Run with `PYTHONPATH=$PWD .venv/bin/python tests/test_chat_routing.py`.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api
from components.orchestrator import Task, TaskRoutingError, TaskRouter
from utilis.pydanticModels import NousResponse
from utilis.store import SqliteDatabase


def _check(results, name, cond, detail=""):
    results.append(cond)
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else f"   [{detail}]"))


class _RecordingStore(SqliteDatabase):
    """A store that keeps the row every task writes, so isolation is checkable."""

    def __init__(self):
        super().__init__(os.path.join(
            os.environ.get("TMPDIR", "/tmp"), f"quill-chat-{os.getpid()}.db"
        ))


def _fake_nous(task_type, links=None):
    def _nous(self, prompt):
        return NousResponse(task=task_type, confidence=1.0, links=list(links or []))
    return _nous


def _run_turn(
    task_type, executor_stub, question="hello", draft="the draft",
    history=(), **overrides,
):
    """Dispatches one turn with the classifier and executor stubbed out.

    `_chat_dispatch` builds its router itself, so the seam is the router class:
    swapping `api.TaskRouter` for a one-off that hands back the stub keeps the
    turn away from a real agent and a real store.
    """
    from utilis.model import Agent

    class _Router:
        def __init__(self, provider):
            self.task_executor = executor_stub

    saved_nous = Agent.Nous
    saved_router = api.TaskRouter
    Agent.Nous = _fake_nous(task_type)
    api.TaskRouter = _Router
    try:
        return api._route_chat_turn(
            {"api_key": "sk-test", "base_url": "https://example.test/v1"},
            [("user", item) for item in history] + [("user", question)],
            draft,
            **overrides,
        )
    finally:
        Agent.Nous = saved_nous
        api.TaskRouter = saved_router


class _StubExecutor:
    """Stands in for Task: records the call, returns the shape under test."""

    def __init__(self, payload, *, expect_document=False):
        self.payload = payload
        self.expect_document = expect_document
        self.calls = []
        self.seen_tasks = []
        self.seen_contexts = []
        self.database = _RecordingStore()
        self.seen_document_ids = []

    def _record(self, name, task, document_id="", **kwargs):
        self.calls.append(name)
        self.seen_tasks.append(task)
        self.seen_document_ids.append(document_id)
        return self.payload

    def Write(self, task, document_id="", session_name="", concept_mode="reference", **kwargs):
        return self._record("Write", task, document_id)

    def ReWrite(self, task, document_id="", **kwargs):
        return self._record("ReWrite", task, document_id)

    def Format(self, task, document_id="", **kwargs):
        return self._record("Format", task, document_id)

    def Critique(self, task, document_id=""):
        return self._record("Critique", task, document_id)

    def Research(self, task, **kwargs):
        return self._record("Research", task)

    def Explain(self, task, **kwargs):
        return self._record("Explain", task)

    def Search(self, task, context=""):
        self.seen_contexts.append(context)
        return self._record("Search", task)

    def SmallTalk(self, task):
        return self._record("SmallTalk", task)


def _real_document_is_untouched(results):
    """A chat turn must not read or write the reader's own document.

    The ephemeral document lives in the same store as everything else, so the
    only thing keeping the two apart is the `chat:` prefix on its id and the
    sweep that removes it. This runs a real `_chat_dispatch` against a store
    that already holds a real document and checks both halves of that.
    """
    from utilis.documentparser import DocumentParser
    from utilis.model import Agent

    store = _RecordingStore()
    store.set("real-doc", {"unique_id": "real-doc", "title": "Mine"})

    class _WriteStub(_StubExecutor):
        def __init__(self):
            super().__init__(None)
            self.database = store

        def Write(self, task, document_id="", session_name="", concept_mode="reference", **kwargs):
            # Every key a real Write derives, so the sweep has something to miss.
            self.database.set(f"written:{document_id}", {"unique_id": document_id})
            self.database.set(f"research:{document_id}", {"corpus": "..."})
            return {"markdown": "# generated"}

    stub = _WriteStub()

    def _parse(self, text, name="inline.md", persist=False):
        return {"unique_id": "REPLACED", "title": name, "markdown": text, "sections": []}

    saved_parse = DocumentParser.parse_text
    saved_router = api.TaskRouter
    saved_nous = Agent.Nous
    DocumentParser.parse_text = _parse
    Agent.Nous = _fake_nous("WRITE")

    class _Router:
        def __init__(self, provider):
            self.task_executor = stub

    api.TaskRouter = _Router
    try:
        api._route_chat_turn(
            {"api_key": "sk-test", "base_url": "https://example.test/v1"},
            [("user", "write me something")], "draft",
        )
    finally:
        DocumentParser.parse_text = saved_parse
        api.TaskRouter = saved_router
        Agent.Nous = saved_nous

    _check(
        results,
        "the reader's own document is untouched by a chat turn",
        store.get("real-doc") == {"unique_id": "real-doc", "title": "Mine"},
        repr(store.get("real-doc")),
    )

    leftovers = [k for k in store.list_keys() if "chat:" in str(k)]
    _check(
        results,
        "no chat: scratch row survives the turn",
        not leftovers,
        ", ".join(leftovers),
    )


def main() -> int:
    results: list[bool] = []
    provider = {"api_key": "sk-test", "base_url": "https://example.test/v1"}

    # -- every task type reaches its engine, and the document types get an id --
    dispatch_cases = {
        "WRITE": ("Write", {"markdown": "# Doc", "research_pages": []}),
        "REWRITE": ("ReWrite", {"markdown": "# Doc"}),
        "CRITIQUE": ("Critique", {"critique": {"thoughts": "Fine."}}),
        "RESEARCH": ("Research", {"summary": "Found it.", "pages": []}),
        "EXPLAIN": ("Explain", {"answer": "Because.", "research": {"pages": []}}),
        "SMALLTALK": ("SmallTalk", "Hello there."),
    }
    for task_type, (engine, payload) in dispatch_cases.items():
        stub = _StubExecutor(payload)
        try:
            answer = _run_turn(task_type, stub)
        except Exception as exc:
            _check(results, f"{task_type} dispatches", False, repr(exc))
            continue
        _check(
            results,
            f"{task_type} reaches {engine}",
            engine in stub.calls,
            ", ".join(stub.calls),
        )
        _check(
            results,
            f"{task_type} answer is normalised",
            {"reply", "task", "sources"} <= set(answer) and answer["task"] == task_type,
            repr(answer),
        )

    # -- REWRITE and CRITIQUE write first, then run their own engine --
    for task_type, engine in (("REWRITE", "ReWrite"), ("CRITIQUE", "Critique")):
        stub = _StubExecutor(
            {"markdown": "# D"} if task_type == "REWRITE" else {"critique": {"thoughts": "ok"}}
        )
        _run_turn(task_type, stub)
        _check(
            results,
            f"{task_type} writes the draft before running {engine}",
            stub.calls[:2] == ["Write", engine],
            ", ".join(stub.calls),
        )

    # -- the document task gets the turn, not the whole transcript --
    history_stub = _StubExecutor({"markdown": "# D"})
    _run_turn(
        "REWRITE", history_stub, question="tighten this",
        history=[
            "New conversation. What would you like to work on?",
            "can rewrite the document in the words of a 10 year old",
        ],
    )
    _check(
        results,
        "a chat rewrite gets only the latest question",
        history_stub.seen_tasks and all(
            task == "tighten this" for task in history_stub.seen_tasks
        ),
        repr(history_stub.seen_tasks),
    )

    # -- a question about the draft is answered, never written --
    question_stub = _StubExecutor({"answer": "No, the draft does not contain Miller."})
    answer = _run_turn(
        "WRITE", question_stub, question="did you remove millers effect?"
    )
    _check(
        results,
        "a draft question routes to Search before classification",
        question_stub.calls == ["Search"] and answer.get("task") == "SEARCH",
        f"{question_stub.calls} {answer.get('task')}",
    )

    long_draft = "The Miller effect is discussed here. " * 900
    long_stub = _StubExecutor({"answer": "Still there."})
    _run_turn("WRITE", long_stub, question="did you remove the Miller effect?", draft=long_draft)
    _check(
        results,
        "Search receives the whole draft, not a 12k slice",
        long_stub.seen_contexts and len(long_stub.seen_contexts[0]) == len(long_draft),
        f"{len(long_stub.seen_contexts[0]) if long_stub.seen_contexts else 0} of {len(long_draft)}",
    )

    write_stub = _StubExecutor({"markdown": "# Thesis", "write_gate": {"written": 1}})
    _run_turn("WRITE", write_stub, question="can you write a thesis about Rome?")
    _check(
        results,
        "a request for a new work still writes",
        write_stub.calls == ["Write"],
        repr(write_stub.calls),
    )

    # -- search mode answers from the draft, never from the web --
    search_stub = _StubExecutor({"answer": "The draft does not contain Miller."})
    answer = _run_turn(
        "SEARCH", search_stub, question="did you remove the Miller effect?"
    )
    _check(
        results,
        "SEARCH reaches the document search",
        search_stub.calls == ["Search"] and answer.get("task") == "SEARCH",
        f"{search_stub.calls} {answer.get('task')}",
    )

    forced_search = _StubExecutor({"answer": "It is in the Miller effect section."})
    answer = _run_turn(
        "WRITE", forced_search,
        question="did you remove the Miller effect?", forced_task="search",
    )
    _check(
        results,
        "Search mode forces document search before classification",
        forced_search.calls == ["Search"] and answer.get("task") == "SEARCH",
        f"{forced_search.calls} {answer.get('task')}",
    )

    no_draft = _StubExecutor({"summary": "Web answer.", "pages": []})
    answer = _run_turn(
        "WRITE", no_draft,
        question="did you remove the Miller effect?", draft="", forced_task="search",
    )
    _check(
        results,
        "Search mode falls back to research without a draft",
        no_draft.calls == ["Research"] and answer.get("task") == "RESEARCH",
        f"{no_draft.calls} {answer.get('task')}",
    )

    # -- a rewrite of the open draft is an edit, not a new subject --
    edit_stub = _StubExecutor(
        {"markdown": "# Rewritten", "write_gate": {"written": 1, "placeholder": 0}}
    )
    answer = _run_turn(
        "REWRITE", edit_stub,
        question="can rewrite the document in the words of a 10 year old to better explain it to me",
    )
    _check(
        results,
        "a self-referential rewrite routes to FORMAT",
        edit_stub.calls == ["Format"] and answer.get("task") == "FORMAT",
        f"{edit_stub.calls} {answer.get('task')}",
    )

    class _BlockedWrite(_StubExecutor):
        def __init__(self):
            super().__init__(None)

        def Write(self, task, document_id="", session_name="", concept_mode="reference", **kwargs):
            self.calls.append("Write")
            return {
                "error": "Prompt and source document are unrelated",
                "blocked": "prompt_document_mismatch",
            }

        def ReWrite(self, task, document_id="", **kwargs):
            self.calls.append("ReWrite")
            return {"markdown": "# Generation Halted", "write_gate": {"written": 0}}

    blocked_prerequisite = _BlockedWrite()
    raised = ""
    try:
        _run_turn("REWRITE", blocked_prerequisite)
    except Exception as exc:
        raised = str(exc)
    _check(
        results,
        "a blocked prerequisite stops the rewrite",
        raised.startswith("Prompt and source document are unrelated")
        and blocked_prerequisite.calls == ["Write"],
        f"{raised!r} {blocked_prerequisite.calls}",
    )

    # -- the document types are handed a namespaced id, others are not --
    doc_stub = _StubExecutor({"markdown": "# D", "research_pages": []})
    _run_turn("WRITE", doc_stub)
    _check(
        results,
        "a document task is handed a chat:-namespaced id",
        doc_stub.seen_document_ids and doc_stub.seen_document_ids[0].startswith("chat:"),
        repr(doc_stub.seen_document_ids),
    )
    light_stub = _StubExecutor({"summary": "s", "pages": []})
    _run_turn("RESEARCH", light_stub)
    _check(
        results,
        "a prompt-only task is handed no document id",
        light_stub.seen_document_ids == [""],
        repr(light_stub.seen_document_ids),
    )

    # -- the write gate decides whether the panel may touch the document --
    written_stub = _StubExecutor(
        {"markdown": "# D", "research_pages": [], "write_gate": {"written": 2, "placeholder": 0}}
    )
    answer = _run_turn("WRITE", written_stub)
    _check(
        results,
        "a write that produced sections is a document",
        answer.get("wrote_document") is True,
        repr(answer),
    )

    blocked_stub = _StubExecutor(
        {
            "markdown": "# Generation Halted\n\n> THIS RUN PRODUCED NO CONTENT.",
            "research_pages": [],
            "write_gate": {"written": 0, "placeholder": 7},
        }
    )
    answer = _run_turn("WRITE", blocked_stub)
    _check(
        results,
        "a write the gate blocked is not a document",
        answer.get("wrote_document") is False,
        repr(answer),
    )
    _check(
        results,
        "a blocked write still carries its notice",
        "Generation Halted" in answer["reply"],
        repr(answer["reply"][:60]),
    )

    # -- sources are carried out of a research payload --
    explain_stub = _StubExecutor(
        {"answer": "Yes.", "research": {"pages": [
            {"title": "A", "url": "http://a"}, {"title": "no url", "url": ""},
        ]}}
    )
    answer = _run_turn("EXPLAIN", explain_stub)
    _check(
        results,
        "EXPLAIN carries its grounded sources",
        answer["sources"] == [{"title": "A", "url": "http://a"}],
        repr(answer["sources"]),
    )

    # -- a failure is raised, never returned as an answer --
    err_stub = _StubExecutor({"error": "the engine refused"})
    raised = ""
    try:
        _run_turn("WRITE", err_stub)
    except Exception as exc:
        raised = str(exc)
    _check(results, "an engine error is raised, not answered", raised == "the engine refused", raised)

    unknown_stub = _StubExecutor("Unknown task type: FLY")
    raised = ""
    try:
        _run_turn("RESEARCH", unknown_stub)
    except Exception as exc:
        raised = str(exc)
    _check(
        results,
        "a non-SMALLTALK string result is a failure, not an answer",
        raised == "Unknown task type: FLY",
        raised,
    )

    # -- a classifier that is not a NousResponse is a failure --
    from utilis.model import Agent
    saved = Agent.Nous
    Agent.Nous = lambda self, prompt: "not json"
    raised = ""
    try:
        api._route_chat_turn(provider, [("user", "hi")], "")
    except Exception as exc:
        raised = str(exc)
    finally:
        Agent.Nous = saved
    _check(
        results,
        "a classifier that returns prose fails the turn",
        "task type" in raised,
        raised,
    )

    _real_document_is_untouched(results)

    passed = sum(results)
    print(f"\n{'ALL PASS' if passed == len(results) else 'FAILURES'}: {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
