#!/usr/bin/env python3
"""Build the square source icon for `tauri icon` from the Quill brand icon.

The brand kit ships a reversed square (ink cloth with the light wordmark), so
the source is already square. It is scaled full-bleed rather than padded: the
platform supplies its own mask and margin, and adding a second margin here made
the tile small inside an already-rounded macOS icon.
"""

from pathlib import Path

from PIL import Image

GUI = Path(__file__).resolve().parents[1]
MARK = GUI / "public" / "brand" / "quill-reversed-2048.png"
OUT = GUI / "src-tauri" / "icons" / "source.png"

CANVAS = 1024


def main() -> None:
    mark = Image.open(MARK).convert("RGBA")
    resized = mark.resize((CANVAS, CANVAS), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    resized.save(OUT)
    print(f"wrote {OUT} ({resized.size[0]}x{resized.size[1]})")


if __name__ == "__main__":
    main()
