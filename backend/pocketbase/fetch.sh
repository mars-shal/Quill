#!/usr/bin/env bash
# Downloads the pinned PocketBase build and verifies it.
#
# The binary is deliberately not committed: it is 32 MB of platform-specific
# executable, and a checksum is a stronger guarantee than a committed blob that
# nobody re-verifies. Bump POCKETBASE_VERSION and the two digests together.
set -euo pipefail

POCKETBASE_VERSION="0.40.4"
# sha256 of pocketbase_0.40.4_linux_amd64.zip
ZIP_SHA256="9042ec818570e79c3628dadcd0a756c1496d9e1173918ec409d133c02f82e5fa"
# sha256 of the extracted binary
BIN_SHA256="14ec215bc7aaceda356713cd4b29aa7fcfee854ff2ae1151c5ddba41b43aec8a"

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/bin"
archive="$(mktemp -t pocketbase-XXXXXX.zip)"
trap 'rm -f "$archive"' EXIT

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  target="linux_amd64" ;;
  Linux-aarch64) target="linux_arm64" ;;
  Darwin-arm64)  target="darwin_arm64" ;;
  Darwin-x86_64) target="darwin_amd64" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

url="https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_${target}.zip"
mkdir -p "$out"

# GitHub occasionally truncates a large release asset mid-transfer, so resume
# until the archive passes its integrity test.
echo "downloading $url"
for attempt in 1 2 3 4 5; do
  curl -sSL -C - -o "$archive" "$url" || true
  if unzip -tq "$archive" >/dev/null 2>&1; then break; fi
  echo "  truncated, resuming (attempt $attempt)"
done

# The digest is only asserted on the linux/amd64 build, which is the pinned one.
if [ "$target" = "linux_amd64" ]; then
  echo "${ZIP_SHA256}  ${archive}" | sha256sum --check --status \
    || { echo "checksum mismatch for the release archive" >&2; exit 1; }
fi

unzip -oq "$archive" -d "$out"
chmod +x "$out/pocketbase"

if [ "$target" = "linux_amd64" ]; then
  echo "${BIN_SHA256}  ${out}/pocketbase" | sha256sum --check --status \
    || { echo "checksum mismatch for the binary" >&2; exit 1; }
fi

"$out/pocketbase" --version
