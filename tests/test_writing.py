import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from components.writingEngine import WritingEngine


class _FakeEmbedder:
    def embed_one(self, text):
        return None

    def similarity(self, a, b):
        return 0.0


def _engine():
    eng = WritingEngine.__new__(WritingEngine)
    eng.embedder = _FakeEmbedder()
    eng.dedup_threshold = 0.94
    eng.run_retries = 0
    eng.last_gate = {}
    return eng


def _check(results, name, cond, detail=""):
    results.append(cond)
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else f"   [{detail}]"))


def main() -> int:
    results: list[bool] = []
    eng = _engine()

    placeholder = eng._placeholder(
        "Section", 10, 1, 0.5,
        reason="no research source is close to this section "
               "(relevance 0.542 < 0.55)",
    )
    _check(
        results, "placeholder keeps 'No claim' on its own line",
        "0.55).\n> No claim is made here." in placeholder,
        repr(placeholder),
    )
    _check(
        results, "placeholder has no inline '> >' glue",
        ") > No claim" not in placeholder,
        repr(placeholder),
    )

    doc = f"# 1.2 Strategic location\n\n{placeholder}"
    deduped = eng.dedupe(doc)
    _check(
        results, "dedupe() preserves placeholder line break",
        "0.55).\n> No claim is made here." in deduped,
        repr(deduped),
    )
    _check(
        results, "dedupe() keeps the heading",
        "# 1.2 Strategic location" in deduped,
        repr(deduped),
    )

    block = "> line one. still one line.\n> second blockquote line."
    _check(
        results, "_drop_repeated_sentences preserves newlines",
        "\n" in eng._drop_repeated_sentences(block, set()),
        repr(eng._drop_repeated_sentences(block, set())),
    )
    repeated = (
        "The stadium fell into disuse after the fifth century. "
        "The stadium fell into disuse after the fifth century."
    )
    _check(
        results, "_drop_repeated_sentences dedupes 5+ word sentences",
        eng._drop_repeated_sentences(repeated, set()).count("The stadium fell into disuse") == 1,
        repr(eng._drop_repeated_sentences(repeated, set())),
    )
    _check(
        results, "_drop_repeated_sentences leaves short sentences alone",
        eng._drop_repeated_sentences("Repeated line. Repeated line.", set()) == "Repeated line. Repeated line.",
        repr(eng._drop_repeated_sentences("Repeated line. Repeated line.", set())),
    )

    meta = (
        "> In this document we will explore the site. The ruins remain visible.\n"
        "> A second line of surviving content."
    )
    cleaned = eng._strip_meta(meta)
    _check(
        results, "_strip_meta preserves newlines when lines survive",
        "\n" in cleaned,
        repr(cleaned),
    )
    _check(
        results, "_strip_meta still drops meta sentence",
        "explore the site" not in cleaned,
        repr(cleaned),
    )

    _check(
        results, "MIN_SECTION_SUPPORT defaults to 0.4",
        WritingEngine.MIN_SECTION_SUPPORT == 0.4,
        str(WritingEngine.MIN_SECTION_SUPPORT),
    )

    probe = (
        "import os, sys; sys.path.insert(0, os.getcwd());"
        "from components.writingEngine import WritingEngine;"
        "print(WritingEngine.MIN_SECTION_SUPPORT)"
    )
    proc = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True, text=True, env={**os.environ, "QUILL_MIN_SECTION_SUPPORT": "0.5"},
    )
    _check(
        results, "QUILL_MIN_SECTION_SUPPORT overrides threshold",
        proc.stdout.strip() == "0.5",
        f"stdout={proc.stdout!r} stderr={proc.stderr[-400:]!r}",
    )

    plan = {
        "sections": [
            {"title": "Introduction", "claim": ""},
            {"title": "Rome and the Forum", "claim": "The structure stood inside the forum."},
            {"title": "Flavian program", "claim": "The structure stood inside the forum."},
        ]
    }
    nodes = eng._outline(plan)
    _check(
        results, "_outline fills empty claims",
        all(claim.strip() for _, _, claim in nodes),
        repr(nodes),
    )
    _check(
        results, "_outline claims are unique",
        len({eng._normalise(c) for _, _, c in nodes}) == len(nodes),
        repr(nodes),
    )
    _check(
        results, "_outline keeps titles and levels",
        [t for _, t, _ in nodes] == ["Introduction", "Rome and the Forum", "Flavian program"],
        repr(nodes),
    )

    default_nodes = eng._outline({}, "the Colosseum")
    _check(
        results, "_outline default path still yields distinct claims",
        len({eng._normalise(c) for _, _, c in default_nodes}) == len(default_nodes)
        and all(c.strip() for _, _, c in default_nodes),
        repr(default_nodes),
    )

    double = [(1, "", "Same claim."), (1, "", "Same claim.")]
    resolved = eng._with_distinct_claims(double)
    _check(
        results, "_with_distinct_claims resolves title-less duplicates",
        len({eng._normalise(c) for _, _, c in resolved}) == 2,
        repr(resolved),
    )

    ph_a = eng._placeholder("Section A", 10, 1, 0.5)
    ph_b = eng._placeholder("Section A", 10, 1, 0.5)
    multi = f"# One\n\n{ph_a}\n\n# Two\n\n{ph_b}"
    _check(
        results, "dedupe keeps identical placeholders in every section",
        eng.dedupe(multi).count("INSUFFICIENT EVIDENCE") == 2,
        repr(eng.dedupe(multi)),
    )
    _check(
        results, "dedupe still drops repeated real sentences",
        eng.dedupe(
            "# H\n\nThe stadium fell into disuse. The stadium fell into disuse."
        ).count("fell into disuse") == 1,
        repr(eng.dedupe("# H\n\nThe stadium fell into disuse. The stadium fell into disuse.")),
    )

    # Grounding can empty a section AFTER coherence passed it. Section 3.1 of
    # the 2026-10-12 run scored coherent at 254 words, all 18 claims were
    # unverified, and strip_unverified left the 7-word remnant "Law No. The
    # permit referenced Law No." - which body.strip() published as a finished
    # section. The body must be re-scored after stripping.
    import components.writingEngine as _we

    _real_score, _real_strip = _we.score_text, _we.strip_unverified

    def _score_strips_to_remnant(text, template=""):
        return _real_score(text, template=template) if text.strip() != "SENTINEL" else {
            "words": 254, "verdict": "coherent", "ttr": 0.551, "top_share": 0.12,
            "refusal": False, "echo": 0.0, "chrome": 0.0, "symbol_noise": 0,
        }

    _we.score_text = _score_strips_to_remnant
    _we.strip_unverified = lambda body, unv: ("Law No. The permit referenced Law No.", 18)
    _we.verify = lambda claims, corpus, profile: {
        "total": len(claims), "corroborated": [], "unverified": list(claims) or ["x"],
        "escalate": False, "authority_suspects": 1, "precision_suspects": 0,
    }
    _we.extract_claims = lambda body, profile: ["claim"] * 18
    try:
        eng2 = _engine()
        eng2._write_body = lambda *a, **k: "SENTINEL"
        eng2._unverified = lambda *a, **k: ["c"] * 18
        got, gotscore = eng2._write_verified(
            "ctx\n\nRESEARCH: some corpus text here", "3.1 Title", "claim", [], "", {},
        )
        remnant = "Law No. The permit referenced Law No."
        _check(
            results, "grounding remnant is not published as a written section",
            got.strip() == "" and got.strip() != remnant,
            f"{got!r} {gotscore.get('verdict')}",
        )
    finally:
        _we.score_text, _we.strip_unverified = _real_score, _real_strip
        import importlib
        importlib.reload(_we)

    passed = sum(results)
    print(f"\n{'ALL PASS' if passed == len(results) else 'FAILURES'}: {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
