#!/usr/bin/env bash
# Runs the Tauri CLI with the Rust toolchain on PATH.
#
# Rust is installed via rustup into ~/.cargo, which is not always on PATH for
# non-login shells, IDE terminals, or CI runners. Sourcing it here means the dev
# and build commands work regardless of how the shell was started.
set -euo pipefail

# Snap-packaged terminals (Ghostty in snap form on this machine) export their
# own GTK helper paths into every process they spawn. Inside the snap that is
# valid; outside it breaks this app's GTK stack: the exported
# GDK_PIXBUF_MODULE_FILE points at the snap's loader cache, whose SVG loader
# needs GLIBC 2.38 while this system ships 2.35, so GTK dies before a window
# ever paints ("ensure_surface_for_gicon" assertion, observed 2026-10-30
# 12:51). Drop only the values that came from /snap -- an operator's explicit
# non-snap setting is left untouched and still wins.
# "Came from the snap" has two spellings: under /snap itself, and the loader
# cache the snap's gdk-pixbuf generates under $HOME/snap/ghostty/common/.cache
# -- both name the snap's GLIBC-2.38 loaders. Both drop; an operator's explicit
# non-snap setting (e.g. the system loaders.cache) is left untouched and wins.
for _var in GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR GIO_MODULE_DIR GTK_PATH LOCPATH; do
  case "${!_var:-}" in /snap/*|*/snap/ghostty/*) unset "$_var" ;; esac
done

# LD_LIBRARY_PATH needs filtering rather than a straight unset: the snap
# wrapper exports it, and gdk-pixbuf resolves its loader directory from where
# libgdk_pixbuf was actually found, so one /snap entry routes every GTK app
# started from that terminal into the snap's GLIBC-2.38 loaders. Proven with
# gdk-pixbuf-query-loaders under a snap LD path on 2026-10-30, which dies the
# same "GLIBC_2.38 not found" death this machine's quill bailed on. Non-snap
# entries are preserved; the user may have put legitimate ones there.
if [[ "${LD_LIBRARY_PATH:-}" == *"/snap/"* ]]; then
  _clean=""
  IFS=':' read -ra _lps <<< "${LD_LIBRARY_PATH}"
  for _p in "${_lps[@]}"; do
    case "$_p" in /snap/*) ;; *) _clean="${_clean:+$_clean:}$_p" ;; esac
  done
  if [ -n "$_clean" ]; then
    LD_LIBRARY_PATH="$_clean"
    export LD_LIBRARY_PATH
  else
    unset LD_LIBRARY_PATH
  fi
fi

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found. Install Rust from https://rustup.rs" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# WebGL2 for the assistant panel's liquid-metal send button.
#
# The panel's effects need a real GL context, and WebKitGTK will silently drop
# WebGL when its GPU process cannot obtain one. The default here is hardware
# GL: on a machine with a usable GPU there is no reason to do anything else.
#
# llvmpipe is only a fallback for the one case where hardware GL cannot work --
# no render node to hand WebKit at all, as in a bare VM or container, where
# `ls /dev/dri/renderD*` finds nothing. There, Mesa has nothing to be hardware
# about and `LIBGL_ALWAYS_SOFTWARE` makes it fall back to llvmpipe, which
# always yields a context. Where a render node exists the variable is left
# alone so the GPU is actually used.
#
# `WEBKIT_DISABLE_DMABUF_RENDERER` stays as it is: the DMA-BUF path does not
# degrade, it fails outright ("unable to construct a complete framebuffer"),
# which is a different problem from quality.
#
# Neither weakens the webview sandbox, and both are only defaults here, so an
# explicit export still wins, in either direction:
#
#     LIBGL_ALWAYS_SOFTWARE=0 npm run tauri:dev   # force hardware off (no-op on a GPU machine)
#     LIBGL_ALWAYS_SOFTWARE=1 npm run tauri:dev   # force llvmpipe even with a GPU
#
# `ls` failing inside an `if` condition does not trip `set -e`.
if ! ls /dev/dri/renderD* >/dev/null 2>&1; then
  export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
fi
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"

# WebKitGTK text rendering workaround for fractional scaling/compositing artifacts
# (see .omo/plans/settings-render-smear.md). If glyphs appear smeared/vertically
# stretched on Linux with fractional display scaling, try:
#   WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri:dev
if [ -n "${WEBKIT_DISABLE_COMPOSITING_MODE:-}" ]; then
  export WEBKIT_DISABLE_COMPOSITING_MODE
fi

exec npx --no-install tauri "$@"
