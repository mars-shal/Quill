# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Quill GUI sidecar.
#
# Bundles the FastAPI server (quill_engine.api.server:main) into a single
# self-contained executable that Electron spawns as the local backend.
# CUDA-only giants (nvidia·, triton) are excluded: the sidecar runs on
# user machines where CPU embedding is the norm, and excluding them cuts
# ~3.4 GB out of the bundle. torch itself stays (sentence-transformers
# needs it for retrieval/embedding); model weights are downloaded at
# runtime to ~/.cache, never bundled.
#
# Build (from repo root):  .venv/bin/pyinstaller packaging/sidecar.spec

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("starlette")
    + collect_submodules("sentence_transformers")
    + collect_submodules("websockets")
    + collect_submodules("fastapi")
)

datas = collect_data_files("markitdown")

excludes = [
    # GPU-only runtime piles nobody needs on a laptop server (they drag in
    # ~3.4 GB of CUDA blobs). torch stays; it degrades to CPU inference.
    "nvidia",
    "triton",
    # UI-only modules that bloat a server bundle without being reachable:
    # exclude ONLY ones the import graph proves dead. (questionary must stay —
    # orchestrator imports questionnaire at module level even though the API
    # path never prompts.)
]

a = Analysis(
    ["run_sidecar.py"],
    pathex=[".."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="quill-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="quill-sidecar",
)