#!/usr/bin/env python3
"""Build the bundled SearXNG server as a Tauri sidecar binary.

The desktop app ships its own search backend so a fresh install needs neither
Docker nor a system service. SearXNG is vendored unmodified at a pinned commit;
this script downloads that exact source, installs it into a throwaway build
venv, and freezes it with PyInstaller under the target-triple name Tauri's
`externalBin` loader expects.

Why a second binary rather than a module in the pipeline sidecar: a search
engine that crashes must not take writing down with it, and the two have no
shared state. Tauri already knows how to ship and reap a sidecar; reusing that
is less machinery than a second supervisor inside the Python process.

AGPL-3.0-or-later: SearXNG is unmodified. The exact source archive and its
SHA-256 are named below, so the corresponding source for any binary built here
is recoverable byte-for-byte.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUI = ROOT / "gui"
BINARIES = GUI / "src-tauri" / "binaries"
BUILD = ROOT / "build"
CACHE = BUILD / "searxng-cache"
SOURCE = BUILD / "searxng-src"
VENV = BUILD / "searxng-venv"
WORK = BUILD / "searxng-work"
DIST = BUILD / "searxng-dist"

# Pinned upstream. Update both values together; the hash is checked before
# anything is extracted, so a changed upstream archive is a build failure rather
# than a silent difference in what ships.
SEARXNG_COMMIT = "b5605b8f2fa2591108ab8e3f4fc16e88f7d66fe4"
SEARXNG_SHA256 = "dfd971b8ee0fb5e148ba62abd3c65353605130efd68bb3139bc94ee2da0fee8c"
SEARXNG_URL = (
    "https://github.com/searxng/searxng/archive/"
    f"{SEARXNG_COMMIT}.tar.gz"
)
SEARXNG_VERSION = "2026.11.26"

PYINSTALLER = "pyinstaller==6.22.3"
EXCLUDES = ["tkinter", "pytest", "matplotlib", "torch"]

ENTRY = '''\
"""Entry point for the bundled SearXNG server.

SearXNG is unmodified upstream code. This file only starts its Flask
application against the settings file Quill writes at run time.
"""
from searx.webapp import run

if __name__ == "__main__":
    run()
'''


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
    out = subprocess.run(
        [rustc, "-vV"], check=True, capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        if line.startswith("host: "):
            return line.split(": ", 1)[1].strip()
    raise SystemExit("could not read the host triple from rustc -vV")


def run(args: list[str], **kwargs) -> None:
    print("   ", " ".join(str(part) for part in args[:6]))
    subprocess.run(args, check=True, **kwargs)


def download() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / f"searxng-{SEARXNG_COMMIT}.tar.gz"
    if archive.is_file() and sha256(archive) == SEARXNG_SHA256:
        return archive
    print(f"==> downloading SearXNG {SEARXNG_VERSION} ({SEARXNG_COMMIT[:8]})")
    tmp = archive.with_suffix(".part")
    with urllib.request.urlopen(SEARXNG_URL, timeout=120) as response:
        tmp.write_bytes(response.read())
    actual = sha256(tmp)
    if actual != SEARXNG_SHA256:
        tmp.unlink(missing_ok=True)
        raise SystemExit(
            f"error: SearXNG archive checksum mismatch\n"
            f"  expected {SEARXNG_SHA256}\n"
            f"  got      {actual}\n"
            f"  url      {SEARXNG_URL}"
        )
    tmp.replace(archive)
    return archive


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def extract(archive: Path) -> None:
    if SOURCE.exists():
        shutil.rmtree(SOURCE)
    with tarfile.open(archive) as tar:
        tar.extractall(BUILD, filter="data")
    top = next(BUILD.glob(f"searxng-{SEARXNG_COMMIT}*"))
    top.rename(SOURCE)


def venv_python() -> Path:
    candidate = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return candidate


def install() -> Path:
    """Create the build venv and return the installed `searx` directory."""
    if not venv_python().is_file():
        print(f"==> creating the build venv ({sys.version.split()[0]})")
        run(["uv", "venv", "--python", sys.executable, str(VENV)])
    python = str(venv_python())
    print("==> installing SearXNG requirements")
    run(
        ["uv", "pip", "install", "--python", python, "-r", str(SOURCE / "requirements.txt")],
    )
    # PyInstaller and setuptools go in before SearXNG because its setup.py is
    # run with --no-build-isolation (a build env would re-resolve the whole
    # dependency set) and that needs setuptools present in the venv.
    run(["uv", "pip", "install", "--python", python, PYINSTALLER, "setuptools"])
    run(
        [
            "uv", "pip", "install", "--python", python, "--no-deps",
            "--no-build-isolation", "--link-mode=copy", str(SOURCE),
        ],
    )
    out = subprocess.run(
        [python, "-c", "import searx, os; print(os.path.dirname(searx.__file__))"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return Path(out)


def freeze_version(package: Path) -> None:
    """Give the frozen build a version instead of shelling out to `git`.

    Upstream reads `searx.version_frozen` when it exists, which is exactly the
    case for a build from an archive: without it, every launch logs two git
    failures ("not a git repository") before the server starts. The string is
    derived from the same pinned commit as the download.
    """
    version = f"{SEARXNG_VERSION}+{SEARXNG_COMMIT[:7]}"
    frozen = package / "version_frozen.py"
    frozen.write_text(
        "# SPDX-License-Identifier: AGPL-3.0-or-later\n"
        "# Generated by Quill's build script; see gui/scripts/build-searxng.py.\n"
        f'VERSION_STRING = "{version}"\n'
        f'VERSION_TAG = "{version}"\n'
        f'DOCKER_TAG = "{version.replace("+", "-")}"\n'
        'GIT_URL = "https://github.com/searxng/searxng"\n'
        'GIT_BRANCH = "master"\n',
        encoding="utf-8",
    )


def build(package: Path) -> Path:
    for directory in (WORK, DIST):
        if directory.exists():
            shutil.rmtree(directory)
    WORK.mkdir(parents=True)
    entry = WORK / "quill_searxng.py"
    entry.write_text(ENTRY, encoding="utf-8")

    pyinstaller = VENV / (
        "Scripts/pyinstaller.exe" if os.name == "nt" else "bin/pyinstaller"
    )
    add = os.pathsep
    args = [
        str(pyinstaller),
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name", "quill-searxng",
        "--collect-all", "searx",
        # Engines are loaded from their file path at run time, not imported, so
        # PyInstaller cannot see them. They must exist as .py files on disk.
        "--add-data", f"{package / 'engines'}{add}searx/engines",
        "--add-data", f"{package / 'settings.yml'}{add}searx",
        "--add-data", f"{package / 'limiter.toml'}{add}searx",
        "--distpath", str(DIST),
        "--workpath", str(WORK),
        "--specpath", str(WORK),
    ]
    for module in EXCLUDES:
        args += ["--exclude-module", module]
    args.append(str(entry))

    print("==> freezing SearXNG (this takes a few minutes)")
    run(args)
    built = DIST / ("quill-searxng.exe" if os.name == "nt" else "quill-searxng")
    if not built.is_file():
        raise SystemExit(f"error: PyInstaller produced no binary in {DIST}")
    return built


def main() -> int:
    # `--ensure` skips the build when the binary is already there, which is what
    # a dev launch needs: Tauri requires every externalBin to exist, but
    # rebuilding a 60 MB server on every `tauri dev` would be absurd.
    BINARIES.mkdir(parents=True, exist_ok=True)
    target = BINARIES / f"quill-searxng-{target_triple()}"
    if "--ensure" in sys.argv and target.is_file():
        print(f"==> {target} is present; skipping the SearXNG build")
        return 0
    archive = download()
    extract(archive)
    package = install()
    freeze_version(package)
    built = build(package)
    shutil.copy2(built, target)
    target.chmod(0o755)
    size = target.stat().st_size / (1024 * 1024)
    print(f"==> wrote {target} ({size:.1f} MiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
