"""File logging for quill_engine.

Captures ``quill_engine`` and ``textual`` log records, plus any uncaught
exception (main thread, worker threads, and Textual's internal
``_handle_exception`` path), into ``logs/quill_engine.log`` under the
project root.

Textual catches exceptions raised inside message handlers itself and then
exits the app (``App._handle_exception`` -> ``App.panic``), printing the
traceback only to the terminal — it never reaches the ``logging`` module.
So a plain file handler is NOT enough: ``QuillTuiApp`` overrides
``_handle_exception`` to write the traceback to the log file before the
app shuts down.
"""

from __future__ import annotations

import logging
import sys
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path

_LOGGER = logging.getLogger(__name__)

# Project root = parent of the quill_engine package directory (stable
# regardless of the process cwd).
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_LOG_DIR = _PROJECT_ROOT / "logs"
_LOG_FILE = _LOG_DIR / "quill_engine.log"

_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(threadName)s: %(message)s"

# Namespaces captured at DEBUG into the file.
_CAPTURE = ("quill_engine", "textual")

_installed = False


def log_file_path() -> Path:
    """Absolute path of the log file (created lazily on first record)."""
    return _LOG_FILE


def _install_file_handler() -> None:
    """Attach a rotating DEBUG file handler to the captured loggers."""
    global _installed
    if _installed:
        return

    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            _LOG_FILE,
            maxBytes=5 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
    except OSError as error:
        # Never let logging setup break the app; fall back to /tmp.
        _LOGGER.warning("Could not create %s (%s); falling back to /tmp", _LOG_DIR, error)
        handler = RotatingFileHandler(
            Path("/tmp") / "quill_engine.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )

    handler.setLevel(logging.DEBUG)
    handler.setFormatter(logging.Formatter(_FORMAT))

    root = logging.getLogger()
    # Single attachment point: the root logger. Records from every logger
    # propagate up to it, so attaching here (instead of per-logger) avoids
    # double-writing. Captured namespaces get their level raised so their
    # DEBUG/INFO records actually pass through root's handler.
    for name in _CAPTURE:
        logging.getLogger(name).setLevel(logging.DEBUG)
    # Anything else (e.g. httpx, httpcore) keeps its default level, so only
    # WARNING+ lands in the file via the root logger.
    root.addHandler(handler)

    _installed = True


def _log_traceback(kind: str, exc_info: tuple) -> None:
    """Write a fatal traceback to the file from outside normal log flow."""
    _install_file_handler()
    try:
        _LOGGER.critical("%s — uncaught exception", kind, exc_info=exc_info)
    except Exception:
        pass  # never mask the original crash


def install_excepthooks() -> None:
    """Log uncaught exceptions (main + worker threads) to the log file."""
    _install_file_handler()

    previous_sys = sys.excepthook

    def _sys_hook(exc_type, exc_value, exc_tb) -> None:
        try:
            _log_traceback("Main thread", (exc_type, exc_value, exc_tb))
        finally:
            previous_sys(exc_type, exc_value, exc_tb)

    previous_thread = threading.excepthook

    def _thread_hook(args: threading.ExceptHookArgs) -> None:
        try:
            _log_traceback(f"Thread {args.thread.name!r}", (args.exc_type, args.exc_value, args.exc_tb))
        finally:
            previous_thread(args)

    sys.excepthook = _sys_hook
    threading.excepthook = _thread_hook


def setup_file_logging() -> Path:
    """One-shot setup: file handler + excepthooks. Returns the log path."""
    install_excepthooks()
    return log_file_path()
