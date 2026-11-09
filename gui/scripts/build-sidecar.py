#!/usr/bin/env python3
"""Build the Python pipeline as a Tauri sidecar binary.

PyInstaller is run through `uv run --with`, so it never becomes a runtime
dependency of the project. The output is renamed with the Rust target triple,
which is the name Tauri's `externalBin` loader expects.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUI = ROOT / "gui"
BINARIES = GUI / "src-tauri" / "binaries"
DIST = ROOT / "build" / "sidecar-dist"
WORK = ROOT / "build" / "sidecar-work"
SPEC = ROOT / "build"
EMBEDDING_CACHE = ROOT / "build" / "fastembed-cache"
EMBEDDING_BUNDLE = ROOT / "build" / "fastembed-bundle"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIR = "models--Qdrant--all-MiniLM-L6-v2-onnx"

PYINSTALLER = "pyinstaller==6.22.3"
EXCLUDES = [
    "torch",
    "sentence_transformers",
    "transformers",
    "scipy",
    "sklearn",
    "sympy",
    "pytest",
    "matplotlib",
    "tkinter",
]


def find_rustc() -> str:
    found = shutil.which("rustc")
    if found:
        return found
    for candidate in (
        Path.home() / ".cargo" / "bin" / "rustc",
        Path.home() / ".cargo" / "bin" / "rustc.exe",
    ):
        if candidate.is_file():
            return str(candidate)
    raise SystemExit("rustc not found; install Rust or set TAURI_ENV_TARGET_TRIPLE")


def target_triple() -> str:
    explicit = os.environ.get("TAURI_ENV_TARGET_TRIPLE", "").strip()
    if explicit:
        return explicit
    rustc = find_rustc()
    try:
        output = subprocess.check_output([rustc, "-vV"], text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"could not read the Rust host triple: {exc}") from exc
    for line in output.splitlines():
        if line.startswith("host: "):
            return line[6:].strip()
    raise SystemExit("rustc -vV did not report a host triple")


def prepare_embedding_cache() -> Path:
    """Download the ONNX embedding model once, for the sidecar bundle.

    The first run of an installed build used to pause on "Downloading resources"
    while fastembed fetched ~87 MB from Hugging Face. The cache is built here so
    the same bytes travel inside the one-file sidecar and the first answer is
    local. The build is the only place that needs network access.
    """
    model_dir = EMBEDDING_CACHE / EMBEDDING_DIR
    if model_dir.is_dir():
        print(f"==> embedding cache: reusing {EMBEDDING_CACHE}", flush=True)
        return EMBEDDING_CACHE

    EMBEDDING_CACHE.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["FASTEMBED_CACHE_DIR"] = str(EMBEDDING_CACHE)
    # Xet can stall on some networks; the regular HTTP path is slower but
    # deterministic, and this runs once at build time.
    env.setdefault("HF_HUB_DISABLE_XET", "1")
    print(f"==> embedding cache: downloading {EMBEDDING_MODEL}", flush=True)
    code = (
        "from fastembed import TextEmbedding\n"
        f"TextEmbedding(model_name={EMBEDDING_MODEL!r}, cache_dir={str(EMBEDDING_CACHE)!r})\n"
    )
    try:
        subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, check=True)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"could not prepare the embedding cache: {exc}") from exc
    if not model_dir.is_dir():
        raise SystemExit(f"the embedding cache is missing {model_dir}")
    return EMBEDDING_CACHE


def materialise_embedding_cache(cache: Path) -> Path:
    """Copy the cache with symlinks resolved, without the duplicate blob store.

    huggingface_hub stores snapshot entries as symlinks into `blobs/`.
    PyInstaller's `--add-data` copies a symlink as its target string, not the
    file it points at, so the first bundled run would find 77-byte "model.onnx"
    files. Dereferencing once at build time is the difference between a working
    bundle and a download fallback.

    Only `snapshots/`, `refs/` and `files_metadata.json` are needed at runtime.
    Copying `blobs/` as well would double the model bytes inside the bundle.
    """
    if EMBEDDING_BUNDLE.exists():
        shutil.rmtree(EMBEDDING_BUNDLE)
    EMBEDDING_BUNDLE.mkdir(parents=True)
    for model_dir in sorted(cache.glob("models--*")):
        if not model_dir.is_dir():
            continue
        target = EMBEDDING_BUNDLE / model_dir.name
        target.mkdir()
        for name in ("snapshots", "refs"):
            source = model_dir / name
            if source.is_dir():
                shutil.copytree(source, target / name, symlinks=False)
        metadata = model_dir / "files_metadata.json"
        if metadata.is_file():
            shutil.copy2(metadata, target / metadata.name)
    print(f"==> embedding cache: bundled from {EMBEDDING_BUNDLE}", flush=True)
    return EMBEDDING_BUNDLE


def main() -> int:
    uv = shutil.which("uv") or str(Path.home() / ".local" / "bin" / "uv")
    if not Path(uv).is_file() and shutil.which(uv) is None:
        raise SystemExit("uv not found; install it from https://docs.astral.sh/uv/")

    target = target_triple()
    embedding_cache = prepare_embedding_cache()
    embedding_bundle = materialise_embedding_cache(embedding_cache)
    BINARIES.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)

    command = [
        uv,
        "run",
        "--with",
        PYINSTALLER,
        "pyinstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        "quill-sidecar",
        "--paths",
        str(ROOT),
        "--collect-all",
        "fastembed",
        "--collect-all",
        "onnxruntime",
        "--collect-all",
        "tokenizers",
        "--collect-all",
        "markitdown",
        "--collect-all",
        "pdfminer",
        "--collect-all",
        "pdfplumber",
        "--collect-all",
        "pypdfium2",
        "--collect-all",
        "magika",
        "--copy-metadata",
        "fastembed",
        "--copy-metadata",
        "onnxruntime",
        "--copy-metadata",
        "tokenizers",
        "--copy-metadata",
        "markitdown",
        "--copy-metadata",
        "pdfminer.six",
        "--copy-metadata",
        "pdfplumber",
        "--copy-metadata",
        "pypdfium2",
        "--copy-metadata",
        "magika",
        "--add-data",
        f"{embedding_bundle}{os.pathsep}fastembed",
        "--hidden-import",
        "components.orchestrator",
        "--hidden-import",
        "components.sessionManager",
        "--hidden-import",
        "utilis.embeddings",
        "--distpath",
        str(DIST),
        "--workpath",
        str(WORK),
        "--specpath",
        str(SPEC),
        str(ROOT / "api.py"),
    ]
    for name in EXCLUDES:
        command += ["--exclude-module", name]

    print(f"==> building sidecar for {target} ({platform.system()})", flush=True)
    subprocess.run(command, cwd=ROOT, check=True)

    suffix = ".exe" if os.name == "nt" else ""
    source = DIST / f"quill-sidecar{suffix}"
    if not source.is_file():
        raise SystemExit(f"PyInstaller did not produce {source}")
    destination = BINARIES / f"quill-sidecar-{target}{suffix}"
    shutil.copy2(source, destination)
    destination.chmod(destination.stat().st_mode | 0o111)
    size = destination.stat().st_size
    print(f"==> wrote {destination} ({size / (1024 * 1024):.1f} MiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
