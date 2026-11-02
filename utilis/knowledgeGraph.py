"""Hybrid knowledge graph utility.

rahulnyk-style side: the corpus is chunked, an LLM extracts concepts and
semantic relations per chunk, and co-occurrence forms additional weighted
edges; the result is stored as a networkx graph (plus pyvis visualization).

cognee-style side: concepts are embedded and persisted, and ``query`` retrieves
the most relevant neighborhood and asks the Oracle to synthesize a grounded
answer (graph-RAG over the document).

The graph is stored as plain JSON via JsonDatabase (key ``graph:{unique_id}``)
and rebuilt into a networkx object on load.
"""

import json
import re
from collections import defaultdict

import networkx as nx

from utilis.database import JsonDatabase
from utilis.embeddings import Embedder
from utilis.model import Agent
from utilis.pydanticModels import ConceptExtraction
from utilis.timing import timed

try:
    import json_repair
except ImportError:  # pragma: no cover
    json_repair = None

_CHUNK_SIZE = 1200
_CHUNK_OVERLAP = 150

_EXTRACTION_SYSTEM = """You extract knowledge from text chunks.
Given the text chunk, return ONLY valid JSON in this exact shape:
{
  "concepts": ["<noun phrase / concept>", ...],
  "relations": [
    {"source": "<concept>", "target": "<concept>", "relation": "<short verb phrase>"}
  ]
}
Rules:
- 3-10 concepts per chunk. Prefer meaningful, specific concepts over generic ones.
- Relations must connect two listed concepts and state an explicit relationship.
- Return nothing else, no prose, no fences."""

_ANSWER_SYSTEM = """You are a graph-grounded researcher.
Answer the question using ONLY the knowledge graph evidence provided.
If the evidence is insufficient, say so explicitly and propose what more is needed.
Keep the answer grounded in the given facts; do not invent specifics."""


class KnowledgeGraph:
    def __init__(
        self,
        agent: Agent | None = None,
        embedder: Embedder | None = None,
        db: JsonDatabase | None = None,
    ):
        self.agent = agent if agent is not None else Agent()
        self.embedder = embedder if embedder is not None else Embedder.get()
        self.db = db if db is not None else JsonDatabase()
        self.graph: nx.MultiDiGraph = nx.MultiDiGraph()
        self._concept_vectors: dict[str, list[float]] = {}

    # --- build / remember ----------------------------------------------------
    @timed("KnowledgeGraph.build")
    def build(self, corpus: str, unique_id: str = "") -> dict:
        chunks = self._chunk(corpus)
        rel_counter: dict[tuple[str, str], int] = defaultdict(int)
        rel_labels: dict[tuple[str, str], list[str]] = defaultdict(list)

        for chunk in chunks:
            extracted = self._extract(chunk)
            concepts = list(dict.fromkeys(extracted.concepts or []))
            relations = extracted.relations or []

            for concept in concepts:
                if concept not in self.graph:
                    self.graph.add_node(concept)
            for rel in relations:
                src = (rel.source or "").strip()
                tgt = (rel.target or "").strip()
                label = (rel.relation or "").strip()
                if src and tgt:
                    rel_counter[(src, tgt)] += 1
                    if label:
                        rel_labels[(src, tgt)].append(label)

            # contextual proximity: concepts in the same chunk are related
            for i, a in enumerate(concepts):
                for b in concepts[i + 1 :]:
                    rel_counter[(a, b)] += 1

        for (src, tgt), weight in rel_counter.items():
            if self.graph.has_edge(src, tgt):
                existing = self.graph[src][tgt][0]
                existing["weight"] += weight
                existing["relations"] = list(
                    dict.fromkeys(existing["relations"] + rel_labels[(src, tgt)])
                )
            else:
                self.graph.add_edge(
                    src, tgt, weight=weight, relations=list(dict.fromkeys(rel_labels[(src, tgt)]))
                )

        summary = self.to_json()
        if unique_id:
            self.db.set(f"graph:{unique_id}", summary)
        return summary

    remember = build

    @timed("KnowledgeGraph._extract")
    def _extract(self, chunk: str) -> ConceptExtraction:
        response = self.agent.model(chunk, system_prompt=_EXTRACTION_SYSTEM)
        try:
            result = json.loads(response)
        except json.JSONDecodeError:
            result = None
            if json_repair is not None:
                try:
                    result = json_repair.loads(response)
                except Exception:
                    result = None
        if not isinstance(result, dict):
            return ConceptExtraction()
        try:
            return ConceptExtraction(**result)
        except (TypeError, ValueError):
            return ConceptExtraction()

    # --- load / persist ------------------------------------------------------
    @timed("KnowledgeGraph.load")
    def load(self, unique_id: str) -> "KnowledgeGraph":
        summary = self.db.get(f"graph:{unique_id}")
        if not summary:
            return self
        self.graph.clear()
        self._concept_vectors.clear()
        for node in summary.get("nodes", []):
            name = node.get("name")
            if name:
                self.graph.add_node(name, weight=node.get("weight", 1))
                if node.get("embedding"):
                    self._concept_vectors[name] = node["embedding"]
        for edge in summary.get("edges", []):
            self.graph.add_edge(
                edge["source"],
                edge["target"],
                weight=edge.get("weight", 1),
                relations=edge.get("relations", []),
            )
        return self

    @timed("KnowledgeGraph.to_json")
    def to_json(self) -> dict:
        nodes = []
        names = list(self.graph.nodes)
        if names and not self._concept_vectors:
            self._vectorize(names)
        for name in names:
            weight = self.graph.degree(name)
            nodes.append(
                {
                    "name": name,
                    "weight": weight,
                    "embedding": self._concept_vectors.get(name),
                }
            )
        edges = []
        for src, tgt, data in self.graph.edges(data=True):
            edges.append(
                {
                    "source": src,
                    "target": tgt,
                    "weight": data.get("weight", 1),
                    "relations": data.get("relations", []),
                }
            )
        return {"nodes": nodes, "edges": edges}

    @timed("KnowledgeGraph._vectorize")
    def _vectorize(self, names: list[str]):
        vectors = self.embedder.embed(names)
        for name, vec in zip(names, vectors):
            self._concept_vectors[name] = vec

    # --- analytics (rahulnyk-style) -----------------------------------------
    @timed("KnowledgeGraph.central_nodes")
    def central_nodes(self, top_k: int = 10) -> list[tuple[str, float]]:
        if not self.graph.number_of_nodes():
            return []
        degrees = dict(self.graph.degree())
        ordered = sorted(degrees.items(), key=lambda kv: kv[1], reverse=True)
        max_d = ordered[0][1] if ordered else 1
        return [(name, round(deg / max_d, 3)) for name, deg in ordered[:top_k]]

    @timed("KnowledgeGraph.communities")
    def communities(self) -> dict[int, list[str]]:
        if self.graph.number_of_nodes() < 2:
            return {0: list(self.graph.nodes)}
        simple = nx.Graph()
        simple.add_edges_from(self.graph.edges())
        communities = nx.community.greedy_modularity_communities(simple)
        return {i: sorted(list(c)) for i, c in enumerate(communities)}

    def visualize(self, path: str = "knowledge_graph.html") -> str | None:
        try:
            from pyvis.network import Network
        except ImportError:  # pragma: no cover
            return None
        net = Network(height="700px", width="100%", directed=True)
        for name, data in self.graph.nodes(data=True):
            net.add_node(name, label=name, size=min(10 + 10 * data.get("weight", 1), 60))
        for src, tgt, data in self.graph.edges(data=True):
            label = (data.get("relations") or [""])[0]
            net.add_edge(src, tgt, title=label, value=data.get("weight", 1))
        net.write_html(path)
        return path

    def nodes_count(self) -> int:
        return self.graph.number_of_nodes()

    def edges_count(self) -> int:
        return self.graph.number_of_edges()

    # --- query (cognee-style / graph-RAG) ------------------------------------
    @timed("KnowledgeGraph.query")
    def query(self, question: str, top_k: int = 8) -> dict:
        if not self.graph.number_of_nodes():
            return {"answer": "No knowledge has been graphed yet.", "concepts": [], "edges": []}

        names = list(self.graph.nodes)
        if not self._concept_vectors:
            self._vectorize(names)
        qv = self.embedder.embed_one(question)
        pairs = [
            (name, self.embedder.cosine(self._concept_vectors.get(name, []), qv))
            for name in names
        ]
        ranked = sorted(pairs, key=lambda kv: -kv[1])[:top_k]
        top = [name for name, score in ranked if score > 0.15]

        evidence_lines, edge_refs = [], []
        for n in top:
            neighbors = set(self.graph.successors(n)) | set(self.graph.predecessors(n))
            for nb in neighbors:
                if nb in top and self.graph.has_edge(n, nb):
                    data = self.graph.get_edge_data(n, nb)
                    edge_refs.append(
                        {"source": n, "target": nb, "edge": list(data.values()) if data else []}
                    )
            evidence_lines.append(f"- {n}")

        if not top:
            return {
                "answer": "No closely matching concepts found in the knowledge graph.",
                "concepts": [],
                "edges": [],
            }

        evidence = "\n".join(evidence_lines)
        prompt = (
            f"QUESTION: {question}\n\nKNOWLEDGE GRAPH EVIDENCE (concepts related to the question):\n"
            f"{evidence}\n\nAnswer using only this evidence."
        )
        answer = self.agent.model(prompt, system_prompt=_ANSWER_SYSTEM)
        return {"answer": answer, "concepts": top, "edges": edge_refs}

    # --- helpers -------------------------------------------------------------
    @staticmethod
    def _chunk(text: str) -> list[str]:
        text = re.sub(r"\n{3,}", "\n\n", text or "")
        if len(text) <= _CHUNK_SIZE:
            return [text] if text.strip() else []
        chunks = []
        start = 0
        while start < len(text):
            end = min(start + _CHUNK_SIZE, len(text))
            if end < len(text):
                mid = text.rfind(" ", start + _CHUNK_SIZE // 2, end + 1)
                if mid != -1:
                    end = mid
            chunks.append(text[start:end].strip())
            start = max(end - _CHUNK_OVERLAP, start)
        return [c for c in chunks if c]
