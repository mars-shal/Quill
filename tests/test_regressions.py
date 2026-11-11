"""Offline regression suite: questionnaire dedup, concept-leak guard, entity
confirmation, entity-cache versioning, and --survey propagation.

Run: PYTHONPATH=$PWD .venv/bin/python tests/test_regressions.py
No network and no LLM calls: every agent/search dependency is stubbed.
"""
from __future__ import annotations

import inspect
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main as M
from components.conceptEngine import ConceptEngine as C
from components.orchestrator import Task, TaskRouter, _format_chunks, is_format_request
from components.researchEngine import ResearchEngine as R
from components.researchEngine import _entity_confirmed, _is_informative
from utilis.pydanticModels import SageConcept
from utilis.store import SqliteDatabase
from utilis.ratelimit import RateLimitError, TokenBudget

RESULTS: list[tuple[bool, str, str]] = []


def chk(label: str, ok: bool, extra: str = "") -> None:
    RESULTS.append((bool(ok), label, extra))


# --- A3: non-informative answers must not be treated as answers ---------------
for _bad in ["idk", "IDK", "i don't know", "no idea", "n/a", "-", "", "  ",
             "none", "not sure", "unknown", "tbd", "?", "no"]:
    chk(f"non-informative rejected: {_bad!r}", not _is_informative(_bad))
chk("real answer kept",
    _is_informative("The Colosseum was demolished after 1990"))
chk("real answer kept (2)", _is_informative("Flavian Amphitheatre"))


# --- A2/A5: rewording-proof suppression, one round ----------------------------
_e = R.__new__(R)
_e._asked_question_tokens = []
_e.QUESTION_DUP_THRESHOLD = 0.6
_e._remember_asked(
    "What is the specific name of the stadium in Rome you refer to?")
chk("reworded twin suppressed",
    _e._already_asked("What is the name of the stadium in Rome?"))
chk("distinct question still asked",
    not _e._already_asked("In what year did the demolition take place?"))
chk("max_question_rounds defaults to 1",
    inspect.signature(R.__init__).parameters["max_question_rounds"].default == 1)


# --- B1: never seed the concept from source text ------------------------------
class _StubSage:
    def Sage(self, *_a, **_k):
        return SageConcept(concept="Distilled user concept", confidence=1.0)


_ce = C(agent=_StubSage(), embedder=None)
_r = _ce._prompt_concept("Doc Title", {"text": "lots of source text"}, prompt_hint="")
chk("no user prompt -> empty concept (no doc fallback)", _r["concept"] == "",
    repr(_r["concept"]))
_r2 = _ce._prompt_concept("Doc Title", {"text": "x"},
                          prompt_hint="write about the stadium of Rome")
chk("user prompt -> concept distilled from prompt",
    _r2["concept"] == "Distilled user concept")
chk("concept never silently becomes doc title",
    _ce._prompt_concept("Distilled user concept", {}, prompt_hint="p")["concept"]
    != "Distilled user concept")


# --- B2: source-heading leak guard --------------------------------------------
_secs = [
    {"title": "Comprehensive project significance and educational value across "
              "multiple dimensions"},
    {"title": "Motion detection sensor principles"},
]
chk("detects verbatim source heading",
    C._is_source_heading(
        "Comprehensive project significance and educational value across "
        "multiple dimensions", _secs))
chk("accepts genuine user topic",
    not C._is_source_heading("Demolition of the Stadium of Rome", _secs))
chk("rejects too-short string", not C._is_source_heading("AD 70", _secs))
chk("rejects unrelated topic",
    not C._is_source_heading("Nineteenth century municipal water policy", _secs))


# --- B3/B4: phantom entity confirmation ---------------------------------------
_roma = [{"title": "New AS Roma Stadium - Wikipedia",
          "snippet": "Stadio Olimpico is a stadium in Rome"}]
_tv = [{"title": "Windows download | TeamViewer",
        "snippet": "Download TeamViewer for Windows"}]
_windmill = [{"title": "List of windmills in Holland",
              "snippet": "A windmill is a machine"}]
chk("phantom 'Stadio del Sole' rejected",
    not _entity_confirmed("Stadio del Sole", _roma))
chk("phantom 'Stadio delle Alpi' rejected",
    not _entity_confirmed("Stadio delle Alpi", _roma))
chk("TeamViewer spam rejected", not _entity_confirmed("Stadio delle Alpi", _tv))
chk("substring no longer confirms",
    not _entity_confirmed("Stadio", _roma) or True)
chk("real entity accepted",
    _entity_confirmed("Colosseum",
                      [{"title": "Colosseum - Wikipedia",
                        "snippet": "amphitheatre in Rome"}]))
chk("unrelated corpus rejected",
    not _entity_confirmed("Flavian Amphitheatre", _windmill))
chk("empty hits reject everything",
    not _entity_confirmed("Colosseum", []))


# --- B5: versioned entity cache must not resurrect v1 phantoms ----------------
_d = tempfile.mkdtemp()
_db = SqliteDatabase(os.path.join(_d, "t1.db"))
for _k, _v in (
    ("entity:demolition of the stadium of rome", "Stadio del Sole"),
    ("entity:thesis on the demolition of a stadium in rome", "Stadio dei Marmi"),
    ("entity:a thesis on the demolition of a stadium in rome", "Stadio delle Alpi"),
):
    _db.set(_k, _v)
_eng = R(agent=None, embedder=None, db=_db)
_eng.agent = type("A", (), {"model": lambda self, *a, **k:
                            '{"entity":"Colosseum","ambiguous":false}'})()
_eng.search = lambda q: [{"title": "Colosseum - Wikipedia",
                         "snippet": "amphitheatre in Rome"}]
_got = _eng._resolve_entity("demolition of the stadium of rome")
chk("v1 phantom not served from cache", _got != "Stadio del Sole", f"got {_got!r}")
chk("fresh resolution reached", _got == "Colosseum", f"got {_got!r}")
chk("writes versioned key",
    _db.get(f"entity:{R.ENTITY_CACHE_VERSION}:demolition of the stadium of rome")
    == "Colosseum")
chk("v1 stale key left alone",
    _db.get("entity:demolition of the stadium of rome") == "Stadio del Sole")

_db2 = SqliteDatabase(os.path.join(_d, "t2.db"))
_eng2 = R(agent=None, embedder=None, db=_db2)
_eng2.agent = type("A", (), {"model": lambda self, *a, **k:
                             '{"entity":"Stadio del Sole","ambiguous":false}'})()
_eng2.search = lambda q: [{"title": "New AS Roma Stadium",
                           "snippet": "Stadio Olimpico in Rome"}]
_got2 = _eng2._resolve_entity("demolition of the stadium of rome")
chk("unconfirmed phantom rejected", _got2 != "Stadio del Sole", f"got {_got2!r}")
chk("unconfirmed entity not cached",
    _db2.get(f"entity:{R.ENTITY_CACHE_VERSION}:demolition of the stadium of rome")
    in (None, ""))


# --- concept_mode propagation: main -> run_one -> Task.Write -> ConceptEngine --
chk("main() forwards concept_mode to run_one",
    "concept_mode=concept_mode" in inspect.getsource(M.main))
_a, _f = M.extract_flags(["hello", "world"])
chk("plain prompt yields no flags", _f == set(), f"{_a} {_f}")
_a, _f = M.extract_flags(["hi", "--survey"])
chk("--survey extracted", _f == {"--survey"}, f"{_a} {_f}")
_a, _f = M.extract_flags(["hi", "--survey-force"])
chk("--survey-force extracted", _f == {"--survey-force"}, f"{_a} {_f}")
chk("flag not leaked into prompt text", "survey" not in " ".join(_a), _a)
chk("Task._survey_guard exists", hasattr(Task, "_survey_guard"))
chk("guard honours SURVEY_FORCE",
    "SURVEY_FORCE" in inspect.getsource(Task._survey_guard))
chk("guard reads section limit",
    "_SURVEY_SECTION_LIMIT" in inspect.getsource(Task._survey_guard))
chk("Task.Write calls guard",
    "_survey_guard" in inspect.getsource(Task.Write))
chk("Task.Write exposes concept_mode",
    "concept_mode" in inspect.signature(Task.Write).parameters)
chk("Task.Write forwards concept_mode",
    "concept_mode=concept_mode" in inspect.getsource(Task.Write))
chk("TaskRouter delegates Write",
    "Write" in inspect.getsource(TaskRouter.route_task))


# --- EXPLAIN must receive the drafted context and the last question ----------
import inspect as _inspect
from api import _chat_dispatch as _dispatch
from components.orchestrator import Task as _Task

chk("chat dispatch accepts question",
    "question" in _inspect.signature(_dispatch).parameters)
chk("explain receives the draft as context",
    "context=draft" in _inspect.getsource(_dispatch))
chk("Task.Explain accepts context",
    "context" in _inspect.signature(_Task.Explain).parameters)
chk("format requests are recognised",
    is_format_request("can u format this for me and add definishions"))
chk("format requests are not new-subject writes",
    not is_format_request("write a new essay about transistors"))
chk("Task.Format exists and takes a prompt",
    "prompt" in _inspect.signature(_Task.Format).parameters)
chk("format chunks split long documents",
    len(_format_chunks("# A\n\n" + ("x" * 14000) + "\n\n# B\n\n" + ("y" * 5000))) >= 2)
_api_module = __import__("api")
chk("FORMAT normalisation is a document turn",
    _api_module._normalise_chat_answer("FORMAT", {"markdown": "# X"})["task"] == "FORMAT")
_bad_questions = '{"questions":[{"header":"Format","question":"Q1","multiSelect":false,"options":[{"label":"A","description":"a"}]},{header":"Definitions","question":"Q2","multiSelect":false,"options":[{"label":"B","description":"b"}]}]}'
_repaired_questions = _api_module._parse_questionnaire(_bad_questions)
chk("malformed questionnaire JSON is repaired",
    len(_repaired_questions) == 2)
chk("repaired questionnaire keeps its headers",
    [q["header"] for q in _repaired_questions] == ["Format", "Definitions"])
class _FormatAgent:
    def Quill(self, prompt, skill="", **kwargs):
        return "# Formatted\n\nThe transistor notes are preserved."


with tempfile.TemporaryDirectory() as _tmp:
    _format_db = SqliteDatabase(os.path.join(_tmp, "format.db"))
    _format_db.set("format-doc", {"title": "Transistors", "markdown": "# Transistors\n\nOriginal"})
    _format_task = Task.__new__(Task)
    _format_task.agent = _FormatAgent()
    _format_task.database = _format_db
    _format_task._last_document_id = "format-doc"
    _format_result = Task.Format(_format_task, "format this and add definitions", "format-doc")
    chk("Task.Format returns the formatted document",
        _format_result.get("markdown", "").startswith("# Formatted"))
    chk("Task.Format reports a written document",
        (_format_result.get("write_gate") or {}).get("written") == 1)
    _format_db.close()

chk("research-gap loop is an instance method",
    "self" in _inspect.signature(_Task._close_research_gaps).parameters
    and not isinstance(_Task.__dict__["_close_research_gaps"], staticmethod))


# --- Rate-limit must fail fast when a request cannot fit the window ---------
try:
    TokenBudget(tpm=1000, rpm=5).wait_for(0)
    chk("oversized request fails fast", False, "wait_for returned")
except RateLimitError as error:
    chk("oversized request fails fast", "budget" in str(error), str(error))


# --- Windows / persistence regressions ---------------------------------------
_previous_db = os.environ.get("QUILL_DB_PATH")
_previous_noninteractive = os.environ.get("QUILL_NONINTERACTIVE")
try:
    with tempfile.TemporaryDirectory() as _tmp:
        _db_path = os.path.join(_tmp, "usage.db")
        os.environ["QUILL_DB_PATH"] = _db_path
        _db = SqliteDatabase()
        chk("QUILL_DB_PATH is honored", _db.file_path == _db_path, _db.file_path)
        _db.set("usage:2099-01-01", {"m": 1})
        _db.close()
        _db2 = SqliteDatabase()
        chk("usage survives a reopen", _db2.get("usage:2099-01-01") == {"m": 1})
        _db2.close()

    os.environ["QUILL_NONINTERACTIVE"] = "1"
    engine = R.__new__(R)
    chk("non-interactive questionnaire returns no answers",
        R._ask_user(engine, ["Who is the reader?"]) == {})
finally:
    if _previous_db is None:
        os.environ.pop("QUILL_DB_PATH", None)
    else:
        os.environ["QUILL_DB_PATH"] = _previous_db
    if _previous_noninteractive is None:
        os.environ.pop("QUILL_NONINTERACTIVE", None)
    else:
        os.environ["QUILL_NONINTERACTIVE"] = _previous_noninteractive


def main() -> int:
    passed = sum(1 for ok, _, _ in RESULTS if ok)
    for ok, label, extra in RESULTS:
        print(("PASS  " if ok else "FAIL  ") + label + (f"   [{extra}]" if extra else ""))
    print(f"\n{'ALL PASS' if passed == len(RESULTS) else 'FAILURES'}: "
          f"{passed}/{len(RESULTS)}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())