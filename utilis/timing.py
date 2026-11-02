"""Execution timing, function-call logging and loguru setup for Quill.

This module is the single owner of the loguru configuration, so it wires up
three sinks:

* a readable console sink on stderr;
* a full DEBUG file sink under ``logs/``, one file per run, which captures
  every decorated call, its arguments, its return value and any exception;
* a stdout mirror, so plain ``print()`` calls anywhere in the codebase are
  captured in the same log file without touching the call site.

The ``@timed`` decorator records wall-clock duration, and the ``@logged``
decorator additionally records arguments and return values. ``@timed("Name")``
labels are the aggregates surfaced by ``report()``/``summary()``.
"""

import sys
import threading
import time
from collections import defaultdict
from functools import wraps
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from loguru import logger

if TYPE_CHECKING:  # pragma: no cover - import cycle avoidance
    from utilis.database import JsonDatabase

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = PROJECT_ROOT / "logs"

_configured = False
_log_handle = None
_log_path: Path | None = None
_stream_lock = threading.Lock()
_default_clip = 500


def log_dir() -> Path:
    """The folder every log file is written to, created on demand."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    return LOG_DIR


def current_log_path() -> Path | None:
    """Path of the active run's log file, configuring logging on first use."""
    _configure()
    return _log_path


def _clip(value: Any, limit: int = _default_clip) -> str:
    text = value if isinstance(value, str) else repr(value)
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return f"{text[:limit]}... (+{len(text) - limit} chars)"


class _StdoutMirror:
    """Write-through proxy that copies stdout lines into the active log file."""

    def __init__(self, stream):
        self._stream = stream
        self._buffer = ""

    def write(self, data: str) -> int:
        self._stream.write(data)
        self._stream.flush()
        self._buffer += data
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            if line.strip():
                _write_raw("print | " + line)
        return len(data)

    def flush(self) -> None:
        self._stream.flush()

    def isatty(self) -> bool:
        return getattr(self._stream, "isatty", lambda: False)()

    def __getattr__(self, name):
        return getattr(self._stream, name)


def _write_raw(line: str) -> None:
    if _log_handle is None:
        return
    with _stream_lock:
        try:
            _log_handle.write(line.rstrip("\n") + "\n")
            _log_handle.flush()
        except (ValueError, OSError):
            pass


def _install_stdout_mirror() -> None:
    if isinstance(sys.stdout, _StdoutMirror):
        return
    sys.stdout = _StdoutMirror(sys.stdout)


def _configure() -> None:
    global _configured, _log_handle, _log_path
    if _configured:
        return
    _configured = True

    logger.remove()
    logger.add(
        sys.stderr,
        level="INFO",
        format=(
            "<green>{time:HH:mm:ss.SSS}</green> | <level>{level: <7}</level> | "
            "<cyan>{name}</cyan>:<cyan>{function}</cyan> <dim>{line}</dim> - "
            "<level>{message}</level>"
        ),
    )

    stamp = time.strftime("%Y%m%d-%H%M%S")
    _log_dir = log_dir()
    _log_path = _log_dir / f"quill-{stamp}.log"
    _log_handle = open(_log_path, "a", encoding="utf-8")
    logger.add(
        _log_handle,
        level="DEBUG",
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <7} | {name}:{function}:{line} - {message}",
        enqueue=False,
    )
    _install_stdout_mirror()
    logger.info(f"log file: {_log_path}")



class _Stats:
    def __init__(self) -> None:
        self.calls = 0
        self.total = 0.0
        self.errors = 0

    @property
    def average(self) -> float:
        return self.total / self.calls if self.calls else 0.0


_stats: defaultdict[str, _Stats] = defaultdict(_Stats)


def _instrument(func, label: str, clip: int, with_stats: bool):
    """Shared CALL/RETURN/FAIL instrumentation for :func:`timed` and :func:`logged`."""
    func_name = label or f"{func.__module__}.{func.__qualname__}"

    @wraps(func)
    def wrapper(*args, **kwargs):
        _configure()
        start = time.perf_counter()
        if with_stats:
            _stats[func_name].calls += 1
        try:
            logger.debug(f"CALL  {func_name} {_format_call(func, args, kwargs, clip)}")
        except Exception:  # noqa: BLE001 - logging must never break the call
            pass
        try:
            result = func(*args, **kwargs)
        except BaseException as exc:
            elapsed = time.perf_counter() - start
            if with_stats:
                _stats[func_name].errors += 1
            logger.exception(
                f"FAIL  {func_name} raised {type(exc).__name__}: {exc} after {elapsed:.3f}s"
            )
            raise
        elapsed = time.perf_counter() - start
        try:
            logger.debug(f"RETURN {func_name} -> {_clip(result, clip)}")
        except Exception:  # noqa: BLE001
            pass
        if with_stats:
            stat = _stats[func_name]
            stat.total += elapsed
            logger.info(
                f"{func_name} took {elapsed:.3f}s "
                f"(call #{stat.calls}, total {stat.total:.3f}s, avg {stat.average:.4f}s)"
            )
        return result

    return wrapper


def timed(label: str = "", clip: int = _default_clip) -> Callable:
    """Log every call with arguments, return value, duration and failures.

    Also accumulates per-function aggregates (calls, errors, total, average)
    surfaced by :func:`summary` and :func:`report`.
    """
    return lambda func: _instrument(func, label, clip, with_stats=True)


def logged(label: str = "", clip: int = _default_clip) -> Callable:
    """Record a call's arguments, return value and failure to the log file.

    Same file output as :func:`timed` without contributing to the timing
    report. Values are clipped so one large payload cannot dominate the log;
    use :func:`log_block` when the full text matters.
    """
    return lambda func: _instrument(func, label, clip, with_stats=False)


def _format_call(func, args: tuple, kwargs: dict, clip: int) -> str:
    """Render a readable argument list, using the signature to name parameters."""
    try:
        import inspect

        parameters = list(inspect.signature(func).parameters)
        names = [n for n in parameters if n not in ("self", "cls")]
        positional = [a for a in args if not _is_receiver(a)]
        parts = []
        for index, value in enumerate(positional):
            key = names[index] if index < len(names) else f"arg{index}"
            parts.append(f"{key}={_clip(value, clip)}")
        parts += [f"{key}={_clip(value, clip)}" for key, value in kwargs.items()]
        return ", ".join(parts)
    except Exception:  # noqa: BLE001
        return _clip(list(args) + list(kwargs.values()), clip)


def _is_receiver(value: Any) -> bool:
    """True for the bound ``self`` argument, which is pure noise in a log line."""
    return hasattr(value, "__dict__") and not isinstance(value, (str, bytes, list, dict, tuple, set))


def log_block(title: str, text: str) -> None:
    """Write a payload in full (unclipped), indented under a titled divider."""
    _configure()
    body = (text or "").rstrip()
    logger.debug(f"----- {title} BEGIN ({len(body)} chars) -----")
    for line in body.splitlines() or [""]:
        logger.debug(f"  {line}")
    logger.debug(f"----- {title} END -----")



def summary() -> dict[str, dict]:
    """All aggregates keyed by decorated function label."""
    return {
        name: {
            "calls": stat.calls,
            "errors": stat.errors,
            "total": round(stat.total, 6),
            "average": round(stat.average, 6),
        }
        for name, stat in _stats.items()
    }


def report() -> str:
    """Human-readable, sorted-by-total timing report."""
    lines = ["--- timing report ---"]
    for name, stat in sorted(_stats.items(), key=lambda kv: -kv[1].total):
        lines.append(
            f"  {name:50s} calls={stat.calls:4d} errors={stat.errors:3d} "
            f"total={stat.total:8.3f}s avg={stat.average:7.4f}s"
        )
    return "\n".join(lines) if len(lines) > 1 else "--- timing report: no calls recorded ---"


def record(db: "JsonDatabase | None" = None, key: str = "timing:latest") -> None:
    """Snapshot the current timing aggregates into the database."""
    if db is None:
        from utilis.database import JsonDatabase as _JsonDatabase

        db = _JsonDatabase()
    db.set(key, summary())


def reset() -> None:
    _stats.clear()