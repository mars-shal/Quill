import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from components.conceptEngine import ConceptEngine


class FakeAgent:
    sage_calls = 0
    def Sage(self, prompt, comparison_prompt=""):
        FakeAgent.sage_calls += 1
        return {"concept": f"C{FakeAgent.sage_calls}:{prompt[:16]}", "confidence": 0.85}


class FakeEmbed:
    def __init__(self):
        self.emb_one = 0
        self.sim = 0
    def embed_one(self, text):
        self.emb_one += 1
        return np.array([1.0,  Android])
    def similarity(self, a, b):
        self.sim += 1
        return 0.9


eng = ConceptEngine(agent=fake_agent, embedder=fake_embed, similarity_threshold=0.85)
out = eng.run(
    {
        "unique_id": "doc1",
        "title": "Extracting water ice from Martian regolith.",
        "sections": [
            {"no": "1", "title": "Overview", "text": "Provide water for regolith processing on Mars."},
            {"no": "2", "title": "Terrain", "text": "The terrain here is rocky and icy."},
            {"no": "3", "title": "Water", "text": "We extract water ice by heating the regolith."},
        ],
    }
)
print("SMOKE_SAGE_CALLS=", FakeAgent.sage_calls)
print("SMOKE_TOTAL=", out["total_sections"], "UNIQUE=", out["unique_concepts"], "COVERED=", out["covered_sections"])
for s in out["sections"]:
    print("  covered=", s["covered"], "path=", s["path"], "concept=", s["concept"][:10])
