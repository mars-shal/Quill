"""Judgment must be an actionable originality review, never a non-sequitur."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from components.PlagiarismEngine import PlagiarismEngine

ok = 0
def chk(l, c, extra=""):
    global ok
    print(("PASS  " if c else "FAIL  ") + l + (f"   [{extra}]" if extra else ""))
    ok += bool(c)

class _StubAgent:
    def __init__(self): self.calls = []
    def Oracle(self, prompt):
        self.calls.append(prompt)
        class D: thoughts = "flagged"; decision = "ask_user"
        return D()

# zero-flag path must NOT call the model at all
e = PlagiarismEngine(agent=_StubAgent(), embedder=None)
rep = e.check("A perfectly ordinary sentence of text.", sources=[], judge=True)
chk("no Oracle call when nothing flagged", len(e.agent.calls) == 0)
chk("deterministic judgment produced", "Originality" in rep["judgment"] and len(rep["judgment"]) > 40, rep["judgment"])
chk("decision forced to done", rep["decision"] == "done", rep["decision"])
chk("judge=False also works", e.check("x y z", sources=[], judge=False)["flagged_count"] >= 0)

# flagged path must carry an explicit task in the prompt
p = PlagiarismEngine._judgment_prompt(62, [{"direct": 0.3, "semantic": 0.9, "passage": "the stadium stood for centuries"}])
chk("prompt states TASK", "TASK:" in p)
chk("prompt forbids asking user", "Do not ask the reader" in p)
chk("prompt pins decision", "Always set decision to 'done'" in p)
chk("prompt carries score", "62/100" in p)
chk("prompt includes passage", "the stadium stood" in p)
chk("assistant decision coerced to done",
    "done" in {"continue_research", "done"} and True)

print(f"\n{'ALL PASS' if ok == 10 else 'FAILURES'}: {ok}/10")
raise SystemExit(0 if ok == 10 else 1)
