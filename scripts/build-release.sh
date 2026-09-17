#!/usr/bin/env bash
# Release build for one platform. Run ON the target OS:
#   scripts/build-release.sh linux | mac | win
#
# Cross-compiling is not possible here: PyInstaller and electron-builder
# both produce native artifacts, so each OS must build its own package
# (CI runs all three in a matrix). Produces:
#   linux -> gui/release/*.AppImage
#   mac   -> gui/release/*.dmg
#   win   -> gui/release/*.exe  (NSIS installer)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLATFORM="${1:-}"
case "$PLATFORM" in
  linux|mac|win) ;;
  "") echo "usage: $0 <linux|mac|win>" >&2; exit 1 ;;
  *) echo "unknown platform: $PLATFORM (use linux|mac|win)" >&2; exit 1 ;;
esac

# venv layout differs by OS (bin/python on unix, Scripts/python.exe on win).
PYTHON="$ROOT/.venv/bin/python"
[ -x "$PYTHON" ] || PYTHON="$ROOT/.venv/Scripts/python.exe"
[ -x "$PYTHON" ] || { echo "no venv python at $ROOT/.venv (bin or Scripts) — run: uv venv .venv && uv pip install -e '.[dev]'" >&2; exit 1; }

echo "==> [1/4] icon"
"$PYTHON" "$ROOT/scripts/make_icon.py"

echo "==> [2/4] sidecar (PyInstaller)"
command -v pyinstaller >/dev/null 2>&1 || "$PYTHON" -m pip install pyinstaller
(cd "$ROOT" && "$PYTHON" -m PyInstaller --noconfirm --distpath "$ROOT/gui/resources" packaging/sidecar.spec)

echo "==> [3/4] electron build"
(cd "$ROOT/gui" && npm run build)

echo "==> [4/4] electron-builder ($PLATFORM)"

case "$PLATFORM" in
  linux)
    BUILDER_ARGS=(--linux AppImage)
    ;;
  mac)
    BUILDER_ARGS=(--mac dmg)
    ;;
  win)
    BUILDER_ARGS=(--win nsis)
    ;;
esac

(
  cd "$ROOT/gui"
  npx electron-builder --publish never "${BUILDER_ARGS[@]}"
)

echo "==> done. Artifacts in gui/release/ ($PLATFORM)."