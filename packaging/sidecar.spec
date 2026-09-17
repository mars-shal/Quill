# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Quill GUI sidecar.
#
# Bundles the FastAPI server (quill_engine.api.server:main) into a single
# self-contained executable that Electron spawns as the local backend.
# CUDA-only giants (nvidia·, triton) are excluded: the sidecar runs on
# user machines where CPU embedding is the norm. `excludes` in Analysis is
# not enough on its own (the torch hook re-collects the nvidia-* packages as
# data), so the resolved binaries/datas TOCs are also filtered below — between
# the two, ~2.0 GB of CUDA blobs are cut from the bundle. torch itself stays
# (sentence-transformers needs it for retrieval/embedding); model weights are
# downloaded at runtime to ~/.cache, never bundled.
#
# Build (from repo root):  .venv/bin/pyinstaller packaging/sidecar.spec

from PyInstaller.utils.hooks import collect_submodules, collect_data_files
from PyInstaller.building.datastruct import TOC

block_cipher = None


def _drop_entries(toc, *prefixes):
    """Filter a TOC (binaries/datas) to drop entries whose destination path
    starts with any prefix.

    Analysis(excludes=...) only stops Python *modules* from being pulled in;
    it does NOT stop hooks from re-collecting packages as binaries/data. The
    torch hook re-adds every installed nvidia-* CUDA package as data, so the
    module excludes alone leave ~2.0 GB of CUDA blobs in the bundle. Filtering
    the resolved TOCs here is the reliable cut.
    """
    return TOC(t for t in toc if not t[0].startswith(prefixes))


def _drop_cuda_libs(toc):
    """Drop torch's CUDA-only native libs (libtorch_cuda*, c10_cuda, nvrtc,
    nvshmem). They are never loaded on the CPU-only inference path, and are
    useless the moment the nvidia/* data dirs are gone.
    """
    return TOC(
        t
        for t in toc
        if not (
            t[0].startswith("torch/lib/")
            and any(s in t[0] for s in ("cuda", "nvrtc", "nvshmem"))
        )
    )

hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("starlette")
    + collect_submodules("sentence_transformers")
    + collect_submodules("websockets")
    + collect_submodules("fastapi")
)

datas = collect_data_files("markitdown")

excludes = [
    # GPU-only runtime piles nobody needs on a laptop server. The module
    # excludes alone do NOT remove them from the build (torch's hook
    # re-collects the nvidia-* packages as data) — the _drop_entries TOC
    # filter below is what actually strips them. torch stays; it degrades
    # to CPU inference. ~2.0 GB of CUDA blobs cut from the bundle.
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

# Cut the CUDA blobs from the resolved collections (excludes alone don't
# stop the torch hook from re-adding them). Must happen before EXE/COLLECT:
# the nvidia/triton package trees (~2.0 GB) and torch's own CUDA-native
# runtime libs (~0.5 GB). torch stays on the CPU path only.
a.binaries = _drop_cuda_libs(_drop_entries(a.binaries, "nvidia", "triton"))
a.datas = _drop_entries(a.datas, "nvidia", "triton")

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