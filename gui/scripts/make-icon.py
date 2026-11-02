#!/usr/bin/env python3
"""Build a square 1024x1024 source icon for `tauri icon` from the Quill brand mark.

The brand mark is 185x194 (not square), so it is centred on a transparent square
canvas with generous padding. The result is written to src-tauri/icons/source.png
and is used as the input for `npm run tauri icon`.
"""

from pathlib import Path

from PIL import Image

GUI = Path(__file__).resolve().parents[1]
MARK = GUI / "quill-mark.png"
OUT = GUI / "src-tauri" / "icons" / "source.png"

CANVAS = 1024
INNER = 620  # glyph size, leaving safe padding around the mark


def main() -> None:
    mark = Image.open(MARK).convert("RGBA")

    # Scale the mark to the inner box while preserving aspect ratio.
    scale = INNER / max(mark.size)
    resized = mark.resize(
        (max(1, round(mark.width * scale)), max(1, round(mark.height * scale))),
        Image.LANCZOS,
    )

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    offset = (
        (CANVAS - resized.width) // 2,
        (CANVAS - resized.height) // 2,
    )
    canvas.alpha_composite(resized, offset)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT)
    print(f"wrote {OUT} ({canvas.size[0]}x{canvas.size[1]})")


if __name__ == "__main__":
    main()
