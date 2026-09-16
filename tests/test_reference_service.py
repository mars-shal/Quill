"""ReferenceService tests: @-mention expansion in prompts."""

from quill_engine.reference_service import expand_references


def test_mention_resolved_to_file_content(tmp_path):
    notes = tmp_path / "annex.md"
    notes.write_text("# Annex\n\nFull calibration data for the lathe.\n", encoding="utf-8")
    clean, refs = expand_references(f"rewrite week two using @{notes}")
    assert clean == "rewrite week two using "
    assert len(refs) == 1
    label, text = refs[0]
    assert label == str(notes)
    assert "calibration data" in text


def test_multiple_mentions_all_resolved(tmp_path):
    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    a.write_text("content a", encoding="utf-8")
    b.write_text("content b", encoding="utf-8")
    clean, refs = expand_references(f"@{a} and @{b} please")
    assert clean == " and  please"
    assert [label for label, _ in refs] == [str(a), str(b)]


def test_directory_mention_lists_entries(tmp_path):
    sub = tmp_path / "data"
    sub.mkdir()
    (sub / "log.txt").write_text("x", encoding="utf-8")
    (sub / "report.md").write_text("y", encoding="utf-8")
    clean, refs = expand_references(f"check @{sub} for context")
    assert clean == "check  for context"
    assert len(refs) == 1
    assert "log.txt" in refs[0][1]
    assert "report.md" in refs[0][1]


def test_unresolved_mention_left_in_prompt():
    clean, refs = expand_references("use @no/such/file.md please")
    assert refs == []
    assert clean == "use @no/such/file.md please"


def test_no_mentions_returns_prompt_unchanged():
    clean, refs = expand_references("rewrite the introduction")
    assert clean == "rewrite the introduction"
    assert refs == []


def test_trailing_punctuation_stripped(tmp_path):
    notes = tmp_path / "annex.md"
    notes.write_text("content", encoding="utf-8")
    clean, refs = expand_references(f"see @{notes}.")
    assert [label for label, _ in refs] == [str(notes)]
    assert clean == "see ."
