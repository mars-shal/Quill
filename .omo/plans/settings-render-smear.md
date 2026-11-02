# Settings render smear — diagnostic plan

- [x] **FIXED 2026-10-08 — dead tabs were a CSS click-eater, not WebKit.** Root cause:
  `.app-shell` is `position: relative; z-index: auto`, so it is **not** a stacking context and
  its children resolve in the root one. `.settings-layer` (the whole Settings page) is
  `position: static; z-index: auto` and therefore paints at step 3 (in-flow blocks), while
  `.app-shell::before` — `position: absolute; inset: 0; z-index: 0`, full viewport — paints at
  step 6, **above the entire Settings page**. It had no `pointer-events` declaration, so it
  became a full-viewport click-eater. Its sibling `.app-shell::after` already had
  `pointer-events: none`; `::before` was simply missed. `.library-layer` sits at `z-index: 1`
  (step 7), which is why the sidebar's own Settings button worked and only the page *inside*
  was dead.

  Fix: `pointer-events: none` on `.app-shell::before`, matching `::after`. Purely additive.

  Proof, in real Chromium over CDP against `http://127.0.0.1:1420/`, using real
  `Input.dispatchMouseEvent` at real viewport coordinates:

  | | before | after |
  | --- | --- | --- |
  | `elementFromPoint` over the Appearance tab | `DIV.app-shell` | `BUTTON#settings-appearance-tab` |
  | real mouse click | panels unchanged | `settings-appearance hidden:false` |

  **Why every earlier test missed it, and the lesson:** jsdom has no hit-testing at all, and
  `element.click()` dispatches the event straight at the node, bypassing the compositor
  entirely. So both the 5/5 jsdom test and my own Chromium `Runtime.evaluate`-driven click
  were worthless as hit-test evidence — they would have passed with the click-eater in place.
  Only `document.elementFromPoint` and real coordinate-based input exercise the path a user's
  mouse takes. **Do not use `element.click()` as click evidence again.**

  Guard added: `tests/app-shell-overlay.test.mjs` (7 tests) brace-matches the stylesheet and
  requires every full-viewport `::before`/`::after` overlay with a non-transparent background
  to declare `pointer-events: none`, naming the offending selector on failure. Verified it can
  actually fail by removing the declaration from a copy of the real sheet. Gate now
  **308 passing (203 + 76 + 29), 0 failing**.

- [~] **STILL BLOCKED — the vertical text smear.** A **separate** bug from the click-eater;
  the one-bug theory was wrong. Owner reports glyphs stretched vertically with horizontal
  striations, and the tab strip rendered as tall boxes. Chromium measures `h=27` and renders
  clean in all three themes, so it is WebKitGTK-specific. Ranked candidates, from Oracle:
  1. **Fractional GTK display scaling** → render-surface scale mismatch. Strongest.
  2. **`filter: invert(1)` on `.library-wordmark`** — **code fact now confirmed**, see below.
  3. The screenshot itself was captured at a different scale than the window.

  **Candidate 2 confirmed in source (styles.css):**
  - `:105` `--brand-filter: none;` (light/paper default)
  - `:381-382` inside the **night** theme block only: `--brand-filter: invert(1);`
    `--brand-filter-opacity: 0.94;`
  - `:491` `.library-wordmark { filter: var(--brand-filter); opacity: var(--brand-filter-opacity, 1); }`
  - `:488` `.library-wordmark { display: block; width: 64px; height: auto; }`

  That `<img>` lives in `.library-brand-row` → `.library-sidebar` → `.library-layer`, and while
  Settings is open `.library-layer` is `position: relative; width: 218px; z-index: 1` —
  i.e. **a `filter`ed element living in a z-index:1 layer, directly above the settings page.**
  A CSS `filter` forces a render surface in WebKitGTK, and render surfaces are allocated in
  tiles, so a small filtered element can affect neighbours outside its own box. This is the only
  `filter` in the entire sheet applied to a visible element (the other two hits are the token
  definitions and a comment).

  **Uncertainty, stated honestly:** `.library-wordmark` is 64px wide and `.library-layer` only
  218px, while the tab strip begins further right (x≈330 at a 1280px viewport in Chromium). So
  whether the affected tile actually reaches the tab bar is **not established**. Confirmed code
  fact ≠ confirmed cause.

  Ruled out: `will-change` on `.editor-panel` (inside `.editor-layer`, which is `display: none`
  while Settings is open), the `hidden` toggling, the removed `backdrop-filter`, and any
  `filter`/`transform` on a `.settings-*` selector (the only hit is `transform: none` at :1084).

  **Unblock with these — no restart needed for the first one.**

  1. **Live isolation of the filter** (Tauri devtools console, dark theme). Clear only that
     one filter and watch the tab strip:
     ```js
     const w = document.querySelector('.library-wordmark');
     console.log('before', getComputedStyle(w).filter);
     w.style.filter = 'none';
     console.log('after ', getComputedStyle(w).filter);
     ```
     If the smear clears, candidate 2 is **confirmed** and the fix is to stop filtering the
     wordmark in dark themes (the wordmark PNG could be shipped pre-inverted instead). If
     nothing changes, candidate 2 is eliminated outright.

  2. **Fractional scaling** (same console): `devicePixelRatio`, then
     `screen.width / window.innerWidth`. A ratio ≠ 1 confirms candidate 1.

  3. If 1 is negative, the light-theme A/B is automatic anyway: `--brand-filter` is `none` in
     light/paper and `invert(1)` only in night, so switching theme isolates it with no
     override. Worth doing anyway for a clean second data point.

  **THE CHECK — paste this whole block into the Tauri devtools console, in the dark theme,
  with Settings open on the tab bar. One paste, everything I need:**

  ```js
  (() => {
    const out = {};
    // 1. fractional display scaling?
    out.dpr = devicePixelRatio;
    out.screenToViewportRatio = +(screen.width / innerWidth).toFixed(3);

    // 2. is the night-theme filter live on the wordmark?
    const w = document.querySelector('.library-wordmark');
    out.wordmarkFilter = w ? getComputedStyle(w).filter : 'NO WORDMARK';

    // 3. do the tabs hit-test now that the click-eater is fixed?
    const t = document.querySelector('#settings-appearance-tab');
    if (t) {
      const r = t.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      out.tabHitTest = el ? (el.id || el.tagName + '.' + el.className) : 'null';
      out.hitIsTab = !!(el && el.id === 'settings-appearance-tab');
      out.tabBox = Math.round(r.width) + 'x' + Math.round(r.height);
    } else out.tabHitTest = 'NO TAB';

    // 4. what geometry is actually being painted at the strip?
    const strip = document.querySelector('.settings-tabbar');
    out.stripBox = strip ? (() => { const r = strip.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)} @ ${Math.round(r.x)},${Math.round(r.y)}`; })() : 'GONE';

    console.table(out);
    console.log('NEXT: run  document.querySelector(".library-wordmark").style.filter = "none"');
    console.log('then look at the tab bar without reloading.');
  })()
  ```

  **Reading the result:**
  - `screenToViewportRatio` ≠ 1 → fractional scaling, candidate 1 confirmed.
  - `hitIsTab` false → something is still eating clicks; report `tabHitTest` verbatim.
  - `tabBox` much taller than ~`95x27` → the strip itself is being stretched, which localises it
    to layout rather than rasterisation.
  - Clearing `.library-wordmark`'s filter clears the smear → candidate 2 confirmed, and the fix
    is to stop filtering the wordmark in dark themes (ship a pre-inverted wordmark PNG instead).
    Nothing changing → candidate 2 eliminated.

  **Apply nothing blind.** `zoom: 1` is *not* a safe mitigation here — on a fractional-scale
  GTK display it can cause the very artifact it appears to fix.

  **Reproduction avenues already exhausted — do not retry:** jsdom (no CSS, structurally
  blind); real Chromium (drives fine with zero deps via Node 24's global `WebSocket` against
  the cached `~/.cache/ms-playwright/chromium-1243`, but renders clean, so no repro);
  WebKitGTK itself cannot be launched here — `libwebkit2gtk-4.1.so.0` is installed but there is
  no `WebKitWebDriver`, no `gi.repository.WebKit2` bindings, and no `xvfb`.

  **animate-ui: recommended against.** It is a shadcn registry of animated components
  (`npx shadcn@latest add …`), framer-motion based. It cannot fix a rasterisation fault, it
  would add composited layers and likely worsen candidates 1 and 2, and it contradicts the
  documented decision to restrict motion to the assistant panel and `ChatPanel`. A CSS
  transition on the existing pill is the proportionate alternative — `.settings-tab` already
  transitions `color` and `background`.

  **What is now RULED OUT for (2) — do not re-investigate any of it.** Verified against the
  live dev server, not by reading:
  - `tests/settings-tabs.test.mjs` (new, 5/5 pass) asserts `panel.hidden === true` before the
    click and `hidden === false` on the *same node* after, plus the `aria-selected` flip both
    ways. Opposite expectations on one node ⇒ the click genuinely mutates the DOM.
  - **Reproduced in real Chromium over CDP** against `http://127.0.0.1:1420/`. Clicking
    Appearance gives `settings-assistant hidden:true, settings-appearance hidden:false,
    settings-writing hidden:true`. Tabs measure `h=27`, `font-size 12px`.
  - **Chromium renders it correctly in light AND night theme** — screenshots
    `/tmp/opencode/tabbar-light.png`, `tabbar-night.png`, `tabbar-paper.png`. The night
    render is the same dark theme as the reported screenshot and is clean.
  - Ancestor probe from `.app-shell` down to `.settings-tab`: **no `transform`, no `filter`,
    no `will-change`, no `zoom`, no `backdrop-filter` anywhere.** Only `overflow:hidden` on
    `.app-shell` and `body`.
  - `document.fonts.check('12px Inter')` true, all 7 self-hosted faces report `loaded`,
    `devicePixelRatio: 1`, `zoom: 1`.
  - The JSX wiring (`onClick` → `setActiveTab`, `hidden={section.id !== activeTab}`) and the
    `.settings-section[hidden] { display: none }` guard are both correct.

  **Working theory — ONE bug, not two.** Tauri on Linux renders through **WebKitGTK**, not
  Chromium. A layer WebKitGTK rasterises at the wrong scale will also *hit-test* at the wrong
  scale, so one defect explains both the smeared glyphs and the dead tabs without any of the
  tab code being wrong. Supporting detail: the reported screenshot shows the tabs as **tall
  boxes**, whereas Chromium measures `h=27` — so the strip is being *stretched* in that
  renderer and the text scaled with it.

  **animate-ui assessed and recommended against** (asked about on 2026-10-08). It is a
  shadcn registry of animated components (`npx shadcn@latest add …`), framer-motion based.
  It cannot fix a text-rasterisation fault; it would add composited layers and so likely
  *worsen* this artefact; and it contradicts the documented decision to restrict motion to the
  assistant panel and `ChatPanel` after tile springs were stripped out. A CSS transition on the
  existing pill is the proportionate alternative — `.settings-tab` already transitions
  `color` and `background`.

  **REPRODUCTION ATTEMPTED AND FAILED — results were self-contradictory, treat the smear as
  UNDIAGNOSED.** Recorded so nobody repeats it:

  - jsdom: no CSS, structurally blind.
  - Real Chromium over CDP (zero deps, Node 24 global `WebSocket` + the cached
    `~/.cache/ms-playwright/chromium-1243`): drives fine, renders the tab bar clean in light,
    night and paper, real clicks land. No repro.
  - Playwright's bundled **WebKit 26.6** (`webkit-2359`) was made to launch after
    `npx playwright install webkit` left three libs unresolved. Its
    `minibrowser-wpe/MiniBrowser` is a **shell wrapper that hard-sets**
    `LD_LIBRARY_PATH="${MYDIR}/lib:${MYDIR}/sys/lib"` (line 6), discarding any exported path —
    so the only way in was to compile stubs for `libgstcodecparsers-1.0.so.0`,
    `libbacktrace.so.0` and `libjxl.so.0.8` (gcc, no root) and copy them **into that shared
    cache directory**. Stubs have since been removed and the removal verified; the cache holds
    only Playwright's own files and WebKit is blocked again.

  - **Why that invalidates everything it produced:** the engine was running on three fake
    shared libraries, one of them `libjxl` — an *image codec*. Any symbol resolved against a
    stub is undefined behaviour. And the observations contradicted each other:
    the app's tab bar smeared, while a control using the same font, size (12px) and weight
    (600) rendered clean; a six-rung CSS ladder smeared at rung 3; and a seven-way tag test
    (span / button / div / input / `appearance:none`, all app-styled) rendered **entirely
    clean**. Those cannot all be true of one real defect. The "REPRODUCED" claim made from that
    run was wrong and is retracted.

  - **Do not retry this avenue.** It requires tampering with a shared tool cache to produce an
    engine whose rendering cannot be trusted.

  **UPSTREAM MATCH FOUND 2026-10-08 — this is a known WebKitGTK bug class, not app CSS.**
  Web research surfaced four independent reports with the same signature:

  - **WebKit bug 263645 — "[GTK] The rendering of the fonts look blurred … if I launch the
    application with `WEBKIT_DISABLE_COMPOSITING_MODE=1` they look perfect."** Blurred glyphs
    traced to WebKitGTK's compositing path. Fixed by disabling compositing. This is the single
    most actionable item found and it needs no code change.
  - **WebKit bug 271714 — "[GTK] Blurriness with fractional scaling."** Reported at **125%
    fractional scaling**; affects *only* webkitgtk apps, not other GTK apps on the same system,
    which is the same asymmetry that made this look like an app bug here. Fixed upstream by
    WebKit PR #34556.
  - **dream-num/univer#6457** — canvas text fuzzy at `devicePixelRatio` **1.25** on
    Linux/Wayland, explicitly via **"WebKitGTK (via Tauri 2.x desktop app)"** — the same stack
    as this app. Integer scales (1.0, 2.0) render crisply; fractional ones do not.
  - **KDE bug 479891** — "text glyphs … **vertically mis-aligned or squished** when using a
    fractional scale factor" at 125%/150%/175%. Qt rather than WebKit, but it establishes that
    vertical glyph smearing at fractional scale is a known failure mode across the Linux
    desktop stack, not something peculiar to this codebase.

  **Working conclusion:** the smear is fractional-display-scaling text rasterisation inside
  WebKitGTK. That is consistent with every negative result recorded above — no `filter`,
  transform, font choice, theme, or geometry in the app's CSS produced or removed it, which is
  exactly what you expect when the fault is in the engine's raster path rather than in CSS.

  **VERIFIED 2026-10-10 — the fix is live in the currently-running instance.** Read from
  `/proc/<pid>/environ` rather than inferred:

  ```
  pid 12667  started: Sat Oct 10 18:37:43 2026
    LIBGL_ALWAYS_SOFTWARE=<unset>
    WEBKIT_DISABLE_DMABUF_RENDERER=1
  scripts/tauri.sh last modified: 2026-10-08 18:25:43
  ```

  Two things follow, and only two:

  1. **The running app was launched two days after the `tauri.sh` change**, so it is executing
     the fixed script — not a stale shell.
  2. **`LIBGL_ALWAYS_SOFTWARE` is unset in it.** That is precisely what the new conditional
     emits on a machine with a render node. Before the change it would read `1`. So the forced
     llvmpipe path is **not** in play for this instance; it is running hardware GL.

  **What this does not establish:** whether the smear is still visible. That is still the owner's
  eyes only. But it does sharply split the remaining question:

  - **Smear gone in this instance** → the forced software renderer was the cause, this item
    closes, no further work.
  - **Smear still present in this instance** → the software-rasteriser hypothesis is
    **falsified**, since hardware GL was already active when it was captured. What remains is the
    fractional-scaling compositor bug (WebKit #263645 / #271714), which is upstream's, not ours.
    Do not go looking for a CSS cause again — that avenue is closed and was wrong twice.

  So the owner is not being asked to relaunch anything; they are being asked to look at a window
  that is already running the fix.

**ACTION, in order — none of these touch project code:**

  0. **First, just re-run `npm run tauri:dev` and look.** The `scripts/tauri.sh` fix recorded
     below landed *after* this list was first written and removes the forced software renderer on
     any machine that has a GPU. That is the cheapest test and it is now the default behaviour, so
     it needs no env var. **If the smear is gone, stop here and this whole item closes.**
  1. **Confirm the scale factor.** In the Tauri webview console:
     `devicePixelRatio` and `screen.width / window.innerWidth`. A fractional value such as
     `1.25` / `1.5` / `1.75` confirms it. `1` falsifies it.
  2. **Only if step 0 did not help**, try the documented compositing workaround:
     ```bash
     WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri:dev
     ```
     If that clears it, compositing is the cause and this is a working fix. Cost: compositing
     off, so expect some loss of smoothness on panel transitions; for a writing app that is a
     fair trade. `WEBKIT_DISABLE_DMABUF_RENDERER=1` is the alternative named in the same bug
     report — try it if the first does nothing.
  3. **Report upstream** if confirmed, referencing WebKit #263645 and #271714. This is not a
     Quill bug and upstream is where it belongs.

  **Do not apply any CSS mitigation.** `zoom: 1` in particular is not a safe guess here — on a
  fractional-scale display it can *cause* the artifact it appears to fix, and the whole point of
  the negative results above is that CSS is not where this lives.

- [x] **FIXED 2026-10-08 — `scripts/tauri.sh` was forcing software rendering on every machine,
  including ones with real GPUs.** Found while chasing the smear above, and a genuine defect
  independent of it.

  It defaulted `LIBGL_ALWAYS_SOFTWARE=1` unconditionally, pushing Mesa onto llvmpipe for WebKit's
  GPU process on *every* launch. Its own comment stated the intent — for "a VM or over a remote
  session, where the machine may well have a capable GPU … but the compositor cannot hand WebKit a
  context" — which is not the situation on an ordinary desktop.

  This machine, for the record: two render nodes (`/dev/dri/renderD128`, `renderD129`), Intel UHD
  Graphics 630 + Quadro T2000, `glxinfo` reporting `Mesa Intel(R) UHD Graphics 630` as a hardware
  renderer, `systemd-detect-virt` = `none`, no SSH. Hardware GL was working and being ignored.

  **Fix:** llvmpipe only when there is no render node to hand WebKit.

  ```bash
  if ! ls /dev/dri/renderD* >/dev/null 2>&1; then
    export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
  fi
  ```

  Verified all four branches against the real logic (not a paraphrase of it), `bash -n` clean:

  | case | result |
  | --- | --- |
  | GPU present, nothing exported | `<unset>` — hardware GL |
  | GPU present, caller `=1` | `1` — caller survives, not overwritten |
  | no GPU, nothing exported | `1` — llvmpipe fallback fires |
  | no GPU, caller `=0` | `0` — caller wins over the fallback |

  `WEBKIT_DISABLE_DMABUF_RENDERER` deliberately left unconditional: that path *fails outright*
  ("unable to construct a complete framebuffer") rather than degrading, which is a different
  problem from quality. Whether it deserves the same `/dev/dri/renderD*` gating is an open
  question, recorded as a follow-up rather than bundled in.

  Follow-up fixed: `src/platform/capabilities.js:37` told users `LIBGL_ALWAYS_SOFTWARE=1` was what
  `scripts/tauri.sh` "does by default", which this change made false. Reworded to say the script
  applies it automatically only where there is no GPU; the advice itself still holds because the
  fallback uses `${VAR:-1}` and a caller export wins.

  **Caveat, stated plainly:** this is a correctness fix to a mis-scoped default. Whether it
  resolves the owner's smear is **unverified** — this is not the user's display, and only they can
  look at the Settings page in a real run and say.

  **Cleanup receipts** for this investigation: headless Chromium terminated (all chrome procs
  gone), `/tmp/opencode/cdp-profile` removed. Screenshots kept at `/tmp/opencode/tabbar-*.png`
  as evidence. Dev server on :1420 was pre-existing and left running.

  **Unblock with two things:**
  1. **Stale-build check.** `npm run build` writing `dist/` does *not* update a running Tauri
     app — `tauri:dev` serves from Vite, a built binary embeds its own bundle. Open Settings:
     are the back chevron and the "Saved as you go" line still visible? Both were deleted in
     this batch, so if either is on screen every reported symptom is pre-fix code.
  2. **Console output from the Tauri window** (right-click → Inspect Element, dev builds):

     ```js
     const t = document.querySelector('.settings-tabs');
     let n = t, out = [];
     while (n && n !== document.documentElement) {
       const c = getComputedStyle(n);
       if (c.transform !== 'none' || c.filter !== 'none' || c.willChange !== 'auto' || c.zoom !== '1')
         out.push(n.tagName + '.' + n.className + ' :: ' + c.transform + ' | ' + c.filter + ' | ' + c.willChange + ' | zoom ' + c.zoom);
       n = n.parentElement;
     }
     console.log('suspects:', out);
     console.log('tabbar box:', JSON.stringify(t.getBoundingClientRect()));
     ```

     If `suspects` is empty in WebKitGTK too, the fault is in the compositor rather than the
     style cascade and the next lever is forcing a non-composited path on `.settings-tabbar`.

Status: **diagnosis not confirmed.** The screenshot the user attached could not be
loaded by the orchestrator (`this model does not support image input`), so nobody
has actually looked at it. This plan is a hypothesis ranking plus a bisection
procedure, not a claimed fix. The worker must obtain a description of the artifact
from the user, or reproduce it, before changing anything.

---

## What is verified from the code

| Line | Rule | Note |
| --- | --- | --- |
| 457 | `.library-layer, .editor-layer { position: fixed; inset: 0; … transform: scale(0.992); transition: opacity 0.2s var(--ease), transform 0.2s var(--ease); }` | full-viewport layer, scaled, transitioned |
| 1066 | `.app-shell.settings-open .library-layer { position: relative; inset: auto; width: 218px; flex: none; }` | **switches positioning mode and width while the transition above is live** |
| 1070 | `.app-shell.settings-open .library-layer { opacity: 1; pointer-events: auto; transform: none; }` | animates `scale(0.992) → none` |
| 1075 | `.app-shell.settings-open .editor-layer { display: none; }` | |
| 1119 | `.settings-tabs { … }` | no transform |
| 1120 | `.settings-tab { … transition: color 0.16s, background 0.16s; }` | no transform, no filter |
| 677 | `will-change: transform` on `.editor-panel` | **editor only — not in the settings subtree. Ruled out.** |
| 1030-1036 | comment: `backdrop-filter` deliberately removed | none exists anywhere in the sheet. Ruled out. |

Nothing in `.settings-tabbar` / `.settings-tabs` / `.settings-tab` /
`.settings-page` carries a transform, filter, `will-change`, or `backdrop-filter`.

---

## Ranked hypotheses

**H1 (most likely) — layout-mode change during a live transform transition.**
`.library-layer` is `position: fixed; inset: 0; transform: scale(0.992)` and is
transitioning. Opening Settings moves it to `position: relative; width: 218px`
(line 1066) *and* `transform: none` (line 1070) at the same moment. Tauri on
Linux renders through WebKitGTK; a composited layer rasterised at one size and
presented at another during a positioning-mode switch produces exactly the
vertically-smeared glyph banding of the reported artifact.

Fix candidate — stop animating across the mode switch:
```css
@media (prefers-reduced-motion: no-preference) {
  .app-shell.settings-open .library-layer {
    transform: none;
    transition: none;   /* does not scale into the settings layout */
  }
}
```
If that is not enough, suppress the transition only for the settings-open case,
rather than globally — `.editor-layer`'s crossfade must keep working.

**H2 — the `scale(0.992)` subpixel rasterisation.** A 0.992 scale forces glyph
rasterisation at a non-integer ratio; at small sizes WebKitGTK can smear.
Test: set `transform: none` permanently on `.library-layer` (line 457) and see if
the artifact disappears without any other change. The layer's entry/exit
crossfade would lose its slight zoom — acceptable if it resolves the smear.

**H3 — the user is describing something else entirely** (layout, not rendering).
Do not code against this. Confirm first.

---

## Bisection procedure

Run in `gui/`, `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`:

1. Ask the user to describe the artifact in words: what is smeared, which
   region, does it clear on resize/minimize/refocus, does it persist on a
   static screenshot or only in motion.
2. `npm run dev` (browser fallback, no Rust core) and reproduce at the same
   window size.
3. Toggle one rule at a time in DevTools, reload each time:
   - line 457: drop `transform: scale(0.992)` → `transform: none`
   - line 457: drop the `transition` entirely
   - line 1066/1070: comment both `.app-shell.settings-open .library-layer` rules
   Whichever kills it identifies the hypothesis.
4. Confirm the fix holds in `npm run tauri:dev` (WebKitGTK, the real renderer) —
   the browser fallback will not exhibit a WebKitGTK compositing bug.

## Constraints

- Derived tokens go on `body { }`, not `:root`. Neither candidate adds one.
- Prefix `tw:` exactly once. These rules add no utility classes.
- **Trap:** never write `body[data-theme="paper"|"light"|"night"]` literally in a
  CSS comment — `tests/themes.test.mjs`'s `block()` locates theme blocks with
  `indexOf` over the raw stylesheet.
- `gui/` is untracked in git. No `git checkout` fallback. Make the smallest
  possible edit; no regex sweeps across `styles.css`.
- Do not reintroduce `backdrop-filter` (see the comment at 1030-1036).
- Do not commit.

## Verification

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
cd /home/marshall/Documents/projects/InProgress/Quill_New/gui
npm run build
npm run check:contrast
node --test --test-force-exit tests/shadcn-prefix-guard.test.mjs
node scripts/check-test-lists.mjs
npm test
```

All five green. Baseline: build ✓, contrast "All checks meet target", prefix guard
5/5, test-list gate ✓, **296 passing (196 + 71 + 29), 0 failing**.

No automated coverage for this — a rasterisation artifact is invisible to the
suite. Final confirmation is visual, in `tauri:dev`.
