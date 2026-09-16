"""SectionParser regression tests: markdown heading variants + TOC skipping.

Two markdown dialects must both parse into the same section tree:

* plain ``**CHAPTER ONE**`` / ``**1.1 ...**`` (old markitdown output)
* ``# **CHAPTER ONE**`` / ``## **1.1 ...**`` (new markitdown output)

The table of contents may sit *after* the abstract (new output) and its
page-numbered entries must not become sections.
"""

from quill_engine.models import count_words
from quill_engine.section_parser import parse

BOLD_DIALECT = """**ABSTRACT**

Abstract body text here.

**CHAPTER ONE**

1.1 BACKGROUND OF REPORT

Background paragraph.

**CHAPTER TWO**

2.1 ORIENTATION AND REGISTRATION WEEK

Week one content.
"""

HASH_DIALECT = """# **ABSTRACT**

Abstract body text here.

# TABLE OF CONTENTS

CERTIFICATION 2

CHAPTER ONE – INTRODUCTION 14

1.1 BACKGROUND OF REPORT 14

CHAPTER TWO 33

2.1 ORIENTATION AND REGISTRATION WEEK 33

REFERENCES 151

# **CHAPTER ONE – INTRODUCTION**

## **1.1 BACKGROUND OF REPORT**

Background paragraph.

# CHAPTER TWO

## 2.1 ORIENTATION AND REGISTRATION WEEK

Week one content.
"""


def _tree(markdown: str):
    sections = parse(markdown)
    for section in sections:
        count_words(section)
    return sections


def test_bold_dialect_parses_chapters_and_subsections():
    sections = _tree(BOLD_DIALECT)
    assert [s.title for s in sections] == ["ABSTRACT", "CHAPTER ONE", "CHAPTER TWO"]
    assert [c.title for c in sections[1].children] == ["1.1 BACKGROUND OF REPORT"]


def test_hash_dialect_parses_same_tree():
    sections = _tree(HASH_DIALECT)
    assert [s.title for s in sections] == [
        "ABSTRACT",
        "CHAPTER ONE: – INTRODUCTION",
        "CHAPTER TWO",
    ]
    assert [c.title for c in sections[1].children] == ["1.1 BACKGROUND OF REPORT"]


def test_toc_entries_with_page_numbers_are_skipped():
    sections = _tree(HASH_DIALECT)
    titles = [c.title for s in sections for c in s.children]
    assert titles == ["1.1 BACKGROUND OF REPORT", "2.1 ORIENTATION AND REGISTRATION WEEK"]
    assert not any("14" in t or "33" in t for t in titles)


def test_content_lands_in_correct_section():
    sections = _tree(HASH_DIALECT)
    chapter_two = sections[2]
    assert chapter_two.word_count > 0
    assert [c.word_count for c in chapter_two.children] == [3]


def test_plain_toc_entries_do_not_become_chapters():
    markdown = """# TABLE OF CONTENTS

CHAPTER ONE – INTRODUCTION 14

1.1 BACKGROUND OF REPORT 14

# **CHAPTER ONE – INTRODUCTION**

## **1.1 BACKGROUND OF REPORT**

Body text.
"""
    sections = _tree(markdown)
    assert len(sections) == 1
    assert sections[0].title == "CHAPTER ONE: – INTRODUCTION"


def test_numbered_sentence_list_items_are_not_headings():
    markdown = """# CHAPTER ONE

## 2.4 PAINT PRODUCTION PROCESS

1. Train students on **proper surface preparation techniques** before painting.
2. Expose participants to different painting tools and methods of application.
"""
    sections = _tree(markdown)
    paint = sections[0].children[0]
    assert [c.title for c in paint.children] == []
    body = " ".join(u.text for u in paint.content)
    assert "Train students" in body
    assert "Expose participants" in body


def test_bold_noun_phrase_list_items_are_not_headings():
    markdown = """# CHAPTER TWO

### 2.9.3 MAIN COMPONENTS OF THE LATHE MACHINE

1. **Headstock (Gear Head)**
   The headstock is located on the left-hand side of the lathe.
2. **Bed**
   The bed provides the foundation for the entire machine.
"""
    sections = _tree(markdown)
    lathe = sections[0].children[0]
    assert [c.title for c in lathe.children] == []
    body = " ".join(u.text for u in lathe.content)
    assert "Headstock" in body
    assert "Bed" in body


def test_bold_allcaps_numbered_heading_still_parses():
    markdown = """**CHAPTER ONE**

1. **WHY IS SWEP NECESSARY?**

SWEP is necessary for practical exposure.
"""
    sections = _tree(markdown)
    assert sections[0].title == "CHAPTER ONE"
    assert [c.title for c in sections[0].children] == ["1. WHY IS SWEP NECESSARY?"]
    assert sections[0].children[0].word_count == 6


def test_heading_depth_nests_subsections():
    markdown = """# CHAPTER TWO

## 2.5 TRANSITION TO INTERLOCKING TILES AND GROUNDWORK

### 2.5.3 STEP-BY-STEP PRODUCTION PROCESS

#### 2. Mixing of Materials

Mixing was done in batches of fifty kilograms.

### 2.5.4 GROUND PREPARATION AND LEVELLING
"""
    sections = _tree(markdown)
    chapter = sections[0]
    transit = chapter.children[0]
    assert transit.title == "2.5 TRANSITION TO INTERLOCKING TILES AND GROUNDWORK"
    assert transit.level == 2
    assert [c.title for c in transit.children] == [
        "2.5.3 STEP-BY-STEP PRODUCTION PROCESS",
        "2.5.4 GROUND PREPARATION AND LEVELLING",
    ]
    mixing = transit.children[0].children[0]
    assert mixing.title == "2. Mixing of Materials"
    assert mixing.level == 4
    assert mixing.parent_id == transit.children[0].section_id
    assert mixing.word_count == 8


def test_structure_only_keeps_tree_and_drops_body():
    sections = parse(HASH_DIALECT, include_content=False)
    for section in sections:
        count_words(section)
    assert [s.title for s in sections] == [
        "ABSTRACT",
        "CHAPTER ONE: – INTRODUCTION",
        "CHAPTER TWO",
    ]
    assert [c.title for c in sections[1].children] == ["1.1 BACKGROUND OF REPORT"]
    assert [c.title for c in sections[2].children] == ["2.1 ORIENTATION AND REGISTRATION WEEK"]
    assert sections[0].word_count == 0
    assert sections[0].content == []
    assert sections[1].children[0].content == []
    assert sections[1].children[0].word_count == 0
    assert sections[2].description == ""
