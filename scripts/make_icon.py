"""Generate the Quill app icon (1024x1024 PNG) used by electron-builder.

electron-builder auto-converts a single build/icon.png into the platform
formats it needs (.icns on macOS, .ico on Windows, .png on Linux).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent.parent / "gui" / "build" / "icon.png"
SIZE = 1024
ACCENT = (193, 95, 60, 255)          # warm editorial #c15f3c
PAPER = (244, 243, 238, 255)         # paper #f4f3ee
INK = (38, 32, 28, 255)              # near-black ink


def feather(d: ImageDraw.ImageDraw, cx: int, cy: int, scale: float, color: tuple) -> None:
    """Draw a stylized quill feather pointing up-right. Crude but readable at icon size."""
    s = scale
    # Shaft
    d.line([(cx, cy + 180 * s), (cx + 60 * s, cy - 220 * s)], fill=color, width=int(28 * s))
    # Barbs (left side of shaft, fanning out)
    for i, (dx, dy, w) in enumerate(
        [
            (-10, -170, 26), (-30, -140, 24), (-55, -100, 22), (-70, -55, 20),
            (-75, -10, 18), (-70, 35, 16), (-55, 75, 14), (-35, 110, 12),
            (-15, 140, 10), (0, 165, 9),
        ]
    ):
        d.line(
            [(cx, cy + 160 * s), (cx + dx * s, cy + dy * s)],
            fill=color,
            width=int(w * s),
        )
    # Nib tip
    d.line([(cx + 5 * s, cy + 185 * s), (cx + 40 * s, cy + 245 * s)], fill=color, width=int(20 * s))


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-rect background with the accent color (slight vertical gradient).
    d.rounded_rectangle([16, 16, SIZE - 16, SIZE - 16], radius=220, fill=ACCENT)
    for y in range(SIZE // 2, SIZE - 16):
        d.line(
            [(16, y), (SIZE - 16, y)],
            fill=(int(ACCENT[0] * (0.85 + 0.15 * (y - SIZE / 2) / (SIZE / 2))), ACCENT[1], ACCENT[2], 255),
        )

    # Quill feather in paper color.
    feather(d, SIZE // 2, SIZE // 2, 1.15, PAPER)

    # A subtle paper dot as the "ink drop" under the nib.
    d.ellipse(
        [SIZE // 2 + 90, SIZE - 300, SIZE // 2 + 170, SIZE - 220],
        fill=PAPER,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()