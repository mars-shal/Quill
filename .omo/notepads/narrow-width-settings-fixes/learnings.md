# Learnings — narrow-width-settings-fixes

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Defect A — library header Settings fallback button (JSX)

**Path correction.** The plan says `src/library/Library.jsx`; the real file is
`gui/src/library/Library.jsx`. This is a Tauri app and `gui/` is the frontend
root (see `gui/README.md`). Any path in this plan that omits `gui/` needs the
prefix added before editing — a `grep` for `src/library/Library.jsx` finds
nothing and reads as "the file is gone".

**Line 116 is one very long line.** The whole `.library-main-head` header —
title block, `.library-main-tools`, and all three buttons — is a single line of
~600 chars. Edit by anchoring on the `.library-main-tools` substring, which is
unique, rather than trying to match the header element.

**Inserted** (sort -> settings -> new document, inside `.library-main-tools`):

```jsx
<Button className="soft-button settings-fallback" type="button" onClick={onSettings}><Icon name="settings" size={14} /><span>Settings</span></Button>
```

Reuses the `onSettings` prop already destructured at line 64 and the same
`onSettings` the sidebar button uses at line 113. `Icon.jsx:30` already
registers a `settings` glyph, so no icon work was needed.

### Why CSS is still required — the button is visible at ALL widths right now

`.settings-fallback` has **no rule in `styles.css`**, so it renders in the header
at every viewport. At ≥940px the sidebar Settings button (line 113) is also
visible, which means **two Settings buttons on screen at once**. The missing
piece is a rule in the `@media (max-width: 940px)` block (`styles.css:1251`):

```css
.settings-fallback { display: none; }
@media (max-width: 940px) { .settings-fallback { display: inline-flex; } }
```

Someone must own that rule, or the header shows a duplicate button. This is the
one open dependency from the JSX half of Defect A.

### The ≤560px rules already cover it, for free

`styles.css:1272-1273` collapses non-primary soft buttons to icon-only:

```css
.library-main-tools .soft-button:not(.primary) span { display: none; }
.library-main-tools .soft-button:not(.primary) { width: 34px; padding: 0; }
```

The new button matches `.soft-button:not(.primary)`, so below 560px it becomes a
34px gear button automatically — same as the sort button. No extra work, and the
`<span>Settings</span>` is harmless: hidden by CSS, still in the accessibility
tree.

### Verification without a browser (Chromium still ETIMEDOUTs)

The notepad records that Chromium download fails, so visual verification is out.
**jsdom is the substitute** — `gui/tests/support/dom-harness.mjs` mounts the real
`App` against stubbed Tauri IPC. Run a throwaway suite with:

```bash
cd gui
node --test --test-force-exit --experimental-test-module-mocks \
     --import ./tests/setup.mjs --test /tmp/verify.mjs
```

Keep the file **outside `gui/tests/`**: `scripts/test-js.sh` runs
`scripts/check-test-lists.mjs`, which fails when a `tests/*.test.mjs` file is not
in its hardcoded pass list. A dropped-in test would break the suite.

What that bought: the button is in the rendered DOM, ordered correctly between
sort and new-document, carries an `svg` + "Settings" text, **and clicking it
actually opens `.settings-page`** — which is the real proof that `onSettings` is
wired, something grep can never show.

Caveat: jsdom applies no CSS and computes no layout, so it cannot verify the
media query. It proves DOM presence and behaviour; the visibility rules still
need an eye on a real narrow window.

### `.sidebar-settings` was never a unique selector

An assertion that `document.querySelectorAll('.sidebar-settings').length === 1`
fails on unmodified code: there are **two** — one in `.library-sidebar`, and a
pre-existing unrelated Settings button inside a `.panel-inner` elsewhere in the
app. The existing suites are unaffected because they use the *scoped* selector
`.library-sidebar .sidebar-settings` (`settings-controls.test.mjs:37`,
`background-picker.test.mjs:82`, `dialog-keyboard.test.mjs:54`,
`theme-picker.test.mjs:77`). Don't reach for the bare class in new assertions.

### Environment gotcha

`npm`/`node` are not on `PATH` in a non-login shell. Prefix with:

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
```

### Checks run

- `npm run build` — clean, 2487 modules. (The >500 kB chunk warning is pre-existing.)
- `npm test` — 29/29 pass. Node's test runner plus `check-test-lists.mjs` confirm
  no test file was dropped in.
- `git diff` is **useless** here: the entire repo is untracked (`git status`
  shows only `??` entries, no commits yet). Confirm edits by reading the file,
  not by diffing.

---

## Defect A.2 — library header Settings fallback button (CSS)

Closes the open dependency from the JSX half above. `.settings-fallback` now
has the two rules it was missing:

```css
.settings-fallback { display: none; }          /* styles.css:757 */
@media (max-width: 940px) { .settings-fallback { display: inline-flex; } }  /* :1261 */
```

### The plan's line numbers for this were wrong — grep before editing

The task brief put the `@media (max-width: 940px)` block at **line 69**. It is
at **1251** and closes at **1275**; `styles.css` is 1797 lines with all the
responsive queries collected at the end. Grepping first was the only reason this
didn't go in at the wrong depth — line 69 is inside the base rules, so a nested
block there would have been dropped by the parser. This is the same class of
error as the missing `gui/` prefix above: **the plan's coordinates were written
against an older revision.** Anchor edits on selector text, not line numbers.

The `.sidebar-settings` line the brief cited (752) *was* accurate. So assume
neither, verify both.

### Place the narrow-width rule beside the rule it cancels

`.settings-fallback { display: inline-flex; }` went directly under
`.library-sidebar { display: none; }` rather than at the end of the block. The
two are one decision — the sidebar disappears and its replacement appears — and
putting them together means a future edit to either breakpoint finds its partner
two lines away instead of eleven. Same reasoning as the `.editor-shell` overlay
comment a few lines below, which explains its own rule in place.

### `inline-flex` is load-bearing, not decorative

`.soft-button` (line 522) is `display: inline-flex`. Writing `display: block`
or `display: revert` here would silently collapse the icon-and-label row and
override the `align-items: center` / `gap: 7px` that `.soft-button` sets up. The
narrow-width rule has to hand the button back the display its base class gave
it, which is exactly what `inline-flex` does.

### The `themes.test.mjs` `block()` trap, now with the mechanism

Explained so the next person can tell whether a comment is safe rather than just
remembering the rule. `block(selector)` (`themes.test.mjs:339`) does
`stylesheet.indexOf(selector)` — the **first textual occurrence**, comments
included — then grabs the next `{...}` block. So a comment that merely *names*
`body[data-theme="light"]` before the real rule makes `block()` parse an
unrelated block, and the contrast gate fails on garbage tokens with an error
that points nowhere near the cause. Neither new comment contains that string;
both describe breakpoints and layout instead. Relevant whenever adding CSS
comments near the theme blocks, not just here.

### Checks run

- `npm run build` — clean, 4.57s.
- `npm test` — 29/29 pass, so the theme token gate still reads the stylesheet.
- Verified in the **built** bundle, which is stronger than grepping the source:
  `grep -o '\.settings-fallback{[^}]*}' dist/assets/index-*.css` returns exactly
  `display:none` and `display:inline-flex`. A rule that survives minification is
  a rule the browser will actually apply.

Still unverified: actual visibility at a real narrow window. jsdom applies no
CSS (see the caveat above), and Chromium still cannot download here.

---

## Defect B — collapsing the empty 218px strip below 940px

**The media block is at `styles.css:1256`, not line 69.** The plan's "line 69" was
from an earlier revision of the file (and 69 is inside the `:root` token comment
block today). Grep for `@media (max-width: 940px)` rather than trusting the line
number — it currently has exactly one occurrence.

**Placed immediately after the `.settings-fallback` rule**, which Defect A.2 had
already added, so both narrow-width settings fixes read as one contiguous block:

```css
.settings-fallback { display: inline-flex; }
/* ... */
.app-shell.settings-open .library-layer { width: 0; }
```

### `width: 0` is enough because line 1071 already says `flex: none`

The line-1071 rule is `position: relative; inset: auto; width: 218px; flex: none`.
`flex: none` resolves to `flex: 0 0 auto`, so the flex **basis is `auto`** — the
width property *is* the basis. Overriding `width` to `0` therefore collapses the
item with no need to touch `flex-basis` or `flex`. If that rule had been
`flex: 1`, the width override would have been silently ignored.

`.settings-layer` is `display: flex; flex: 1; min-width: 0` (styles.css:1056), so
it absorbs the freed space. `min-width: 0` is what stops its own content from
re-establishing a floor.

### The cascade argument is real, and worth checking rather than assuming

New rule and the rule it overrides have **identical specificity**
(`.app-shell.settings-open .library-layer`, 0-3-0) — no `:where()`, no extra
class, no `!important`. Media-query wrapping does **not** add specificity. The only
thing that makes it win is source order: 1268 > 1071. Any future refactor that
hoists the settings-split rules above the media block, or that reorders them,
silently reintroduces the strip with no test failure and no build error.

### Comment kept deliberately

The rule is a bare `width: 0` sitting ~200 lines away from the `width: 218px` it
overrides. Without the inline comment the next reader sees two contradictory
declarations and one of them is a typo. This file already comments every
non-obvious media-query rule for the same reason (`.settings-fallback`,
`.editor-shell`).

### Checks run

- `npm test` — 29/29 pass.
- `npm run build` — clean, 2487 modules. (>500 kB chunk warning pre-existing.)
- Still no layout verification: jsdom computes no layout, and Chromium download
  times out on this machine. The width collapse remains eyeball-only. The static
  argument is what backs it: `flex: none` => basis auto => width governs.

---

## Click-eater class of bug — `::before`/`::after` need `pointer-events` too

The Settings page was completely unclickable in the real app. Not a WebKit bug,
not a React bug, and **not caught by any test in the repo.**

**Cause.** `.app-shell` is `position: relative; z-index: auto`, which is **not**
a stacking context, so its children resolve in the *root* stacking context:

| Element | Position / z-index | Paint step |
| --- | --- | --- |
| `.settings-layer` (whole Settings page) | static, auto | **3** — in-flow blocks |
| `.app-shell::before` — full viewport, `inset: 0` | absolute, **z-index 0** | **6** — positioned z-index:0 |
| `.library-layer` | relative, **z-index 1** | 7 |

Step 6 beats step 3, so a full-viewport `::before` painted *above the entire
Settings page*. It had no `pointer-events` declaration. Its sibling `::after` was
identical in geometry but **did** have `pointer-events: none` — `::before` was
simply overlooked. `.library-layer` sitting at step 7 is exactly why the sidebar's
own Settings button still worked while everything *inside* the page was dead.
That asymmetry was the fingerprint.

**Fix.** `pointer-events: none` on `.app-shell::before`, matching `::after`.

**Generalised rule for this codebase:** any `::before`/`::after` that is
full-viewport (`position: absolute|fixed` + `inset: 0`) with a non-transparent
background is a click-eater unless it declares `pointer-events: none`. Guard now
enforced by `tests/app-shell-overlay.test.mjs`.

### The lesson that matters most: `element.click()` is not click evidence

This bug survived because **two independent "proofs" were worthless**:

- **jsdom has no hit-testing at all.** Every DOM-level test passes regardless.
- **`element.click()` dispatches the event straight at the node**, bypassing the
  compositor entirely. Driving Chromium over CDP and calling
  `querySelector(...).click()` is equally useless — I did exactly that and
  reported "works in Chromium" while the bug was live.

The same trap hides in this repo's own suites: **all three tab panels stay
mounted** and only the `hidden` attribute differs. `root.querySelector('.some-control-inside-a-hidden-panel')`
therefore succeeds whether or not the tab switch worked. `theme-picker.test.mjs:92`
clicked the Appearance tab and then asserted nothing about the switch; the comment
there claimed it "proves the panel is reachable" — it did not.

**Only these are real evidence:**
- `document.elementFromPoint(x, y)` — returns the element a real mouse would hit.
  For a pseudo-element box it returns the *originating* element, so `.app-shell`
  means `::before` got it.
- Real coordinate-based input (`Input.dispatchMouseEvent` over CDP, or
  Playwright's `page.mouse.click`).

Use those for anything involving clicks, overlays, or z-order.

### Driving a real browser here with zero dependencies

Chromium is at `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` but
the `playwright` npm package is not installed and downloads time out. Chromium
speaks CDP, and **Node 24 has a global `WebSocket`**, so a working driver is
~40 lines of dependency-free Node: fetch `http://127.0.0.1:<port>/json/list` for
the target, open the `webSocketDebuggerUrl`, then `Page.navigate`,
`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`. That is
how the click-eater above was proven and how the Chromium screenshots were taken.

### Do NOT force a browser engine to launch by stubbing libraries

Playwright's bundled WebKit (`webkit-2359`) will not start here: three libs are
unresolved. It can be made to start by compiling stub `.so` files and copying them
**into the shared `~/.cache/ms-playwright` tree**, because `minibrowser-wpe/MiniBrowser`
is a shell wrapper that hard-sets `LD_LIBRARY_PATH` and discards anything exported.

**Do not do this.** The engine then runs on fake libraries — including
`libjxl`, an image codec — so every rendering result is undefined-behaviour. It
produced an apparently perfect reproduction that was then contradicted by its own
controls (app smeared, an identical-font/size/weight control clean, a seven-way
tag test entirely clean). Those cannot all describe one defect, so the
"reproduced" claim was wrong. If an engine needs tampering to run, its output
cannot be used to diagnose anything. Cleanup receipt: the three stubs were removed
and their absence verified.

## Cascade reminder (reconfirmed, and it bit twice)

`styles.css` is **unlayered**; Tailwind's utilities are **layered** (`tailwind.css`
imports only `layer(theme)` and `layer(utilities)` — there is no base layer).
Unlayered author CSS outranks layered CSS for any property both rules set.

- `styles.css:414` was `button, input, textarea, select { font: inherit; }`. The
  `font` shorthand sets `font-size` and `line-height`, so it beat `tw:text-sm` on
  every shadcn control. Narrowed to `font-family: inherit`, which keeps the reason
  the rule exists (native controls inherit the self-hosted Inter) without
  clobbering size.
- `.dialog-select { width: 100% }` at `styles.css:1217` is an old patch for the
  same fault. **Do not add another** — fix the cascade, not the symptom.
- Do **not** wrap `styles.css` in `@layer components` as a quick fix. It is the
  documented end state, but `KNOWN_COLLISIONS` in `tests/tailwind-bridge.test.mjs`
  gates it: `.border`, `.shadow`, `.hidden`, `.flex` and 9 more would start meaning
  Tailwind's values. It is a migration.
- **Trap:** `tests/themes.test.mjs`'s `block()` finds theme blocks with `indexOf`
  over the raw stylesheet. Never write `body[data-theme="paper"]` (or `light` /
  `night`) inside a CSS comment — it hijacks the test.

## Still undiagnosed — the vertical text smear

Distinct from the click-eater. `settings-render-smear.md` carries the full investigation.

**Upstream match (2026-10-08): this is a known WebKitGTK bug class, not app CSS.** Four
independent reports share the signature:

- **WebKit #263645** — "[GTK] The rendering of the fonts look blurred … if I launch with
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` they look perfect." Blurred glyphs traced to the
  compositing path. **Gives a zero-risk, no-code-change workaround to try.**
- **WebKit #271714** — "[GTK] Blurriness with fractional scaling", reported at **125%**,
  affecting *only* webkitgtk apps and not other GTK apps on the same system. That asymmetry
  is what made this look like an app bug. Fixed upstream by WebKit PR #34556.
- **univer#6457** — canvas text fuzzy at `devicePixelRatio` **1.25** on Linux/Wayland,
  explicitly via "WebKitGTK (via Tauri 2.x desktop app)" — the same stack as this app.
  Integer scales (1.0, 2.0) crisp; fractional ones not.
- **KDE #479891** — glyphs "vertically mis-aligned or **squished**" at 125%/150%/175%
  fractional scale. Qt, not WebKit, but it confirms vertical glyph smearing at fractional
  scale is a known failure mode across the Linux desktop stack.

Ruled out, so stop re-testing these: `--brand-filter: invert(1)` (forced off, persists), the
Inter webfont (`sans-serif` smears identically), theme (light smears too), `backdrop-filter`
(already removed app-wide), and any `filter`/`transform` on a `.settings-*` rule. Geometry is
correct — `95x27` at `12px`/`600` — in every variant tested.

**Why those negatives are the point, not a failure:** every CSS candidate came back clean,
which is what you expect when the fault is in the engine's raster path rather than in CSS.
I spent too long assuming the negatives meant "keep looking in the app".

**Do not apply a CSS mitigation.** `zoom: 1` is not a safe guess — on a fractional-scale display
it can *cause* the artifact it appears to fix.

**Next:** `devicePixelRatio` in the Tauri webview, then
`WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri:dev`. If that clears it, the cause is
confirmed and the fix belongs upstream, not in this repo.

## `scripts/tauri.sh` forced software rendering on every machine

Found while chasing the smear, and a real defect on its own merits. It defaulted
`LIBGL_ALWAYS_SOFTWARE=1` unconditionally, pushing Mesa onto llvmpipe for WebKit's GPU process on
every launch. Its own comment said the intent was "a VM or over a remote session, where the
machine may well have a capable GPU … but the compositor cannot hand WebKit a context" — which
is not an ordinary desktop.

This machine had hardware GL working and ignored: two render nodes, Intel UHD 630 + Quadro T2000,
`glxinfo` naming `Mesa Intel(R) UHD Graphics 630` as the renderer, `systemd-detect-virt` = `none`.

Now:

```bash
if ! ls /dev/dri/renderD* >/dev/null 2>&1; then
  export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
fi
```

A failing `ls` inside an `if` condition does not trip `set -e` — commands in condition position
are never fatal — so `set -euo pipefail` is safe here. All four branches verified against the real
logic: GPU present → unset; GPU present + caller `=1` → `1` survives; no GPU → `1`; no GPU + caller
`=0` → `0` wins. `${VAR:-1}` keeps a caller export winning in both directions.

**`WEBKIT_DISABLE_DMABUF_RENDERER` was deliberately left alone.** It is a different failure class:
the DMA-BUF path *fails outright* ("unable to construct a complete framebuffer") rather than
degrading. Whether it warrants the same `/dev/dri/renderD*` gating is open — do not bundle that into
an unrelated change, and do not assume it is symmetric with the GL variable.

**Knock-on:** changing this made `src/platform/capabilities.js:37` false — its warning told users
`LIBGL_ALWAYS_SOFTWARE=1` was what `scripts/tauri.sh` "does by default". Reworded. **When changing a
default, grep for prose that documents it**; the string is advice printed to users, not a comment.

**Not verified:** whether this clears the owner's smear. It is a correctness fix to a mis-scoped
default, plus a falsifiable hypothesis. Only the owner can look at the Settings page and say.

### Verifying a shell branch without sourcing the script

`scripts/tauri.sh` ends in `exec npx --no-install tauri "$@"`, so sourcing it in a test harness
would launch Tauri. Copy the conditional into a separate file with the glob path parameterised
(`ROOT=/` vs a nonexistent dir) and exercise that. Two traps I hit, both of which produced
*confidently wrong* results:

- `env -u VAR` before passing the caller's value **strips** it, so every "caller export wins" case
  silently tested the unset case instead.
- Building the harness body in a string with `"$GLOB"` inside **expands it once, at assignment
  time**, so every case ended up testing the same real path and the branch you meant to cover was
  never reached.

Both produced a clean-looking table that proved nothing. Put the harness in a real file.

---

## A source-scanning guard needs a MUTATION test to prove it still bites

Installing the React Bits components exposed a **real regression** in
`tests/motion.test.mjs` — the "no tween runs longer than the budget" guard.

**The bug.** The guard had to split `duration:` values into two unit buckets,
because framer-motion/GSAP durations are **seconds** and Web Animations API
durations are **milliseconds**. `composite` is a WAAPI-only option, so its
presence on the line is the reliable signal. The first implementation captured
the rest of the line to inspect it:

```js
const declarations = [...jsx.matchAll(/duration:\s*([\d.]+)([^\n]*)/g)]
```

`([^\n]*)` is **greedy**, so it consumes the remainder of the line. The global
scan then resumes *past* every later `duration:` on that line, leaving only the
**first** one visible. `src/library/motion.js:30` declares two on one line:

```js
return reducedMotion ? { duration: 0 } : { duration: 0.17, ease: [0.4, 0, 0.2, 1] }
```

so the 0.17s one — the one the budget exists to protect — was invisible.
Raising it to `0.9` produced **no test failure at all**. Verified by hand: the
capturing regex extracts `[0]`, the lookahead form extracts `[0, 0.9]`.

**The fix** — decide the unit with a *lookahead*, which consumes nothing:

```js
const seconds      = [...jsx.matchAll(/duration:\s*([\d.]+)(?![^\n]*composite:)/g)].map(([, v]) => Number(v))
const milliseconds = [...jsx.matchAll(/duration:\s*([\d.]+)(?=[^\n]*composite:)/g)].map(([, v]) => Number(v))
```

**The generalisable lesson.** A source-scanning guard can be silently neutered
by a *plausible* regex change, and the suite stays green because the guard is
the thing that was broken. Only a **mutation test** distinguishes "the guard
passes" from "the guard still detects". Both branches were mutated and
confirmed to fail:

| Mutation | Expected failure | Result |
| --- | --- | --- |
| `duration: 0.17` -> `0.9` in `motion.js` | `duration 0.9s exceeds the 0.2s budget` | fails as required |
| `duration: 450` -> `900` in `CallChip.jsx` | `duration 900ms exceeds the 500ms budget` | fails as required |
| unmutated | none | 16/16 pass |

**Never "fix" a vendored file to make a guard pass.** `CallChip.jsx` is
byte-identical to upstream React Bits; the guard has to *read it correctly*.

## Greedy captures inside a global `matchAll` hide later matches

Generalisation, because this shape will recur in any source-scanning guard:
a capture group that matches to end-of-line (`([^\n]*)`) or end-of-string
(`(.*)`) inside a `/g` regex **swallows the text the next match would have
started from**. Prefer a lookahead (`(?=...)` / `(?!...)`) when you want to
*inspect* the following text without consuming it. This is the same class of
bug as a `.*` in a `sed` substitution silently eating the second occurrence.

## The shadcn CLI prefixes non-utility class names, which breaks CSS-based components

`components.json` sets `tailwind.prefix: "tw"`, and the CLI rewrites class
names on install. It applies that to **every** class name it touches — not
just Tailwind utilities — including the React Bits components' own semantic
BEM names (`hold-button__idle`, `prompt-bar__row`, `thought-line__step`).

Those names are styled by the components' own `.css` files, which the CLI does
**not** prefix. So the installed components were unstyled: JSX emitted
`class="tw:hold-button__idle"` while the stylesheet defined
`.hold-button__idle`. Nothing matched.

Every one of the 100 `tw:` tokens was a semantic class; **zero** were genuine
Tailwind utilities. Removing the prefix restored all six `.jsx` files to
**byte-identical** upstream registry content (verified by diffing against
`https://reactbits.dev/r/<Name>-JS-CSS.json`).

**The prefix guard did not catch it, and that is the trap.**
`tests/shadcn-prefix-guard.test.mjs` classifies a token as an offence only
when it is a *bare utility* / `tw-flex` / `tw::flex` / repeated-mid-chain.
`tw:hold-button__idle` has head `hold`, which is not in `UTILITY_ROOTS`, so it
classifies as `ok`. **A green suite was the evidence that the bug was
invisible to it** — exactly the failure mode that guard exists to prevent. Do
not "fix" the guard; fix the components.

## The project's real test baseline is 320, not 308

`npm test` runs three groups: 203 + 88 + 29 = **320 passing, 0 failing**. An
earlier note said 308; that figure was stale. Use 320.
