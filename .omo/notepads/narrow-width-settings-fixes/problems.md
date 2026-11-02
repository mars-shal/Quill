# Problems — narrow-width-settings-fixes

Unresolved blockers and technical debt discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## UNRESOLVED — vertical text smear on the Settings tab bar (WebKitGTK)

**Status:** blocked on the owner. Cannot be settled from this machine.

Owner reports the tab labels ("Assistant | Appearance | Writing") rendering as
vertically smeared, streaked glyphs. Distinct from the click-eater, which is
fixed. `settings-render-smear.md` carries the full investigation.

**Ruled out — do not re-investigate any of these:**

- `--brand-filter: invert(1)` on `.library-wordmark` — forced off, smear persists
- The Inter webfont — `font-family: sans-serif` smears identically
- Theme — the light theme smears too
- `--brand-filter-opacity`, `backdrop-filter` (already removed app-wide)
- Any `filter`/`transform` on a `.settings-*` rule
- Layout/geometry — the tab measures a correct `95x27` at `12px`/`600`,
  `line-height: normal`, in every variant tested

**Therefore nothing in the app's CSS has been shown to cause any smearing.** That
leaves open, and now under-weighted, the simplest explanation: **the screenshot
was captured at a different scale than the window** (GNOME Screenshot / X11
`import` under fractional HiDPI scaling). Check a capture at 100% zoom before
hunting further in CSS.

**Also unresolved:** fractional GTK display scaling was never measured, because
headless has no display scaling. Needs `devicePixelRatio` and
`screen.width / window.innerWidth` read from the real Tauri webview.

**Why it could not be reproduced here:** jsdom has no CSS. Chromium renders it
clean. Playwright's bundled WebKit only launches after stubbing three libraries
into a shared cache, which invalidates its rendering output — do not retry that
avenue (see `learnings.md`).

**Next action:** paste the console block in `settings-render-smear.md` into the
Tauri devtools window. That is the only trustworthy instrument available.
