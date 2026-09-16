"""Unit tests for the Cleaner (quill_engine.cleaner)."""

import pytest

from quill_engine import cleaner


class TestBoilerplateRemoval:
    def test_bls_nav_menu_is_stripped(self):
        bls = """\
Nuclear Engineers : Occupational Outlook Handbook: : U.S. Bureau of Labor Statistics

PRINTER-FRIENDLY
- Summary
- What They Do
- Work Environment
- How to Become One
- Pay
- Job Outlook
- State & Area Data
- Similar Occupations
- More Information

Nuclear engineers research and develop the processes, instruments, and systems used to derive benefits from nuclear energy and radiation.
"""
        out = cleaner.clean(bls)
        assert "PRINTER-FRIENDLY" not in out
        assert "- Summary" not in out
        assert "- What They Do" not in out
        assert "Job Outlook" not in out
        assert "Occupational Outlook Handbook" not in out
        assert "Nuclear engineers research and develop" in out

    def test_isbn_doi_and_copyright_removed(self):
        sample = """\
ISBN 978-92-64-32741-2
DOI: 10.1787/9789264327412-en

© OECD 2021

Copyright 2020 International Atomic Energy Agency
Photo credits: Cover © Juan Doe / Shutterstock

Nuclear safety relies on robust regulatory frameworks.
"""
        out = cleaner.clean(sample)
        assert "ISBN" not in out
        assert "DOI" not in out
        assert "OECD" not in out
        assert "Copyright" not in out
        assert "Photo credits" not in out
        assert "Nuclear safety relies" in out

    def test_citation_block_removed(self):
        sample = """\
Please cite this publication as: OECD (2021), The Future of Work, OECD Publishing, Paris.
This line is part of the citation and must go too.

The real content starts here.
"""
        out = cleaner.clean(sample)
        assert "Please cite" not in out
        assert "OECD Publishing" not in out
        assert "The real content starts here" in out

    def test_urls_and_retrieval_ids_scrubbed(self):
        sample = """\
Source: https://www.bls.gov/ooh/architecture-and-engineering/nuclear-engineers.htm
The reactor design sec_8762b3f1a4c9d was inspected on chk_9f1e2d3c4b5a.
Visit www.example.org for details.
"""
        out = cleaner.clean(sample)
        assert "https://" not in out
        assert "www." not in out
        assert "Source:" not in out
        assert "sec_8762b3f1a4c9d" not in out
        assert "chk_9f1e2d3c4b5a" not in out
        assert "reactor design" in out
        assert "inspected" in out
        assert "for details" in out

    def test_page_counter_removed(self):
        out = cleaner.clean("Page 3 of 12\n\nContent line here.")
        assert "Page 3 of 12" not in out
        assert "Content line here" in out

    def test_nav_phrases_removed(self):
        out = cleaner.clean(
            "Skip to content\nRelated Topics\nWas this page helpful?\n\nProse survives."
        )
        assert "Skip to content" not in out
        assert "Related Topics" not in out
        assert "Was this page helpful?" not in out
        assert "Prose survives" in out


class TestProsePreservation:
    def test_sentences_with_punctuation_kept(self):
        text = (
            "This is a sentence with commas, and another, longer clause; "
            "it must survive. Equipment used: lathe, mill, drill press."
        )
        assert cleaner.clean(text) == text

    def test_markdown_table_kept(self):
        table = """\
| Equipment | Status |
| --------- | ------ |
| Lathe     | OK     |
| Mill      | OK     |
"""
        out = cleaner.clean(table)
        assert "| Equipment | Status |" in out
        assert "| Lathe | OK |" in out
        assert "| Mill | OK |" in out

    def test_bullet_content_with_punctuation_kept(self):
        out = cleaner.clean("- Calibrated the dosimeter on Monday, 3 March.")
        assert "Calibrated the dosimeter" in out

    def test_tagged_supplement_line_survives(self):
        text = "[WEB - Nuclear Safety (https://x.org) - not personal evidence]\nThe prose follows."
        out = cleaner.clean(text)
        assert "not personal evidence" in out
        assert "The prose follows" in out


class TestEdgeCases:
    def test_empty_input(self):
        assert cleaner.clean("") == ""
        assert cleaner.clean(None) is None

    def test_blank_runs_collapsed(self):
        out = cleaner.clean("a\n\n\n\nb")
        assert "a\n\nb" == out

    def test_real_word_with_underscore_prefix_survives(self):
        out = cleaner.clean("web_search is a common term; sec_short is not an id.")
        assert "web_search" in out

    def test_pure_boilerplate_becomes_empty(self):
        assert cleaner.clean("PRINTER-FRIENDLY\n- Summary\nISBN 978-92-64-32741-2") == ""
