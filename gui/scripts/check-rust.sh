#!/usr/bin/env bash
# Runs the Rust quality gates. Sources the rustup environment so it works from a
# shell where cargo is not yet on PATH (e.g. a fresh CI login shell).
set -euo pipefail

# shellcheck disable=SC1091
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi

cd "$(dirname "$0")/../src-tauri"

cargo fmt --check
echo "==> rustfmt clean"

cargo clippy --all-targets -- -D warnings
echo "==> clippy clean"

cargo test
echo "==> cargo test passed"
