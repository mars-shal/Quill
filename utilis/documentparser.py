# DocumentParser – Hierarchical Document Tree Parser (Regex + LLM)
from utilis.timing import timed
import hashlib
import json
import os
import re
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Literal, Optional

from markitdown import MarkItDown
from openai import APIError, OpenAI
from pydantic import BaseModel, ValidationError

from utilis.store import SqliteDatabase

try:
    import json_repair
except ImportError:  # pragma: no cover - optional recovery dependency
    json_repair = None


# ----------------------------------------------------------------------
# Pydantic schemas (Document Structure Validation)
# ----------------------------------------------------------------------
class ContentBlock(BaseModel):
    type: Literal[
        "paragraph", "table", "figure", "bullets", "numbered_list", "code", "diagram", "quote"
    ]
    content: str  # Verbatim or formatted representation
    metadata: Dict[str, Any] = {}  # table cells, figure number/caption, code language, etc.


class DocumentSection(BaseModel):
    level: int  # 1 for CHAPTER, 2 for 2.1, 3 for 2.1.1, 4 for bold subsections
    no: Optional[str] = None  # Valid decimal or chapter number ("1", "2.1", "3.3.1")
    title: str  # Section heading text cleaned of page numbers and markdown wrappers
    blocks: List[ContentBlock] = []  # Content blocks belonging to this section
    children: List["DocumentSection"] = []  # Nested subsections


# Resolve forward references for recursive DocumentSection validation
DocumentSection.model_rebuild()


class ParsedDocument(BaseModel):
    unique_id: str
    title: str
    subtitle: Optional[str] = None
    sections: List[DocumentSection] = []


# ----------------------------------------------------------------------
# Compiled regexes for layout hierarchy signals
# ----------------------------------------------------------------------
DEC = re.compile(
    r"^(?P<no>\d+(?:\.\d+)+)[\s.)]+\s*(?P<t>\S.*)$"
)  # "2.3.1 Section Heading"
CHAP = re.compile(
    r"^(?:CHAPTER|PART|APPENDIX)\b[\s:—-]*(?P<no>\d+|[IVXLCDM]+)?[\s:—-]*(?P<t>.*)$",
    re.I,
)  # "CHAPTER 1: INTRODUCTION"
APPENDIX_RE = re.compile(r"^APPENDIX\b[\s:—-]*([A-Z])?[\s:—-]*(?P<t>.*)$", re.I)
ROMAN_CHAP = re.compile(r"^M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$")
BOLD = re.compile(r"^\*\*([^*]{2,120})\*\*:?\s*$")  # "**3.5 Section Heading**"
BUL = re.compile(r"^[\*\-•]\s+")
NUM = re.compile(r"^\d{1,3}[.)]\s+\S")
KEYWORDS = re.compile(
    r"^(section|subject|chapter|part|unit|module|class|duration|instruction)\b", re.I
)
ESCAPE = re.compile(
    r"\\([_*#\[\]()\\`+=\-<>|.,;:!?/])"
)  # Converter escaped punctuation
IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
TABLE_SEP = re.compile(r"^\|[\s\-:|]+\|$")
FIG_CAPTION = re.compile(r"^(?:Figure|Fig\.?)\s*(\d+)[\s:—.-]+(.+)$", re.I)
PAGE_NUM_TRAIL = re.compile(r"\s+\b\d{1,4}\s*$")
# ----- code-island detection (source is often fence-less escaped C/C++) -----
CODE_PREPROC = re.compile(
    r"^#\s*(?:define|include|if|ifdef|ifndef|elif|else|endif|pragma|undef)\b", re.I
)
CODE_DECL = re.compile(
    r"^(?:int|void|char|float|double|unsigned|long|short|const|static|enum|struct|typedef|bool|byte|word)\b",
    re.I,
)
CODE_DEFINE = re.compile(
    r"^define\s+(?:[A-Z][A-Z0-9_]*|\w+\s*\()|^include\s*[<\"']", re.I
)  # converter strips '#' from #define/#include
CODE_CALL = re.compile(
    r"^\s*(?:Serial\.|pinMode|digitalRead|digitalWrite|analogRead|analogWrite|millis\(|delay\(|sizeof\(|return|break|continue)\b"
)
CODE_IDENT = re.compile(r"^[A-Z][A-Z0-9_]*,?\s*$")  # bare uppercase identifiers e.g. ERROR_STATE,


# ----------------------------------------------------------------------
class DocumentParser:
    _SYSTEM_PROMPT = (
        "You are a structural document reconstruction agent. Rebuild the internal "
        "hierarchy (blocks and subsections) of unformatted or partially formatted document "
        "fragments. Preserve all text VERBATIM: never paraphrase, summarize, or omit any "
        "content, including code, tables, and paragraphs. Reply with ONLY a valid JSON object "
        "matching the requested schema - no markdown code fences, no prose, no schema echo."
    )

    _COMPACT_TEMPLATE = """Group the blocks below into logical subsections of '{parent_title}'.
This is part {chunk_idx} of {chunk_total}. Each block is listed as [index] (type) short stem (approximate length) -- ONLY the stem is shown, not the full text.

--- BLOCKS ---
{body}
---

Return ONLY valid JSON in this exact shape:
{{
    "children": [
        {{
            "title": "Subsection heading",
            "block_indices": [0, 2, 3]
        }}
    ]
}}

RULES:
- "block_indices" may reference ONLY indices that exist in the list above.
- Group consecutive blocks covering the same topic; you MAY return an empty "children" list if the blocks form one cohesive section.
- Choose headings that genuinely reflect the material; never invent numbered section numbers.
- Blocks you do not assign to any child stay at the parent level automatically -- assign them only when a real subsection boundary exists.
- Respond with ONLY the JSON object; no prose, no fences, no block content.
"""

    def __init__(self, llm_restructuring: bool = True,
                 conservative_headings: bool | None = None,
                 provider: dict | None = None):
        print("[INIT] Initialising DocumentParser...")
        if conservative_headings is not None:
            self.CONSERVATIVE_HEADINGS = conservative_headings
        # When False the parser is purely deterministic: no LLM repair pass.
        self.llm_restructuring = llm_restructuring
        # The same provider the run uses, not a second one read from the
        # environment. Two clients built from two sources is how a document gets
        # restructured by a different model than the one being credited for it --
        # and it was invisible, because both calls succeeded.
        cfg = provider or {}
        self._openai = OpenAI(
            api_key=cfg.get("api_key") or os.getenv("OPENAI_API_KEY"),
            base_url=cfg.get("base_url") or os.getenv("OPENAI_BASE_URL") or None,
        )
        # Resolved once and kept, so the repair call below asks for the same model
        # this client was built for. Reading the environment again per request let
        # a run that had selected its own model repair its document with whatever
        # `LLM_MODEL` happened to say -- or with `allam-2-7b`, another vendor's
        # model, when it said nothing at all.
        self._llm_model = cfg.get("model") or os.getenv("LLM_MODEL") or "allam-2-7b"
        self._markitdown = MarkItDown(
            enable_builtins=True,
            enable_plugins=True,
            llm_client=self._openai,
            llm_model=self._llm_model,
        )
        self._db = SqliteDatabase()
        self._rate_q: deque = deque()
        self._pace_lock = threading.Lock()
        print("[INIT] DocumentParser dependencies loaded.")

    def _extract_title(self, path: str, markdown: str = "") -> str:
        if markdown:
            for line in markdown.splitlines()[:25]:
                s = line.strip()
                if not s or s.startswith("```") or s.startswith("|") or s.startswith("[IMG]"):
                    continue
                if s.startswith("#"):
                    cleaned = s.lstrip("#").strip("* ").strip()
                    if cleaned:
                        return self._clean_title_string(cleaned, strip_trailing_number=False)
                letters = re.sub(r"[^A-Za-z]", "", s)
                if letters.isupper() and 3 < len(letters) < 90 and not self._match_chapter(s)[2]:
                    return self._clean_title_string(s, strip_trailing_number=False)

        base = os.path.basename(path)
        name, _ = os.path.splitext(base)
        cleaned = re.sub(r"[\-_]+", " ", name)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned or "Untitled Document"

    def _clean_title_string(self, s: str, strip_trailing_number: bool = False) -> str:
        s = s.strip()
        s = re.sub(r"^#+\s*", "", s)
        s = re.sub(r"^\*+|\*+$", "", s).strip()
        if strip_trailing_number:
            s = PAGE_NUM_TRAIL.sub("", s).strip()
        return s

    # --------------------------------------------------------------
    # Normalisation & Line Classification
    # --------------------------------------------------------------
    def _is_code_line(self, line: str, active: bool = False) -> bool:
        """True when a line looks like source code (comment, decl, call, brace, assignment)."""
        s = line.strip()
        if not s:
            return False
        if s.startswith("//"):
            return True
        if CODE_PREPROC.match(s):
            return True
        if CODE_DECL.match(s):
            return True
        if CODE_DEFINE.match(s):
            return True
        if CODE_CALL.match(s):
            return True
        if re.search(r"[{}]\s*$", s):
            return True
        if active:
            if ";" in s or ("(" in s and ")" in s):
                return True
            if CODE_IDENT.match(s):
                return True
            if " = " in s or "->" in s or "::" in s:
                return True
        return False

    def _wrap_code_islands(self, lines: List[str]) -> List[str]:
        """Wraps fence-less code runs into ```cpp blocks so downstream parsing
        treats them as one verbatim `code` block instead of fake headings.

        Existing ``` markers are copied verbatim and treated as barriers: islands
        are never detected inside them and never cross them, so every opener this
        pass emits is guaranteed exactly one closer.
        """
        out: List[str] = []
        i, n = 0, len(lines)
        in_fence = False
        while i < n:
            s = lines[i].strip()
            if s.startswith("```"):
                out.append(lines[i])
                in_fence = not in_fence
                i += 1
                continue
            if in_fence:
                out.append(lines[i])
                i += 1
                continue
            if not self._is_code_line(lines[i]):
                out.append(lines[i])
                i += 1
                continue

            island, j, pending_blank = [lines[i]], i + 1, []
            while j < n:
                lj = lines[j]
                ls = lj.strip()
                if not ls:
                    pending_blank.append(lj)
                    j += 1
                    continue
                if ls.startswith("```"):  # do not span an existing fence
                    break
                if self._is_code_line(lj, active=True):
                    island.extend(pending_blank)
                    island.append(lj)
                    pending_blank = []
                    j += 1
                    continue
                break  # non-code non-blank prose terminates the island
            code_count = sum(
                1 for x in island if x.strip() and self._is_code_line(x, active=True)
            )
            if code_count >= 3:
                out.append("```cpp")
                out.extend(x.strip() for x in island)
                out.append("```")
            else:
                out.extend(island)
            i = j
        return out

    def _normalise(self, text: str) -> str:
        print("[NORM] Normalising document markdown (fence-aware, clean escapes)...")
        out, in_code = [], False
        for line in text.replace("\u00a0", " ").splitlines():
            if not in_code:
                line = IMAGE.sub("[IMG]", line)
            line = ESCAPE.sub(r"\1", line)  # restore converter escapes
            m = re.match(r"^\s*`{3,}(\w*)\s*$", line)
            if m:
                in_code = not in_code
                line = "```" + m.group(1)
            out.append(line.rstrip())

        wrapped = self._wrap_code_islands(out)

        paras = "\n\n".join(wrapped).split("\n\n")
        keep, prev = [], None
        for p in paras:
            h = hashlib.md5(" ".join(p.split()).lower().encode()).hexdigest()
            if h != prev:
                keep.append(p)
                prev = h
        print(f"[NORM] Normalisation done. Paragraphs: {len(paras)} -> {len(keep)}")
        return "\n\n".join(keep)

    def _match_chapter(self, s: str):
        """Returns (no, title, matched) for CHAPTER/PART/APPENDIX headings.

        Appendix letters (A..H) are captured as `no`; roman numerals are only
        accepted when they are valid and unambiguous (never single C/D/L/M,
        which are appendix labels / misreads).
        """
        if re.match(r"APPENDIX\b", s, re.I):
            m = APPENDIX_RE.match(s)
            if m:
                return m.group(1), (m.group("t") or "").strip(), True
            return None, None, False
        m = CHAP.match(s)
        if not m:
            return None, None, False
        no = m.group("no")
        t = (m.group("t") or "").strip()
        if no is not None and not no.isdigit():
            if len(no) == 1:
                if no.upper() not in "IVX":
                    no = None
            elif not ROMAN_CHAP.match(no):
                no = None
        return no, t, True

    def _classify_line(self, line: str, prev_blank: bool, suppress_plain: bool = False) -> dict:
        s = line.strip()
        if not s:
            return {"type": "blank", "val": None}
        if s.startswith("```"):
            return {"type": "fence", "val": s}
        if s.startswith("|"):
            return {"type": "table", "val": s}
        # Code/comment lines must never become headings
        if s.startswith("//") or CODE_PREPROC.match(s):
            return {"type": "body", "val": s}

        # Check explicit markdown headings first (# Heading)
        if s.startswith("#") and prev_blank:
            level = min(len(s) - len(s.lstrip("#")), 6)
            text_part = s.lstrip("#").strip()
            # Strip bold wrappers before matching to prevent missing numbers like ## ****2.2 SWEP SCHEDULE****
            match_target = re.sub(r"^\*+", "", text_part)
            match_target = re.sub(r"\*+$", "", match_target).strip()

            # A converter can wrap C preprocessor lines in a heading, e.g.
            # "# **define SENSOR_PIN A0**". The outer code check above runs
            # before the bold markers are stripped, so re-check here.
            if CODE_PREPROC.match(match_target) or "//" in match_target:
                return {"type": "body", "val": s, "candidate": "code_heading"}

            m_dec = DEC.match(match_target)
            if m_dec:
                return {
                    "type": "h?",
                    "level": level,
                    "no": m_dec.group("no"),
                    "val": self._clean_title_string(m_dec.group("t"), strip_trailing_number=True),
                }
            m_chap_no, m_chap_title, m_chap = self._match_chapter(match_target)
            if m_chap:
                return {
                    "type": "h1?",
                    "level": 1,
                    "no": str(m_chap_no) if m_chap_no else None,
                    "val": self._clean_title_string(m_chap_title or match_target, strip_trailing_number=True),
                }
            return {
                "type": f"h{level}?",
                "level": level,
                "no": None,
                "val": self._clean_title_string(text_part, strip_trailing_number=False),
            }

        if suppress_plain:
            if BUL.match(s):
                return {"type": "bullets", "val": s}
            if NUM.match(s):
                return {"type": "numbered_list", "val": s}
            return {"type": "body", "val": s}

        m_chap_no, m_chap_title, m_chap = self._match_chapter(s)
        if m_chap and prev_blank:
            return {
                "type": "h1?",
                "level": 1,
                "no": str(m_chap_no) if m_chap_no else None,
                "val": self._clean_title_string(m_chap_title or s, strip_trailing_number=True),
            }

        m_dec = DEC.match(s)
        if m_dec and prev_blank:
            dec_no = m_dec.group("no")
            dec_level = len(dec_no.split("."))
            return {
                "type": "h?",
                "level": max(2, dec_level),
                "no": dec_no,
                "val": self._clean_title_string(m_dec.group("t"), strip_trailing_number=True),
            }

        m_bold = BOLD.match(s)
        if m_bold and prev_blank:
            if self.CONSERVATIVE_HEADINGS:
                # Plausible subheading, but indistinguishable from inline
                # emphasis. Kept as body text; surfaced as a candidate.
                return {"type": "body", "val": s, "candidate": "bold"}
            bold_text = m_bold.group(1).strip()
            return {
                "type": "h4?",
                "level": 4,
                "no": None,
                "val": self._clean_title_string(bold_text, strip_trailing_number=False),
            }

        letters = re.sub(r"[^A-Za-z]", "", s)
        if letters.isupper() and 3 < len(letters) < 90 and prev_blank:
            # Skip code/identifier false positives: ALLCAPS with comments,
            # bare uppercase tokens (ERROR_STATE, // UTILITY FUNCTIONS) or
            # ASCII/flow diagrams with brackets or arrows
            # ([PIR SENSOR] -> [MICROCONTROLLER] -> [ALARM OUTPUT]).
            if (
                " " not in s
                or "_" in s
                or "//" in s
                or "[" in s
                or "]" in s
                or any(c in s for c in "\u2192\u2190\u2191\u2193\u250c\u2510\u2514\u2518\u2500\u2502")
            ):
                return {"type": "body", "val": s}
            if self.CONSERVATIVE_HEADINGS:
                return {"type": "body", "val": s, "candidate": "allcaps"}
            return {
                "type": "h1?",
                "level": 1,
                "no": None,
                "val": self._clean_title_string(s, strip_trailing_number=False),
            }

        if BUL.match(s):
            return {"type": "bullets", "val": s}
        if NUM.match(s):
            return {"type": "numbered_list", "val": s}

        return {"type": "body", "val": s}

    # --------------------------------------------------------------
    # Table & Block Assembly Helpers
    # --------------------------------------------------------------
    def _parse_table_block(self, text: str) -> ContentBlock:
        raw_lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        header_cells: List[str] = []
        rows: List[List[str]] = []

        for idx, line in enumerate(raw_lines):
            if TABLE_SEP.match(line):
                continue
            # Strip outer pipes and split by |
            trimmed = line.strip("|")
            cells = [c.strip() for c in trimmed.split("|")]
            if not header_cells and idx == 0:
                header_cells = cells
            else:
                rows.append(cells)

        return ContentBlock(
            type="table",
            content=text,
            metadata={"headers": header_cells, "rows": rows},
        )

    def _assemble_blocks(self, text: str) -> List[ContentBlock]:
        blocks: List[ContentBlock] = []
        paragraphs = text.split("\n\n")
        in_code = False
        code_buf: List[str] = []
        code_lang = ""

        p_idx = 0
        while p_idx < len(paragraphs):
            p = paragraphs[p_idx]
            p_strip = p.strip()
            if not p_strip:
                p_idx += 1
                continue

            # Code fence handling
            if p_strip.startswith("```"):
                if in_code:
                    blocks.append(
                        ContentBlock(
                            type="code",
                            content="\n".join(code_buf),
                            metadata={"lang": code_lang},
                        )
                    )
                    code_buf, in_code = [], False
                else:
                    in_code = True
                    code_lang = p_strip[3:].strip()
                p_idx += 1
                continue

            if in_code:
                code_buf.append(p)
                p_idx += 1
                continue

            # Table handling: merge consecutive table rows across blank paragraph splits
            if p_strip.startswith("|"):
                table_lines = [p_strip]
                look = p_idx + 1
                while look < len(paragraphs):
                    next_p = paragraphs[look].strip()
                    if not next_p:
                        look += 1
                        continue
                    if next_p.startswith("|"):
                        table_lines.append(next_p)
                        p_idx = look
                        look += 1
                    else:
                        break
                blocks.append(self._parse_table_block("\n".join(table_lines)))
                p_idx += 1
                continue

            # Figure & Image Caption pairing: skip any blank paragraphs between [IMG] and "Figure N: ..."
            if p_strip == "[IMG]" or p_strip.startswith("[IMG]"):
                caption, fig_num = "", None
                look = p_idx + 1
                while look < len(paragraphs) and not paragraphs[look].strip():
                    look += 1
                if look < len(paragraphs):
                    next_p = paragraphs[look].strip()
                    m_fig = FIG_CAPTION.match(next_p)
                    if m_fig:
                        fig_num = int(m_fig.group(1))
                        caption = next_p
                        p_idx = look  # Consume paired caption paragraph
                blocks.append(
                    ContentBlock(
                        type="figure",
                        content=p_strip if not caption else f"[IMG]\n{caption}",
                        metadata={
                            "placeholder": True,
                            "figure_number": fig_num,
                            "caption": caption,
                        },
                    )
                )
                p_idx += 1
                continue

            if BUL.match(p_strip):
                blocks.append(ContentBlock(type="bullets", content=p_strip))
            elif NUM.match(p_strip):
                blocks.append(ContentBlock(type="numbered_list", content=p_strip))
            elif p_strip.startswith(">") or p_strip.startswith('"'):
                blocks.append(ContentBlock(type="quote", content=p_strip))
            else:
                blocks.append(ContentBlock(type="paragraph", content=p_strip))

            p_idx += 1

        return blocks

    # --------------------------------------------------------------
    # LLM-based structural refinement (cleanup pass)
    # --------------------------------------------------------------
    _FLAT_BLOCK_THRESHOLD = 6  # >= this many blocks with zero children -> candidate
    _MIN_CHARS_FOR_LLM = 400  # skip trivial nodes, not worth an API call

    # Conservative structure: only explicit "# " lines open a section. Fully
    # bold lines and ALLCAPS lines are plausible subheadings but are not
    # distinguishable from inline emphasis by regex, so they stay as body text
    # and are reported as candidates rather than silently becoming headings.
    # Measured on theisus.md: 146 bold + 10 ALLCAPS candidates vs 54 genuine
    # headings, so trusting the heuristics tripled the node count.
    CONSERVATIVE_HEADINGS = True
    _MAX_BLOCKS_FOR_LLM = 120  # per-chunk block cap (compact prompts are tiny)
    _MAX_CHARS_FOR_LLM = 22000  # per-chunk character cap (stems, not full text)
    _MAX_ATTEMPTS = 3  # single-shot + up to 2 feedback retries

    # ---- performance/cost knobs -----------------------------------------
    _PARSER_VERSION = 9  # bump when parse semantics change (invalidates caches)
    _COMPACT_STEM = 160  # chars of each block stem sent to the LLM
    _TPM_BUDGET = 6000  # provider token-per-minute tier (Groq allam-2-7b)
    _RATE_WINDOW = 60.0  # rolling window for the token pace limiter (seconds)
    _CACHE_KEY = "meta:parsecache"  # content-hash -> unique_id lookup table
    _LLM_WORKERS = 2  # parallel LLM calls (TPM-budgeted; more bursts into 429s)

    def _cache_key(self, norm_md: str) -> str:
        h = hashlib.sha1(norm_md.encode("utf-8", "surrogateescape")).hexdigest()
        return f"{self._PARSER_VERSION}:{h}"

    def _cache_get(self, norm_md: str) -> Optional[dict]:
        try:
            mapping = self._db.get(self._CACHE_KEY)
        except Exception:
            return None
        if not isinstance(mapping, dict):
            return None
        uid = mapping.get(self._cache_key(norm_md))
        if not uid:
            return None
        try:
            entry = self._db.get(uid)
        except Exception:
            return None
        return entry if isinstance(entry, dict) else None

    def _cache_put(self, doc_uuid: str, norm_md: str) -> None:
        try:
            mapping = self._db.get(self._CACHE_KEY)
        except Exception:
            mapping = {}
        if not isinstance(mapping, dict):
            mapping = {}
        mapping[self._cache_key(norm_md)] = doc_uuid
        self._db.set(self._CACHE_KEY, mapping)

    def _pace(self, tokens: int) -> None:
        """Sleeps just enough to keep rolling-60s token spend <= TPM budget,
        so requests pace smoothly under Groq's rate limit instead of bursting
        into 429 retries (each costing a fixed sleep anyway)."""
        if tokens <= 0:
            return
        with self._pace_lock:
            now = time.monotonic()
            self._rate_q = deque(
                (t, tk) for t, tk in self._rate_q if now - t < self._RATE_WINDOW
            )
            used = sum(tk for _, tk in self._rate_q)
            if used + tokens > self._TPM_BUDGET:
                need = max(0.0, (used + tokens - self._TPM_BUDGET) / (self._TPM_BUDGET / self._RATE_WINDOW))
                if need > 0.05:
                    time.sleep(need)
                    now = time.monotonic()
                    self._rate_q = deque(
                        (t, tk) for t, tk in self._rate_q if now - t < self._RATE_WINDOW
                    )
            self._rate_q.append((now, tokens))

    def _needs_restructuring(self, node: "DocumentSection") -> bool:
        if node.children:
            return False  # already has real structure below it
        if len(node.blocks) < self._FLAT_BLOCK_THRESHOLD:
            return False
        total_chars = sum(len(b.content) for b in node.blocks)
        if total_chars < self._MIN_CHARS_FOR_LLM:
            return False
        # Only worth restructuring if it's mostly undifferentiated prose --
        # a node that's already bullets/numbered_list/table doesn't need it.
        non_prose = sum(
            1
            for b in node.blocks
            if b.type in ("bullets", "numbered_list", "table", "code")
        )
        prose = sum(1 for b in node.blocks if b.type == "paragraph")
        return prose > 0 and prose >= non_prose

    def _blocks_to_verbatim(self, blocks: List["ContentBlock"]) -> str:
        parts = []
        for b in blocks:
            if b.type == "table":
                parts.append(b.content)
            elif b.type == "figure":
                parts.append(b.metadata.get("caption") or b.content)
            else:
                parts.append(b.content)
        return "\n\n".join(parts)

    def _extract_first_object(self, raw: str) -> Optional[str]:
        """Extracts the first balanced top-level {...} object, ignoring case-0
        braces inside strings and escape sequences. Tolerates prose fences."""
        start = raw.find("{")
        if start == -1:
            return None
        depth, in_str, esc = 0, False, False
        for i in range(start, len(raw)):
            ch = raw[i]
            if esc:
                esc = False
                continue
            if ch == "\\" and in_str:
                esc = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return raw[start : i + 1]
        return None

    def _extract_json(self, raw: str) -> Optional[dict]:
        raw = raw.strip()
        candidates = [raw]
        obj = self._extract_first_object(raw)
        if obj:
            candidates.append(obj)
        for cand in candidates:
            try:
                return json.loads(cand)
            except Exception:
                if json_repair is not None:
                    try:
                        return json_repair.loads(cand)
                    except Exception:
                        pass
        return None

    def _coerce_section(
        self,
        data: dict,
        parent_level: int,
        force: Optional[Dict[str, Any]] = None,
    ) -> dict:
        """Normalizes raw LLM output into a schema-valid section dict.
        With `force`, the tree's own level/no/title win over anything the model said
        (regex owns the node's position; the LLM only produces blocks/children)."""
        if force is not None:
            level, no, title = force["level"], force["no"], force["title"]
        else:
            raw_level = data.get("level")
            level = (
                raw_level
                if isinstance(raw_level, int) and raw_level > parent_level
                else parent_level + 1
            )
            no = data.get("no")
            title = str(data.get("title") or "").strip() or f"Section {level}"

        valid_types = {
            "paragraph", "table", "figure", "bullets", "numbered_list", "code", "quote"
        }
        raw_blocks = data.get("blocks")
        blocks: List[dict] = []
        if isinstance(raw_blocks, list):
            for b in raw_blocks:
                if isinstance(b, str):
                    b = {"type": "paragraph", "content": b}
                if not isinstance(b, dict):
                    continue
                content = b.get("content")
                if isinstance(content, list):  # model returned an array of lines
                    content = "\n".join(str(x) for x in content)
                if content is None:
                    content = ""
                btype = b.get("type")
                if btype not in valid_types:
                    btype = "paragraph"
                metadata = b.get("metadata")
                if not isinstance(metadata, dict):
                    metadata = {}
                blocks.append(
                    {"type": btype, "content": str(content), "metadata": metadata}
                )

        raw_children = data.get("children")
        children: List[dict] = []
        if isinstance(raw_children, list):
            for c in raw_children:
                if isinstance(c, dict):
                    children.append(self._coerce_section(c, parent_level=level))

        return {"level": level, "no": no, "title": title, "blocks": blocks, "children": children}

    def _split_into_chunks(self, blocks: List["ContentBlock"]) -> List[List["ContentBlock"]]:
        chunks: List[List["ContentBlock"]] = []
        current: List["ContentBlock"] = []
        cur_chars = 0
        for b in blocks:
            size = len(b.content)
            if current and (
                len(current) >= self._MAX_BLOCKS_FOR_LLM
                or cur_chars + size > self._MAX_CHARS_FOR_LLM
            ):
                chunks.append(current)
                current, cur_chars = [], 0
            current.append(b)
            cur_chars += size
        if current:
            chunks.append(current)
        return chunks

    def _blocks_compacted(self, blocks: List["ContentBlock"]) -> str:
        """Index-stem representation for the compact protocol: enough signal to
        group blocks, never the full text (content stays in the parse tree)."""
        parts = []
        for i, b in enumerate(blocks):
            raw = b.content if b.type != "figure" else (b.metadata.get("caption") or b.content)
            stem = " ".join(raw.split())[: self._COMPACT_STEM]
            parts.append(f"[{i}] ({b.type}) {stem}  <{len(b.content)} chars>")
        return "\n".join(parts)

    def _compacted_section(
        self,
        node: "DocumentSection",
        chunk: List["ContentBlock"],
        payload: dict,
    ) -> Optional["DocumentSection"]:
        """Reassembles a compacted chunk: children carry the ORIGINAL blocks via
        the model's block_indices; unassigned blocks stay at the parent level.
        Content never comes from the model -- only grouping + titles do."""
        assigned: set = set()
        children: List["DocumentSection"] = []
        raw_children = payload.get("children")
        if isinstance(raw_children, list):
            for c in raw_children:
                if not isinstance(c, dict):
                    continue
                title = str(c.get("title") or "").strip().rstrip(".:- ")
                idxs = c.get("block_indices")
                if not isinstance(idxs, list):
                    continue
                keep = []
                for x in idxs:
                    if isinstance(x, int) and 0 <= x < len(chunk):
                        assigned.add(x)
                        keep.append(chunk[x])
                if title and keep:
                    children.append(
                        DocumentSection(
                            level=node.level + 1,
                            no=None,
                            title=self._clean_title_string(title, strip_trailing_number=False),
                            blocks=keep,
                            children=[],
                        )
                    )
        unassigned = [b for i, b in enumerate(chunk) if i not in assigned]
        return DocumentSection(
            level=node.level,
            no=node.no,
            title=node.title,
            blocks=unassigned,
            children=children,
        )

    def _restructure_chunk(
        self,
        node: "DocumentSection",
        chunk: List["ContentBlock"],
        chunk_idx: int,
        chunk_total: int,
    ) -> Optional["DocumentSection"]:
        # Always the compact index protocol: blocks stay verbatim from the parse
        # (the model never re-echoes content -- it only groups via block_indices).
        # Verbatim echo was dropped: it was both slow (echo output tokens) and
        # unreliable (minor drift that silently mangles stored content).
        if not self._blocks_to_verbatim(chunk).strip():
            return None
        prompt = self._COMPACT_TEMPLATE.format(
            parent_title=node.title,
            chunk_idx=chunk_idx + 1,
            chunk_total=chunk_total,
            body=self._blocks_compacted(chunk),
        )

        messages = [
            {"role": "system", "content": self._SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        booked = (len(self._SYSTEM_PROMPT) + len(prompt)) // 4
        self._pace(booked)

        for attempt in range(self._MAX_ATTEMPTS):
            try:
                response = self._openai.chat.completions.create(
                    model=self._llm_model,
                    messages=messages,
                    temperature=0,
                )
                raw = response.choices[0].message.content or ""
                from utilis.model import _estimated_usage, _record_usage, _usage_counts
                counts = _usage_counts(response) or _estimated_usage(prompt, self._SYSTEM_PROMPT, raw)
                _record_usage(self._llm_model, counts)
                if response.usage is not None:
                    detail = response.usage.total_tokens - booked
                    if detail > 0:
                        self._pace(detail)
            except APIError as e:
                tag = f" (chunk {chunk_idx + 1}/{chunk_total})" if chunk_total > 1 else ""
                if "context_length_exceeded" in str(e):
                    print(
                        f"[LLM] Context length exceeded for '{node.title}'{tag} -- keeping flat blocks"
                    )
                    return None
                if e.status_code == 429 or "rate_limit" in str(e).lower():
                    if attempt + 1 < self._MAX_ATTEMPTS:
                        print(
                            f"[LLM] Rate limited on '{node.title}'{tag} (attempt {attempt + 1}) - sleeping and retrying"
                        )
                        time.sleep(15)
                        continue
                    print(
                        f"[LLM] Rate limited on '{node.title}'{tag} - giving up, keeping flat blocks"
                    )
                    return None
                print(
                    f"[LLM] API error restructuring '{node.title}'{tag}: {e} -- keeping flat blocks"
                )
                return None

            payload = self._extract_json(raw)
            if payload is None or not isinstance(payload, dict):
                print(
                    f"[LLM] Could not parse JSON for '{node.title}' (attempt {attempt + 1})"
                )
                if attempt + 1 < self._MAX_ATTEMPTS:
                    messages += [
                        {"role": "assistant", "content": raw},
                        {
                            "role": "user",
                            "content": "Your previous response was not valid JSON. Return ONLY the JSON object "
                            'matching the schema {"children": [{"title": "...", "block_indices": [0, 2]}]} - no prose, no fences.',
                        },
                    ]
                    continue
                return None

            try:
                return self._compacted_section(node, chunk, payload)
            except ValidationError as e:
                print(
                    f"[LLM] Schema validation failed for '{node.title}' (attempt {attempt + 1}): {e}"
                )
                if attempt + 1 < self._MAX_ATTEMPTS:
                    messages += [
                        {"role": "assistant", "content": raw},
                        {
                            "role": "user",
                            "content": f"Schema validation error: {e}. Return ONLY valid JSON matching "
                            '{"children": [{"title": "...", "block_indices": [0, 2]}]} - only the JSON object.',
                        },
                    ]
                    continue
                return None

        return None

    def _llm_restructure(self, node: "DocumentSection") -> bool:
        """
        Sends a flat/undifferentiated node's content to the LLM to re-derive
        subsections and block types. Replaces node.blocks/node.children in place.
        Falls back to the existing flat blocks on any failure (nothing is lost).
        Oversized nodes are chunked and merged in original order.
        """
        body_text = self._blocks_to_verbatim(node.blocks)
        if not body_text.strip():
            return False

        chunks = self._split_into_chunks(node.blocks)
        # Calls are network-I/O and latency-bound (Groq decode variance), so run
        # them concurrently; the token pace limiter keeps the shared TPM budget.
        workers = max(1, min(self._LLM_WORKERS, len(chunks)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(
                pool.map(
                    lambda i_chunk: self._restructure_chunk(
                        node, i_chunk[1], i_chunk[0], len(chunks)
                    ),
                    enumerate(chunks),
                )
            )

        merged_blocks: List[ContentBlock] = []
        merged_children: List["DocumentSection"] = []
        any_success = False
        for i, chunk in enumerate(chunks):
            res = results[i]
            if res is not None and (res.blocks or res.children):
                any_success = True
                merged_children.extend(res.children)
                merged_blocks.extend(res.blocks)
            else:
                # Keep original flat content verbatim when a chunk fails
                merged_blocks.extend(chunk)

        if not any_success or not merged_blocks:
            return False
        node.blocks = merged_blocks
        node.children = merged_children
        return True

    def _trim_redundant(self, node: "DocumentSection") -> None:
        """Drops LLM ghost subsections: children whose title duplicates the
        parent's, or placeholder names like 'Subsection 2.2' / 'Section 3'.
        Their blocks are hoisted into the parent so no content is lost."""
        kept: List["DocumentSection"] = []
        for c in node.children:
            self._trim_redundant(c)
            ct = re.sub(r"[^A-Za-z0-9]+", "", c.title).strip().lower()
            pt = re.sub(r"[^A-Za-z0-9]+", "", node.title).strip().lower()
            is_dup = bool(ct and ct == pt and len(ct) > 3)
            is_ph = bool(
                re.match(r"^(?:subsection|sub-section|section)?\s*\d+(?:\.\d+)*\s*$", c.title.strip(), re.I)
            )
            if is_dup or is_ph:
                node.blocks.extend(c.blocks)
                continue
            kept.append(c)
        node.children = kept

    def _refine_node(self, node: "DocumentSection") -> None:
        if self._needs_restructuring(node):
            print(
                f"[REFINE] Restructuring flat section: '{node.title}' ({len(node.blocks)} blocks)"
            )
            self._llm_restructure(node)
        for child in node.children:
            self._refine_node(child)
        self._trim_redundant(node)

    def _refine_tree(self, sections: List["DocumentSection"], pool: ThreadPoolExecutor) -> None:
        # Restructures are independent per branch and latency-dominated, so run
        # the top-level branches concurrently (children recurse inside the worker).
        list(pool.map(self._refine_node, sections))

    # --------------------------------------------------------------
    # Public API - Hierarchical Document Structural Parser
    # --------------------------------------------------------------
    @timed("DocumentParser.parse")
    def parse(self, file_path: str) -> dict:
        """
        Parses unformatted/semi-formatted documents into a hierarchical section tree.
        Flushes buffered content to the active node BEFORE pushing new heading nodes
        to ensure zero off-by-one fencepost shifts between titles and body blocks.
        """
        print(f"\n[START] Starting hierarchical parsing for: '{file_path}'")

        # 1️⃣ Convert
        converted = self._markitdown.convert(file_path)
        return self.parse_text(converted.text_content, name=file_path, persist=True)

    @timed("DocumentParser.parse_text")
    def parse_text(self, text: str, name: str = "inline.md", persist: bool = False) -> dict:
        """Parse an in-memory markdown string. No file on disk is required.

        The ``persist`` flag writes the tree to the store and updates the parse
        cache; leave it False for benchmarks and dry runs.
        """
        # 1.5️⃣ Normalise
        norm_md = self._normalise(text)

        # 1.6️⃣ Cache replay -- same document + parser version => nothing to redo
        cached = self._cache_get(norm_md) if persist else None
        if cached is not None:
            print(f"[CACHE] Reusing tree for unchanged document [ID: {cached.get('unique_id')}]\n")
            return cached

        # 2️⃣ Single-pass Flush-then-Open Walker with Stack
        print("[STAGE 2] Building heading tree with synchronized content pairing...")
        lines = norm_md.splitlines()

        root_sections: List[DocumentSection] = []
        candidates: Dict[str, int] = {}
        stack: List[DocumentSection] = []
        current_buffer: List[str] = []
        in_toc = False
        in_code = False

        def flush_buffer():
            nonlocal current_buffer
            if not current_buffer:
                return
            body_text = "\n".join(current_buffer).strip()
            current_buffer = []
            if not body_text:
                return
            new_blocks = self._assemble_blocks(body_text)
            if stack:
                stack[-1].blocks.extend(new_blocks)
            else:
                # Content found before the first heading -> Preamble node
                preamble = DocumentSection(
                    level=1,
                    no=None,
                    title="Preamble",
                    blocks=new_blocks,
                    children=[],
                )
                root_sections.append(preamble)
                stack.append(preamble)

        for idx, line in enumerate(lines):
            if line.strip().startswith("```"):
                in_code = not in_code
                current_buffer.append(line)
                continue
            if in_code:
                # Never classify or split code content as headings
                current_buffer.append(line)
                continue

            prev_blank = idx == 0 or not lines[idx - 1].strip()
            classif = self._classify_line(line, prev_blank, suppress_plain=in_toc)

            if classif.get("candidate"):
                candidates[  # kept as body text, surfaced for observability
                    classif["candidate"]
                ] = candidates.get(classif["candidate"], 0) + 1

            if classif["type"] in ("h1?", "h?", "h2?", "h3?", "h4?"):
                level = classif.get("level", 1)
                title = classif["val"]
                no = classif.get("no")

                # Track Table of Contents state to prevent phantom duplicate trees
                if re.match(r"^table\s+of\s+contents$", title, re.I):
                    in_toc = True
                elif line.strip().startswith("#"):
                    in_toc = False

                # 1. FLUSH FIRST to the currently active heading node
                flush_buffer()

                # 2. Open new node with empty blocks and push onto stack
                new_node = DocumentSection(
                    level=level,
                    no=no,
                    title=title,
                    blocks=[],
                    children=[],
                )

                # Pop any nodes at the same or deeper level
                while stack and stack[-1].level >= level:
                    stack.pop()

                if stack:
                    stack[-1].children.append(new_node)
                else:
                    root_sections.append(new_node)

                stack.append(new_node)
            else:
                current_buffer.append(line)

        # Final flush after the document loop terminates
        flush_buffer()

        # 2.5️⃣ LLM cleanup pass -- restructure any flat/undifferentiated sections
        if self.llm_restructuring:
            print("[STAGE 2.5] Refining flat sections via LLM restructuring...")
            with ThreadPoolExecutor(max_workers=self._LLM_WORKERS) as _refine_pool:
                self._refine_tree(root_sections, _refine_pool)
        else:
            print("[STAGE 2.5] Skipped (llm_restructuring=False): deterministic tree only")

        # 3️⃣ Assemble & Database
        doc_uuid = str(uuid.uuid4())
        serialized_sections = [sec.model_dump() for sec in root_sections]

        entry = {
            "unique_id": doc_uuid,
            "title": self._extract_title(name, markdown=norm_md),
            "markdown": norm_md,
            "sections": serialized_sections,
            "heading_candidates": candidates,
        }
        if candidates:
            detail = ", ".join(f"{k}={v}" for k, v in sorted(candidates.items()))
            print(f"[STAGE 2] Demoted heading candidates to body text: {detail}")

        if not persist:
            print(f"[FINISH] Tree built (not persisted): {len(root_sections)} root sections\n")
            return entry

        print("[STAGE 3] Persisting parsed hierarchy tree...")
        self._db.set(doc_uuid, entry)
        self._cache_put(doc_uuid, norm_md)
        print(f"[FINISH] Tree hierarchy successfully saved! [ID: {doc_uuid}]\n")
        return entry
