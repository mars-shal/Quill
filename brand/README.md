# Quill brand kit

Source of truth for the rebrand assets supplied with the project.

- `logo/` — colour, mono, inverse and reversed lockups, SVG and 2048px PNG.
- `mockups/` — app icon, social, dock, website, catalogue and print mockups.
- `quill-brand-book.pdf` — the four-page brand book (palette, contrast and usage).
- `quill-brand-board.png` — the flattened brand board.
- `quill-browser-tab.png` — the browser-tab reference.
- `brand.json` — the Recraft brand sheet the kit was generated from.

Palette of record:

| Role | Value |
| --- | --- |
| Logo / primary | `#1A1A1A` |
| Ink | `#0F0F0F` |
| Paper / background | `#F9F9F9` |
| Accent | `#6B7280` |

The app runtime copies the logos it serves into `gui/public/brand/`; the
top-level kit is the archive, not a second runtime source. `gui/public/quill-brand.png`
and `gui/public/quill-mark.png` are the cropped wordmark and the reversed app
icon used by the live UI, and `gui/scripts/make-icon.py` builds the Tauri icon
source from the 2048px reversed master.
