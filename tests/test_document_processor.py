"""DocumentProcessor tests: plain-text files bypass MarkItDown entirely.

The PlainTextConverter decodes bytes with the locale charset (ASCII on
many systems) and dies on non-ASCII bytes like U+00E2 — regression test
for the ``UnicodeDecodeError`` fix.
"""

from quill_engine import document_processor


def test_text_file_reads_as_utf8(tmp_path):
    path = tmp_path / "notes.txt"
    path.write_bytes("Résumé — safety training with the dépôt supervisor.\n".encode("utf-8"))
    doc = document_processor.process(str(path))
    assert "Résumé" in doc.markdown_text
    assert "dépôt" in doc.markdown_text


def test_markdown_file_reads_as_utf8(tmp_path):
    path = tmp_path / "annex.md"
    path.write_bytes("# Café Log\n\nObserved 0xE2 bytes: é, €, —\n".encode("utf-8"))
    doc = document_processor.process(str(path))
    assert "Café" in doc.markdown_text
    assert "€" in doc.markdown_text


def test_text_file_does_not_touch_markitdown(tmp_path, monkeypatch):
    path = tmp_path / "plain.txt"
    path.write_text("Plain ASCII text for the bypass check.\n", encoding="utf-8")

    def fail(*args, **kwargs):
        raise AssertionError("MarkItDown must not be constructed for text files")

    monkeypatch.setattr(document_processor, "MarkItDown", fail)
    doc = document_processor.process(str(path))
    assert "Plain ASCII text" in doc.markdown_text


def test_unsupported_extension_rejected(tmp_path):
    path = tmp_path / "data.bin"
    path.write_bytes(b"\x00\x01\x02")
    try:
        document_processor.process(str(path))
    except document_processor.DocumentProcessingError as exc:
        assert "unsupported extension" in str(exc)
    else:
        raise AssertionError("expected DocumentProcessingError")
