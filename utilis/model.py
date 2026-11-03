import json
import os
import re
import shlex
import subprocess

from dotenv import load_dotenv

# Load the variables from the .env file into the system environment
# Must run before importing utilis.ratelimit, which builds its budget at import.
load_dotenv()

import openai

from utilis.pydanticModels import (
    AtlasPlan,
    NousResponse,
    OracleDecision,
    SageConcept,
    ScoutReport,
    WardenReport,
)
from utilis.ratelimit import LIMITER, _reasoning_kwargs, estimate_tokens, run_with_retry
from loguru import logger

# Providers reject a 400 when a model emits a tool call while tool_choice is
# "none". gpt-oss-20b does this for prompts that mention searching.
_TOOL_USE_ERRORS = (
    "tool choice is none",
    "tool_use_failed",
    "but model called a tool",
    "no tools available",
)


def _is_tool_use_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in _TOOL_USE_ERRORS)

from utilis.timing import log_block, timed

# --- Caveman Compression (https://github.com/wilpel/caveman-compression) ---
# Lossless semantic compression for LLM contexts: strip predictable grammar,
# keep the unpredictable facts. The LLM-based path is reproduced here and
# routed through ``Agent.model`` so it reuses the configured provider (Groq).

_COMPRESSION_PROMPT = """You are a caveman compression expert. Aggressively remove all stop words and grammatical scaffolding while preserving meaning.

CORE STRATEGY:
1. Remove articles, auxiliary verbs, and redundant words. Keep only content words that carry semantic meaning.
2. Use simple, common words. If there's a simpler word, use it. Think like a caveman.

ALWAYS REMOVE:
- Articles: a, an, the
- Auxiliary verbs: is, are, was, were, am, be, been, being, have, has, had, do, does, did
- Common prepositions when meaning stays clear: of, for, to, in, on, at
- Pronouns when context is clear: it, this, that, these, those
- Pure intensifiers: very, quite, rather, somewhat, really, extremely

ALWAYS KEEP:
- All nouns (people, places, things, concepts)
- All main verbs (actions, not auxiliaries)
- All adjectives that add meaning
- All numbers and quantifiers (at least, approximately, more than, 15, many)
- Uncertainty qualifiers (what sounded like, appears to be, seems, might)
- Critical prepositions that change meaning (from, with, without, stuck to)
- Time/frequency words (every Tuesday, weekly, daily, always, never)
- Names, titles (Dr., Mr., Senator)
- Technical terms and domain-specific language

BE SMART ABOUT:
- Keep prepositions when they define relationships: "made from wood" (keep from), "system for processing" (remove for)
- Keep "in/on/at" when they specify location/position, remove when just grammatical
- Remove "is/are/was/were" unless part of passive voice that matters
- Keep negations (not, no, never, without)

EXAMPLES:

"Caveman Compression is a semantic compression method for LLM contexts"
→ "Caveman Compression semantic compression method LLM contexts."
(Remove: is, a, for)

"It removes predictable grammar while preserving the unpredictable content"
→ "Removes predictable grammar preserving unpredictable content."
(Remove: It, the, while → keep main meaning)

"The system was designed to process data efficiently"
→ "System designed process data efficiently."
(Remove: The, was, to)

"There were at least 20 people"
→ "At least 20 people."
(Keep: at least - quantifier matters)

"Made from wood and metal"
→ "Made from wood and metal."
(Keep: from - shows material relationship)

Output ONLY the caveman compressed text, nothing else.

TEXT TO COMPRESS:
{text}"""

_DECOMPRESSION_PROMPT = """You are a language expansion expert. Convert the following caveman-compressed text back into proper, fluent English while preserving ALL semantic information.

The caveman text uses:
- Very short sentences (2-5 words)
- No connectives
- Active voice
- Concrete language
- Minimal articles

Your task:
1. Expand sentences to natural English length
2. Add appropriate connectives (because, therefore, however, etc.)
3. Add articles (a, an, the) where natural
4. Ensure smooth flow between sentences
5. Maintain all facts, constraints, and logical steps
6. Use proper grammar and style

Output ONLY the expanded English text, nothing else.

CAVEMAN TEXT TO EXPAND:
{text}"""

_COMPRESSION_SYSTEM = (
    "You are an expert at caveman compression. Always compress the provided "
    "text, never ask for clarification."
)
_DECOMPRESSION_SYSTEM = "You are an expert at expanding compressed text."


def count_tokens(text: str) -> int:
    """Estimate tokens using character count / 4."""
    return len(text.strip()) // 4


def is_text_content(text: str) -> bool:
    """Detect if content is natural language text vs code/structured data."""
    code_indicators = [
        "def ", "class ", "function ", "import ", "const ", "let ", "var ",
        "public ", "private ", "protected ", "#include", "package ",
        "=>", "->", "::", "!=", "==", "<=", ">=", "&&", "||",
    ]
    code_score = sum(1 for indicator in code_indicators if indicator in text)
    brace_count = text.count("{") + text.count("}") + text.count("[") + text.count("]")
    words = text.split()
    if len(words) < 5:
        return True
    if code_score >= 2 or brace_count > len(words) * 0.2:
        return False
    return True


def split_sentences(text: str) -> list[str]:
    """Split text into sentences (regex fallback; spaCy-free)."""
    return [
        s.strip()
        for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'`])", text)
        if s.strip()
    ]


def _is_local_endpoint(base_url: str) -> bool:
    """Whether a base URL names a server on this machine.

    The same rule as `secrets::is_loopback_endpoint` in the Rust core and
    `api._is_local_endpoint`, because all three decide whether a missing key is a
    mistake or the correct state for the endpoint.
    """
    from urllib.parse import urlsplit

    try:
        host = urlsplit(base_url.strip()).hostname or ""
    except ValueError:
        return False
    return host in {"localhost", "::1", "0.0.0.0"} or host.startswith("127.")


def _usage_tokens(response) -> int | None:
    """Total tokens the provider reported, or None when it reported nothing."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    total = getattr(usage, "total_tokens", None)
    if total is None:
        inp = getattr(usage, "prompt_tokens", None) or getattr(usage, "input_tokens", None) or 0
        out = getattr(usage, "completion_tokens", None) or getattr(usage, "output_tokens", None) or 0
        total = int(inp or 0) + int(out or 0)
    try:
        return int(total)
    except (TypeError, ValueError):
        return None


def _record_usage(model: str, tokens: int) -> None:
    """Accumulate today's token spend per model for the Settings usage table.

    Telemetry: a failure here must never fail a turn, so every error is
    swallowed at debug level.
    """
    if tokens <= 0:
        return
    try:
        from datetime import datetime, timezone
        from utilis.store import open_store

        key = f"usage:{datetime.now(timezone.utc).date().isoformat()}"
        db = open_store()
        usage = db.get(key)
        if not isinstance(usage, dict):
            usage = {}
        usage[model] = int(usage.get(model, 0)) + int(tokens)
        db.set(key, usage)
    except Exception:  # noqa: BLE001 - statistics, never fatal
        logger.debug("usage recording failed", exc_info=True)


class Agent:
    """One provider client, configured explicitly.

    ``config`` is the provider block the GUI resolved from its registry and
    credential store. When it is absent the process environment is still
    consulted, so the sidecar keeps working when launched on its own; that
    fallback is the thing this class is being migrated away from.

    Configuration is read once, here, instead of at every call site. The
    previous arrangement captured ``LLM_MODEL`` as a *default argument*, which
    Python evaluates once at import -- so an agent built for provider A could
    silently answer with provider B's model, with nothing in the logs to say so.
    """

    def __init__(self, config: dict | None = None) -> None:
        cfg = config or {}
        self.protocol = str(cfg.get("protocol") or "openai_chat")
        self._model = str(cfg.get("model") or "")

        # A run may want different models for thinking and writing (2026-10-30:
        # qwen writes the prose, gpt-oss does the reasoning -- gpt-oss bills its
        # hidden chain-of-thought as output, so spending it on prose is waste,
        # while the writer's system prompt already says "low-tier model").
        # Precedence is explicit env first, provider registry second, LLM_MODEL
        # last. During the registry migration the env knobs are the operator
        # path that actually runs; the provider block will carry the same fields
        # from Task 6 on. Empty means "same model for both roles".
        self._thinking_model = str(
            cfg.get("thinking_model") or os.environ.get("QUILL_THINKING_MODEL") or ""
        ).strip()
        self._writing_model = str(
            cfg.get("writing_model") or os.environ.get("QUILL_WRITING_MODEL") or ""
        ).strip()

        if self.protocol == "cli":
            # `base_url` carries the command prefix that receives the turn
            # (`opencode run --format json`, `codex exec --json`, ...). It must
            # NOT fall back to OPENAI_BASE_URL: an HTTP address is not an
            # executable, and a missing command should fail loudly here.
            self.base_url = str(cfg.get("base_url") or "").strip()
            if not self.base_url:
                raise RuntimeError(
                    "cli provider has no command: set base_url to the agent's "
                    "one-shot invocation, e.g. 'opencode run --format json'"
                )
            # The CLI authenticates through its own stored login (codex login,
            # opencode auth, ...); there is no key to read and no HTTP client to
            # build -- `_complete_cli` shells out instead.
            self.OpenAi = None
            return

        base_url = cfg.get("base_url") or os.environ.get("OPENAI_BASE_URL")
        self.base_url = str(base_url or "")
        # An empty key in the provider block means the caller resolved a local
        # server, which genuinely has none -- Rust treats a loopback endpoint the
        # same way. It is not the same as "unset": unset still falls back to the
        # environment, so a standalone sidecar keeps working.
        declared_key = cfg.get("api_key")
        api_key = (
            declared_key
            if declared_key is not None
            else os.environ.get("OPENAI_API_KEY")
        )
        if not api_key and _is_local_endpoint(base_url or ""):
            # The SDK refuses to construct without a key and always sends the
            # header, so a local endpoint gets a placeholder it is documented to
            # ignore. Nothing is being authenticated; the address is the reason.
            api_key = "local-no-key"
        if not api_key:
            raise RuntimeError(
                "no provider credential: the GUI sends one with each request, "
                "and OPENAI_API_KEY is not set for a standalone run"
            )
        self.OpenAi = openai.OpenAI(api_key=api_key, base_url=base_url or None)

    def _resolve_model(self, model_name: str | None) -> str:
        name = (model_name or self._model or "").strip()
        if not name:
            raise RuntimeError(
                "no model configured: set one on the provider before running"
            )
        return name

    def _resolve_thinking(self) -> str:
        """The model for reasoning personas (Nous/Oracle/Sage/Scout/Warden)."""
        return self._thinking_model or self._resolve_model(None)

    def _resolve_writing(self) -> str:
        """The model for writing personas (Quill)."""
        return self._writing_model or self._resolve_model(None)

    def _complete(self, name: str, prompt: str, instructions: str,
                  temperature: float | None) -> str:
        """Speaks whichever request shape the provider actually implements.

        ``/chat/completions`` is the near-universal denominator -- Groq, Ollama,
        vLLM, LM Studio, OpenRouter, Together, DeepSeek, LiteLLM all serve it --
        while the Responses API is OpenAI-shaped. Defaulting to the narrower one
        would fail most custom endpoints; defaulting to the wider one would fail
        here, so the provider says which it speaks.
        """
        if self.protocol == "cli":
            return self._complete_cli(name, prompt, instructions)

        if self.protocol == "openai_responses":
            kwargs = {"model": name, "input": prompt, "instructions": instructions}
            if temperature is not None:
                kwargs["temperature"] = temperature
            kwargs.update(_reasoning_kwargs(name))
            out = self.OpenAi.responses.create(**kwargs)
            _record_usage(
                name,
                _usage_tokens(out) or (estimate_tokens(prompt) + estimate_tokens(instructions)),
            )
            return out.output_text

        messages = [
            {"role": "system", "content": instructions},
            {"role": "user", "content": prompt},
        ]
        kwargs = {"model": name, "messages": messages}
        if temperature is not None:
            kwargs["temperature"] = temperature
        kwargs.update(_reasoning_kwargs(name))
        resp = self.OpenAi.chat.completions.create(**kwargs)
        _record_usage(
            name,
            _usage_tokens(resp) or (estimate_tokens(prompt) + estimate_tokens(instructions)),
        )
        return resp.choices[0].message.content

    def _complete_cli(self, name: str, prompt: str, instructions: str) -> str:
        """Sends the turn to a CLI agent (``protocol: "cli"``).

        The provider's ``base_url`` is the command prefix -- ``opencode run
        --format json``, ``codex exec --json``, ``claude -p --output-format
        json``, ``llm`` -- and the composed text (instructions + prompt) rides
        as the final argv element. The answer comes back on stdout.

        Most of these CLIs print JSONL events rather than bare text, so stdout
        is parsed for text across the shapes the common tools emit
        (``part.text``, top-level ``text``, ``item.text``, ``result``).
        Anything unrecognised falls through to raw stdout with ANSI escapes
        stripped: a rough answer beats a crash, and no downstream code has to
        know which transport produced it.

        The CLI's own login is the credential -- Quill never passes a key.
        """
        message = f"{instructions}\n\n{prompt}".strip() if instructions else prompt
        argv = shlex.split(self.base_url) + [message]
        timeout = int(os.environ.get("QUILL_CLI_TIMEOUT", "600"))
        logger.debug(f"[cli] exec: {argv[0]} (turn as {name})")
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        out = proc.stdout or ""
        if proc.returncode != 0 and not out.strip():
            raise RuntimeError(
                f"{argv[0]} exited {proc.returncode}: "
                f"{(proc.stderr or '').strip()[:400]}"
            )

        texts: list[str] = []
        for line in out.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            part = obj.get("part")
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                texts.append(part["text"])
            elif isinstance(obj.get("text"), str):
                texts.append(obj["text"])
            elif isinstance(obj.get("item"), dict) and isinstance(obj["item"].get("text"), str):
                texts.append(obj["item"]["text"])
            elif isinstance(obj.get("result"), str):
                texts.append(obj["result"])
        if texts:
            return "\n".join(texts).strip()

        # Raw fallback: strip ANSI colour, drop the CLI's own chatter lines
        # (`> build · model` and friends) that print before the answer.
        clean = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", out)
        lines = [ln for ln in clean.splitlines() if not ln.lstrip().startswith("> ")]
        return "\n".join(lines).strip()

    _LANGUAGE_DIRECTIVE = (
        "\n\nLANGUAGE: Write every response in English only. Do not answer in"
        " Arabic or any other language, even if the request, the source"
        " material, or the surrounding text is in another language. Transliterate"
        " or translate foreign terms into English where a term is needed."
    )

    @timed("Agent.model")
    def model(
        self,
        prompt: str,
        model_name: str | None = None,
        system_prompt: str = "",
        temperature: float | None = None,
    ):
        model_name = self._resolve_model(model_name)
        instructions = f"{system_prompt}{self._LANGUAGE_DIRECTIVE}"
        estimated = estimate_tokens(prompt) + estimate_tokens(instructions)
        log_block(f"LLM REQUEST [{model_name}]", f"{system_prompt}\n\n{prompt}")
        logger.debug(f"LLM estimated_tokens={estimated}")

        def _call(instructions_override: str | None = None):
            LIMITER.wait_for(estimated)
            return self._complete(
                model_name, prompt, instructions_override or instructions, temperature
            )

        try:
            output = run_with_retry(_call)()
        except Exception as exc:
            if not _is_tool_use_error(exc):
                raise
            # Some models emit a tool call as output even though no tools were
            # offered, which the provider rejects with a 400. Correct the
            # instruction once rather than failing the whole run.
            logger.warning(
                "[model] model emitted a tool call with no tools configured; "
                "retrying with a corrective instruction"
            )
            corrective = (
                instructions
                + "\n\nIMPORTANT: You have NO tools available. Do not emit tool calls,"
                ' function calls, or JSON of the form {"name": ..., "arguments": ...}.'
                " Answer directly in the required format using only your own knowledge."
            )
            output = run_with_retry(lambda: _call(corrective))()
        log_block(f"LLM RESPONSE [{model_name}]", output)
        return output

    @timed("Agent.compress")
    def compress(
        self,
        text: str,
        bulk: bool = False,
        model_name: str | None = None,
    ) -> dict:
        """Compress normal English into caveman compression (token savings).

        Matches wilpel/caveman-compression's LLM path: code/structured content
        is compressed whole; prose is compressed sentence-by-sentence for
        better fidelity (pass ``bulk=True`` for a single call to save extra
        round-trips). Returns ``{"text", "original_tokens",
        "compressed_tokens", "reduction"}``.
        """
        if not text.strip():
            return {
                "text": text,
                "original_tokens": 0,
                "compressed_tokens": 0,
                "reduction": 0.0,
            }

        if is_text_content(text) and not bulk:
            sentences = split_sentences(text)
        else:
            sentences = [text]

        compressed_parts = []
        for sentence in sentences:
            prompt = _COMPRESSION_PROMPT.format(text=sentence)
            output = self.model(
                prompt, model_name=model_name, system_prompt=_COMPRESSION_SYSTEM
            )
            compressed_parts.append(output.strip())

        compressed = " ".join(compressed_parts).strip()
        original_tokens = count_tokens(text)
        compressed_tokens = count_tokens(compressed)
        reduction = (
            (original_tokens - compressed_tokens) / original_tokens * 100
            if original_tokens > 0
            else 0
        )
        return {
            "text": compressed,
            "original_tokens": original_tokens,
            "compressed_tokens": compressed_tokens,
            "reduction": reduction,
        }

    @timed("Agent.decompress")
    def decompress(self, text: str, model_name: str | None = None) -> dict:
        """Expand caveman-compressed text back to fluent English.

        Returns ``{"text", "caveman_tokens", "normal_tokens", "expansion"}``.
        """
        prompt = _DECOMPRESSION_PROMPT.format(text=text)
        decompressed = self.model(
            prompt, model_name=model_name, system_prompt=_DECOMPRESSION_SYSTEM
        ).strip()
        caveman_tokens = count_tokens(text)
        normal_tokens = count_tokens(decompressed)
        expansion = (
            (normal_tokens - caveman_tokens) / caveman_tokens * 100
            if caveman_tokens > 0
            else 0
        )
        return {
            "text": decompressed,
            "caveman_tokens": caveman_tokens,
            "normal_tokens": normal_tokens,
            "expansion": expansion,
        }

    @timed("Agent.Nous")
    def Nous(self, prompt: str) -> NousResponse:
        """Reasoning/Thinking"""

        system_prompt = """You are a reasoning agent responsible for routing tasks.

        Given a user prompt, decide which single task type best fits it, choosing from:
        WRITE, REWRITE, RESEARCH, CRITIQUE, SMALLTALK, EXPLAIN.
        Now If any Link is provied here add it to JSON response, if none add an empty list.

        Respond with valid JSON only, no other text, in this exact shape:
        {"task": "<TASK_TYPE>", "confidence": <float between 0 and 1>, "links": ["<LINK>", "<LINK>", ...]}
        """

        response = self.model(prompt, system_prompt=system_prompt, model_name=self._resolve_thinking())
        try:
            return NousResponse(**json.loads(response))
        except json.JSONDecodeError:
            return response

    @timed("Agent.Oracle")
    def Oracle(self, prompt: str) -> OracleDecision:
        """Reasoning/Thinking (deliberate reflection between research passes).

        Examines the current state, decides what to do next, and proposes the
        concrete set of follow-up search queries to run (empty if done).
        """

        system_prompt = """You are a reasoning agent (Oracle) that reflects on an ongoing research process.

        Given the current research state: the overall concept being researched, what
        has already been gathered, and its assessed coverage, think carefully about
        what is still missing and decide the best next action.

        Respond with valid JSON only, no other text, in this exact shape:
        {
            "thoughts": "<your reasoning about what is known, missing, and why>",
            "decision": "<one of: continue_research, ask_user, done>",
            "next_queries": ["<search query>", "<search query>", ...],
            "confidence": <float between 0 and 1>
        }

        RULES:
        - "next_queries" must be empty when decision is "done" or "ask_user".
        - Do not repeat queries that have already been run.
        - Keep queries concrete and searchable.
        """

        response = self.model(prompt, system_prompt=system_prompt, model_name=self._resolve_thinking())
        try:
            return OracleDecision(**json.loads(response))
        except (json.JSONDecodeError, TypeError, ValueError):
            return OracleDecision(thoughts=response)

    @timed("Agent.atlas")
    def atlas(self, prompt: str):
        """Planning"""

        system_prompt = """You are a planning agent responsible for breaking a task into an executable plan.

        Given a user prompt, produce a plan for how another model should execute it.

        Respond with valid JSON only, no other text, in this exact shape:
        {
            "plan": "<PLAN IN MARKDOWN FORMAT>",
            "confidence": <float between 0 and 1>,
            "tasks": ["<TASK_TYPE>", "<TASK_TYPE>", ...]
        }
        Or if the prompt provides a Structure or Shape, respond with a structured output matching that shape.

        The "plan" field must be a single markdown-formatted string (headings, lists, etc. as needed).
        The "tasks" field must only contain values from: WRITE, REWRITE, RESEARCH, CRITIQUE, SMALLTALK, EXPLAIN.
        """

        response = self.model(prompt, system_prompt=system_prompt)
        try:
            return json.loads(response)
        except json.JSONDecodeError:
            return response

    @timed("Agent.Sage")
    def Sage(self, prompt: str, comparison_prompt: str = "") -> SageConcept:
        """Conceptualizing"""

        system_prompt = """You are a concept-understanding agent.

        You are given a primary prompt, and optionally a second prompt to compare it against.
        If only one prompt is given, extract and explain its core concept clearly.
        If a second prompt is given, find the conceptual connection between the two prompts
        and merge them into a single unified concept that bridges both.

        Respond with valid JSON only, no other text, in this exact shape:
        {"concept": "<UNIFIED OR EXTRACTED CONCEPT>", "confidence": <float between 0 and 1>}
        """

        if comparison_prompt:
            combined_prompt = f"PROMPT 1:\n{prompt}\n\nPROMPT 2:\n{comparison_prompt}"
        else:
            combined_prompt = prompt

        response = self.model(combined_prompt, system_prompt=system_prompt, model_name=self._resolve_thinking())
        try:
            return SageConcept(**json.loads(response))
        except (json.JSONDecodeError, TypeError, ValueError):
            return SageConcept(concept=response)

    @timed("Agent.MergeConcepts")
    def MergeConcepts(self, master: str, concepts: list[str]) -> SageConcept:
        """Fold several concepts into one in a SINGLE call.

        Folding pairwise costs one call per concept; batching k concepts into one
        prompt costs 1 call for k, which is what makes merging cheap on large
        documents.
        """
        if not concepts:
            return SageConcept(concept=master, confidence=1.0)
        if len(concepts) == 1:
            return SageConcept(concept=concepts[0], confidence=1.0)

        system_prompt = """You are a concept-merging agent.

The master concept is the topic the user actually asked for and is the anchor.
Fold the supporting concepts below into the master. Keep the master topic as
the result. Use a supporting concept only for detail that is relevant to the
master; if a concept is about a different subject, ignore it.

Respond with valid JSON only, no other text, in this exact shape:
{"concept": "<MERGED CONCEPT>", "confidence": <float between 0 and 1>}
"""
        listing = "\n".join(f"- {c}" for c in concepts)
        prompt = f"MASTER CONCEPT:\n{master}\n\nSUPPORTING CONCEPTS:\n{listing}"
        response = self.model(prompt, system_prompt=system_prompt, model_name=self._resolve_thinking())
        try:
            return SageConcept(**json.loads(response))
        except (json.JSONDecodeError, TypeError, ValueError):
            return SageConcept(concept=response)

    @timed("Agent.Scout")
    def Scout(self, concept: str, research: str) -> ScoutReport:
        """Researching"""

        # 2026-10-10 15:23 incident (logs/quill-20261010-152259.log): the old rule
        # here read "ask for ONE specific thing (a name, a date, a mechanism, a
        # figure)". gpt-oss-20b obeyed it exactly - "When was it demolished?",
        # "What was the primary reason for its demolition?" - on a run that had
        # already retrieved 42 pages, so the user was asked to supply facts the
        # corpus held. "a date" and "a mechanism" are the two shapes research
        # exists to answer; never name them as things to request.
        # researchEngine._clean_questions drops these questions regardless, so
        # ignoring this rule costs an empty questionnaire (status "continue"),
        # never another round of the user.
        system_prompt = """You are a research agent.

        You are given a concept and the research that has already been gathered for it.
        Decide whether the existing research is sufficient, or whether more information
        is needed from the user before continuing.

        If you need input, ask at most 3 questions. Each question must:
        - cover a DIFFERENT aspect, with no overlap or repetition between questions;
        - ask ONLY what search cannot answer: which subject you mean, what angle,
          how deep, what to include or avoid, who it is for;
        - NEVER ask for a fact research can establish - dates, years, reasons,
          causes, mechanisms, quantities, builders, locations, or a known name;
        - be at most 100 characters and end in a question mark;
        - not restate the concept or mention "this document", "this essay" or "the topic".
        If the concept is specific enough to research, reply done instead.

        Respond with valid JSON only, no other text, in this exact shape:
        {"status": "needs_user_input", "questionnaire": ["<QUESTION>", "<QUESTION>"]}

        If no more information is needed, respond with valid JSON only, no other text, in this exact shape:
        {"status": "done", "summary": "<SUMMARY OF CONCEPT + RESEARCH + CONTEXT>"}
        """

        combined_prompt = f"CONCEPT:\n{concept}\n\nRESEARCH PROVIDED:\n{research}"

        response = self.model(combined_prompt, system_prompt=system_prompt, model_name=self._resolve_thinking())
        try:
            return ScoutReport(**json.loads(response))
        except (json.JSONDecodeError, TypeError, ValueError):
            return ScoutReport(summary=response)

    @timed("Agent.Quill")
    def Quill(self, prompt: str, skill: str = "", temperature: float | None = None):
        """Writing"""

        system_prompt = f"""You are a writing agent. Your job is to produce high-quality, effective writing
        even when running on a low-tier model.

        {skill}
        """

        response = self.model(prompt, system_prompt=system_prompt, temperature=temperature, model_name=self._resolve_writing())
        return response

    @timed("Agent.Warden")
    def Warden(self, research: str, document: str) -> WardenReport:
        """Fact checking / plagiarism"""

        system_prompt = """You are a fact-checking and plagiarism agent.

        You are given a piece of research and a document. Compare the document against the research
        and identify any factual inconsistencies or unoriginal/copied content.

        Respond with valid JSON only, no other text, in this exact shape:
        {"status": "clean" or "flagged", "issues": ["<ISSUE>", "<ISSUE>", ...]}
        """

        combined_prompt = f"RESEARCH:\n{research}\n\nDOCUMENT:\n{document}"

        response = self.model(combined_prompt, system_prompt=system_prompt, model_name=self._resolve_thinking())
        try:
            return WardenReport(**json.loads(response))
        except (json.JSONDecodeError, TypeError, ValueError):
            return WardenReport(issues=[response])
