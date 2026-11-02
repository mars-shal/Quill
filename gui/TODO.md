# Quill — work backlog

The active work queue for `gui/`. Every item cites the files it touches, what
"done" means, and the checks that gate it. Phases are ordered by dependency,
not by appeal.

`README.md` keeps a short status summary and points here. Nothing in this file
is duplicated there.

## How to read the phases

Phase 0 is the shadcn/ui foundation. Every later phase that swaps a hand-rolled
control for a Radix primitive depends on it, so it comes first even though none
of it is user-visible on its own. Phases 1 through 5 are the owner's stated
priorities: contrast, motion, onboarding, settings overflow, and library
previews. Phase 6 is the shadcn migration itself, ordered by risk. Phase 7 is
carried-over backlog.

| Phase | Contents | Depends on |
| --- | --- | --- |
| 0 | shadcn/ui foundation: Radix, lucide, prefix strategy, guard test — **done** | — |
| 1 | Theme contrast: `--backdrop` pairs, `:root` hazard, `--screen-*` constraint — **done** | 0 |
| 1b | **Panel surfaces resolved against `:root`** — **done** | — |
| 2 | Animation removal outside the assistant — **done** | 0 |
| 3 | Onboarding and auth **removed** (surfaces deleted, chip kept as a readout) — **done** | 0, 2 |
| 4 | Settings overflow fix — **done** | 0 |
| 5 | Library content previews — **done** | 0, 1 |
| 6 | shadcn migration — **done: dialogs, all 8 selects, 4 radio groups, switch, 23 action buttons** | 0, 1, 2, 3, 4, 5 |
| 7 | Carried-over backlog | — |
| 8 | Settings redesign: tab bar, row layout, card grids — **done** | 4, 6 |
| 9 | Library tiles as paper sheets — **done** | 1 |

### Why Phase 0 is first

The owner asked for shadcn/ui on every interactive element. That is a large
surface: 57 `<button>`, 4 `<input>`, 2 `<select>` across 14 files, plus nine
hand-rolled ARIA widgets. None of that migration can start until `@radix-ui/*`
and `lucide-react` are installed, `src/library/ui/` exists, and the Tailwind
prefix question is settled. Getting the prefix wrong means every CLI-installed
component renders unstyled, so the decision has to be made once, up front, and
guarded by a test.

### Why Phase 1 precedes the visual work

The contrast failures are real WCAG misses on the app's outermost plane, and
the `:root`-is-light hazard is a structural dark-theme bug that will bite any
new surface added later. Fixing it before Phases 3 through 6 land means those
phases inherit a correct baseline rather than building on a broken one.

## Checks that gate every phase

```bash
npm run check          # check:contrast + the full JS suite
npm run check:contrast # WCAG ratio assertions on theme tokens
npm test               # JS unit tests
npm run check:rust     # cargo fmt --check, clippy -D warnings, cargo test
npm run build          # Vite production build
```

A phase is not done until its acceptance checks pass and any new tests are
registered in `scripts/test-js.sh`. The hard gate is
`scripts/check-test-lists.mjs`: it fails the build if any `tests/*.test.mjs`
is not named in that script. A new test file that nobody registered is never
executed while `check` still reads green.

---

# Phase 0 — shadcn/ui foundation

Nothing here is user-visible. It is the prerequisite for every control swap in
Phase 6.

**Status: done.** 20 packages installed (19 Radix + `lucide-react`),
`src/library/ui/` created, prefix verified and documented, guard test added and
registered. `npm run build` green, `npm run check:contrast` green, 359 tests
pass (was 354; the 5 new ones are P0-3).

## P0-1 · Install `@radix-ui/*` and `lucide-react`

**Status: done.**

**What is wrong.** `components.json` is already configured (`style: new-york`,
`rsc: false`, `tsx: false`, `baseColor: neutral`, `cssVariables: true`,
`iconLibrary: lucide`, aliases to `@/library/ui`, `@/library`,
`@/platform/cn`, `@/library/hooks`), but no shadcn component is installed.
`src/library/ui/` does not exist. `@radix-ui/*` is not in `node_modules`.
`lucide-react` is not in `node_modules`; the app has its own `src/Icon.jsx`
SVG registry instead.

**What was done.** Installed the 19 Radix packages Phase 6 needs —
`react-slot`, `dialog`, `radio-group`, `select`, `switch`, `dropdown-menu`,
`toolbar`, `popover`, `label`, `separator`, `tabs`, `tooltip`, `scroll-area`,
`slider`, `toggle-group`, `avatar`, `accordion`, `checkbox`, `progress` — plus
`lucide-react`. 58 transitive packages, 0 vulnerabilities. Created
`src/library/ui/` with a `README.md` carrying the prefix rules, which is the
documentation P0-2 asks for. No component files yet; they arrive in Phase 6.

`cn` already resolves: `src/platform/cn.js` exists and `components.json` points
`utils` at it, so nothing needed wiring.

**Done when** `src/library/ui/` exists, `cn` is imported from
`src/platform/cn.js`, and `npm run build` passes with the new dependencies in
the bundle.

## P0-2 · Decide and document the Tailwind prefix strategy

**Status: done.** `components.json` already carried the correct value,
`"prefix": "tw"`. Documented in `src/library/ui/README.md` and asserted by a
test.

**What is wrong.** `src/tailwind.css` uses Tailwind v4 with `prefix(tw)`, and
the prefix is a colon: `tw:flex` works, `tw-flex` silently generates nothing.
This is documented at `tailwind.css:117-131` and `:101-113`. The shadcn CLI
emits unprefixed classes, so every CLI-installed component would render
unstyled unless the prefix question is settled first.

The prefix is load-bearing for a second reason. `tailwind.css:135-155` lists
Quill's own class names that collide with Tailwind utility names: `outline`,
`border`, `shadow`, `container`, `ring`, `table`, `hidden`. Unprefixed Tailwind
shipped a visible bug: `<nav class="outline">` rendered with a 1px white box.
`KNOWN_COLLISIONS` in `tests/tailwind-bridge.test.mjs` re-derives the collision
set from a real build. Removing the prefix re-opens that regression.

**The decision.** Three options:

1. **Keep the `tw:` prefix and configure shadcn to emit it.** The shadcn CLI
   has a `tailwind.prefix` config field and a transformer that rewrites class
   names as it installs. Trade-off: the prefix is unusual, and some shadcn
   examples in the wild assume unprefixed output, so copy-paste from docs needs
   adjustment.
2. **Drop the prefix and rename the colliding Quill classes.** This aligns
   with shadcn defaults but re-opens the shipped regression at
   `tailwind.css:135-155` and requires auditing every collision site.
3. **Keep the prefix and hand-write the shadcn components.** No CLI, so no
   prefix mismatch, but the CLI's update path is lost.

**Recommendation: option 1.** Keep the `tw:` prefix, set `tailwind.prefix` in
`components.json`, and document the choice in `src/library/ui/README.md` or a
top-of-file comment in each component. The collision set is already known and
tested; the prefix is the smaller risk.

#### The prefix value is `"tw"`, not `"tw:"` — this is a trap

The CLI adds the separator itself, and the correct value differs by Tailwind
major version. From `applyPrefix` in
`packages/shadcn/src/utils/transformers/transform-tw-prefix.ts`, and its test
`transform-tw-prefix.test.ts`:

| Version | `applyPrefix(…, prefix, version)` | Emits | Value to put in `components.json` |
| --- | --- | --- | --- |
| v3 | `` `${prefix}${className}` `` | `tw-bg-slate-800` | `"tw-"` (trailing dash) |
| v4 | `` `${prefix}:${className}` `` | `tw:bg-slate-800` | `"tw"` (bare) |

Quill is on v4, so the value is **`"tw"`**. Setting `"tw:"` — which reads
correctly, because the utilities really are written `tw:flex` — makes the
transformer emit `tw::flex`, which generates nothing and fails in exactly the
silent way `tailwind.css:117-131` was written to warn about. The dash in the
config test fixture (`get-config.test.ts` asserts `"tw-"`) is the **v3** case
and does not apply here.

**Done when**

- `components.json` has `tailwind.prefix: "tw"` (bare, no colon, no dash).
- A comment in `src/library/ui/` explains why the prefix exists.
- One component is installed and `npm run build` shows the emitted CSS contains
  `.tw\:flex` and not `.tw\:\:flex`. Verify with:
  `grep -o '\\.tw..*\\:' dist/assets/*.css | head`.
- The P0-3 guard test is in place and catches the `tw::` case, not just the
  unprefixed one.

## P0-3 · Add a guard test for unprefixed utilities in `src/library/ui/`

**Status: done.** `tests/shadcn-prefix-guard.test.mjs`, registered in
`scripts/test-js.sh` (the unit pass). 5 tests.

**What is wrong.** Nothing yet, but the failure mode is silent: a component
installed without the prefix renders unstyled and no existing check catches it.
`KNOWN_COLLISIONS` in `tests/tailwind-bridge.test.mjs` re-derives collisions
from a real build, but it has never had to reason about shadcn's output.

**What to do.** Add `tests/shadcn-prefix-guard.test.mjs` that walks every file
under `src/library/ui/` and fails on **all three** ways a prefixed class goes
wrong:

1. **Unprefixed** — `className="flex"` instead of `className="tw:flex"`. This is
   the common case.
2. **Double-prefixed** — `className="tw::flex"`, from setting
   `tailwind.prefix: "tw:"` instead of `"tw"` (see P0-2). Silent, and the default
   mistake, so it needs its own case.
3. **Dash-prefixed** — `className="tw-flex"`, which is what the CLI emits for
   **v3** and which generates nothing under v4's `prefix()` implementation
   (`tailwind.css:117-131`).

Register it in `scripts/test-js.sh`. That registration is not optional:
`scripts/check-test-lists.mjs` fails the run if a `tests/*.test.mjs` is not
named there, and a test nobody registered would read as coverage while never
executing.

**What to do about the class list.** Do not try to re-derive "is this token a
Tailwind utility?" from first principles. The practical approach is an
allowlist of the utility-shaped names shadcn actually emits, plus a deny-check
for any class that matches a known-unprefixed pattern. Whatever the mechanism,
it must be able to fail: a guard that cannot fail is worse than none.

**Done when**

- The test is registered in `scripts/test-js.sh` and passes against an empty or
  bootstrap `src/library/ui/`.
- It fails on `className="flex"`, on `className="tw::flex"`, and on
  `className="tw-flex"`.
- It passes on a real installed shadcn component whose classes are `tw:`-prefixed.

---

# Phase 1 — Theme contrast

**Status: done.** Six `--backdrop` pairs added to the suites, four ratios
fixed in the themes and in `themes.js`, plus two new gates (plane separation,
theme token closure).

The owner's words: "some of the text contrast on the themes, e.g dark themes
dont use a dark bg on some parts of the application." The verified failures are
on `--backdrop`, the app's outermost plane.

## P1-1 · Add `--backdrop` pairs to `check-contrast.mjs`

**What is wrong.** `scripts/check-contrast.mjs` (258 lines) parses `:root` and
`body[data-theme="…"]` and asserts the `SUITES` pairs at lines 73-131. Every
suite tests text against `--main`, `--sidebar`, `--chat`. `--backdrop` appears
exactly once in the whole file (line 209) and only as an overlay-compositing
assertion, never as a background pair. That is why the failures below survive a
green `npm run check:contrast`.

**What to do.** Add `--backdrop` as a background to the `SUITES` table for
all three themes. The script already has the parsing infrastructure; this is a
data addition, not a logic change.

**Done when** `npm run check:contrast` fails on the current token values.

## P1-2 · Fix the four failing `--backdrop` ratios

**What is wrong.** Every token-on-token pair passes. The failures are text on
`--backdrop`:

| Theme | Token | Backdrop | Ratio | Needs |
| --- | --- | --- | --- | --- |
| light | `--text-2` | `#ececed` | 4.30:1 | 4.5 |
| light | `--text-3` | `#ececed` | 4.24:1 | 4.5 |
| paper | `--text-2` | `#e5e3dd` | 4.26:1 | 4.5 |
| paper | `--text-3` | `#e5e3dd` | 4.03:1 | 4.5 |

`--backdrop` is the app's outermost plane: `html` at `styles.css:127`, `body`
at `:132`, `.library-page` at `:342`, and two more surfaces at `:1171` and
`:1183`.

**What to do.** Two levers, and they pull in opposite directions. Pick
deliberately rather than reaching for the first one.

1. **Darken `--backdrop`** in the `light` and `paper` blocks
   (`styles.css:146-178` and `:179-210`) until all four ratios clear 4.5:1.
   The `night` block (`:211-275`) already passes; do not touch it.
   Trade-off: this moves `--backdrop` closer to `--main`/`--sidebar` and starts
   reproducing exactly the problem the `night` comment at `:215-236` was written
   to explain — several planes within a hair of each other, so the app reads as
   one flat mass rather than as page, rail and backdrop. Darkening the backdrop
   to win a contrast ratio can lose the thing the owner actually complained
   about.
2. **Darken `--text-2` and `--text-3`** in those two blocks instead, so they
   clear 4.5:1 against the existing backdrop. Trade-off: less headroom on
   `--main`/`--sidebar`, which currently pass with room to spare, so it needs
   the full matrix re-checked rather than just the four backdrop pairs.

**Recommendation: option 2, then re-verify the whole matrix.** The failing pairs
are all *secondary* text, and the fix is a small ink adjustment rather than a
plane adjustment. `--text-2`/`--text-3` have visible headroom on `--main`
(light `--text-3` is `#6f6f73` on `#ffffff`), so darkening them slightly costs
little. Option 1 spends a structural property — plane separation — to buy a
ratio that option 2 buys with ink.

Whichever is chosen, the acceptance condition is the same and must not be
narrowed to just the four new pairs: **every** token pair in all three suites
still passes. Add a check that fails if the gap between `--backdrop` and
`--main` drops below a stated separation floor, so the next theme edit cannot
quietly re-flatten the planes.

**Done when**

- `npm run check:contrast` passes with the new `--backdrop` pairs in the suite.
- The full SUITES matrix still passes for all three themes.
- A separation check exists for `--backdrop` vs `--main` and `--sidebar`, and it
  passes.

## P1-3 · Resolve the `:root`-is-light structural hazard

**What is wrong.** `:root` (`styles.css:3-123`) is a complete, separate, LIGHT
token set: `--main:#ffffff`, `--backdrop:#e9ebee`, `--accent:#3d7dff`. It
coexists with the `data-theme` blocks. Any surface that resolves to `:root`
gets light values regardless of the active theme. This is a structural
dark-theme hazard: a future surface that forgets a `data-theme` override
silently renders light-on-light in `night` mode.

**What to do.** Two options:

1. **Make `:root` an alias for the `light` theme.** Replace the literal values
   in `:root` with `var(--…)` references into the `light` block. Trade-off:
   `:root` is parsed before `data-theme` is applied, so this only works if the
   `light` block is also keyed on `:root` rather than `body[data-theme="light"]`.
2. **Leave `:root` as-is and add a lint rule.** A test that fails if any
   selector outside the three known `data-theme` blocks references a token that
   is not defined in `:root`. Trade-off: does not fix the hazard, only catches
   it.

**Recommendation: option 1.** Make `:root` the canonical light token set and
have `body[data-theme="light"]` override only what differs (which may be
nothing). This removes the hazard at the source. The `night` and `paper`
blocks stay as overrides.

**Done when** `:root` contains no literal hex values that duplicate the `light`
block, and a test asserts that every token referenced in `styles.css` resolves
to a declaration that is always in scope.

## P1-4 · Document the `--screen-*` do-not-touch constraint

**What is wrong.** There is a separate, deliberately fixed `--screen-*` palette
(`:root` lines 76-92: `--screen-card:#14161b`, `--screen-veil`, `--screen-ink`,
and the rest) used only by the full-screen onboarding/auth surfaces. The comment
at `:67-75` states it is deliberately NOT themed, for two load-bearing reasons:
those screens sit on a photograph so contrast must rest on a fixed veil; and
onboarding step 2 asks the reader to choose a theme, so a themed card would
flip light-to-dark at the exact moment they pick Dark.

**What to do.** No code change. Add a comment at the `--screen-*` block in
`styles.css` that cites this TODO item and states the constraint in one
sentence. Any theming work in Phases 3 through 6 must not quietly repaint
`--screen-*`.

**Done when** the comment exists and Phase 3 items reference it.

---

## P1-3b · Every panel was painting light, in every theme

**Status: done.** The one users actually reported.

`--surface`, `--surface-sidebar` and `--surface-chat` were declared on `:root`
and are `color-mix`es of `--main`, `--sidebar` and `--chat`. A custom property
resolves `var()` against the element it is declared on, so a `--surface` on
`:root` computed its mix against **`:root`'s own light `--main`**. The theme
blocks set those tokens on `body`, a descendant, and a descendant cannot feed a
substitution on `html`.

The result was that `.library-layout`, `.library-sidebar`, `.left-panel`,
`.editor-shell` and `.editor-center` painted light in **all three themes**, while
text and the editor texture veil reference `--main`/`--text-1` directly from
`body`, resolved correctly, and went dark. Night rendered as light panels under
light text — the original report, exactly.

Nothing errored and nothing warned. It was invisible to every check that reads a
theme block in isolation, and no test had ever rendered the app in anything but
`theme: 'light'` (`tests/support/dom-harness.mjs:65`), so the suite was green
throughout.

**The fix** moves the three declarations from `:root` into the `body` rule, where
the `[data-theme]` blocks outrank the plain tag rule and the mix resolves against
the themed tokens. `--surface-alpha-pct` stays on `:root`: it is theme-
independent.

**The guard** is `a token that derives from a themed token is not declared on
:root` in `tests/tailwind-bridge.test.mjs`. It asserts all three tokens are
absent from `:root`, present on `body`, and that `--surface-alpha-pct` stayed put.
Reintroducing the bug fails it.

Two notes for whoever reads this next:

- The naive `stylesheet.indexOf(selector)` in `tests/themes.test.mjs` matches
  against the **raw** stylesheet, comments included. A comment that spells out a
  literal selector like `body[data-theme="night"]` will be found before the real
  block and the parser reads the wrong braces. Prose in this file must not
  contain a copyable selector.
- `tests/support/dom-harness.mjs` renders `theme: 'light'` only. A regression
  that only shows in a dark theme is therefore invisible to the suite. Rendering
  each theme in at least one suite is the real fix for that hole.

---

# Phase 2 — Animation removal outside the assistant

**Status: done.** framer-motion now appears in `ChatPanel.jsx` only. Ten files
stripped, the `tileIn` keyframe and the panel-column tween removed, and
`motion.test.mjs` reduced from 26 tests to 16 — the ten that policed framer-
motion internals are gone, the sixteen that guard budgets, reduce-motion and the
canvas effects remain.

The owner's words: "Remove all animations aside from the assistant section."
This is the highest-risk phase in the backlog. It touches 11 files, a 33KB
test file, and a 3-pass test structure.

## P2-1 · Remove framer-motion from all files except `ChatPanel.jsx`

**What is wrong.** `framer-motion` is imported in 11 files: `ModalLayer.jsx`,
`Editor.jsx:20`, `Library.jsx:23`, `SettingsPage.jsx:20`, `ChatPanel.jsx:23`,
`AccountSheet.jsx:26`, `TourOverlay.jsx:22`, `ExportDialog.jsx`,
`FullScreenCard.jsx`, `main.jsx:3`, `OnboardingFlow.jsx`. Actual motion usage
is narrow: `whileTap`/`whileHover` scale taps on buttons (Library 3, Editor 6,
ChatPanel send), `AnimatePresence` mount/unmount for dialogs, panels and
popovers, panel `x` slide (`Editor.jsx:368`), outline-row fade
(`Editor.jsx:368`), message enter/exit (`ChatPanel.jsx:468-526`).

All five effect libraries (`metal-fx`, `bot-avatars`, `thinking-orbs`,
`border-beam`, `liquid-gooey`) are imported exclusively by
`src/library/chat-effects.js:31-42` and consumed only by `src/library/ChatPanel.jsx`.
The "keep motion in the assistant only" cut is clean.

**What to do.** Remove `framer-motion` imports and usage from the 10 non-chat
files. Replace `whileTap`/`whileHover` with CSS `:active` and `:hover` states.
Replace `AnimatePresence` mount/unmount with conditional rendering plus CSS
transitions where a fade is actually wanted. Replace the panel `x` slide with
a CSS `transform` transition. Keep `ChatPanel.jsx` untouched.

`src/library/motion.js` (1.8KB) is the single transition source:
`getMotionTransition`, `getPanelTransition`, `getFastTransition`. Each takes
`reducedMotion` and returns `{duration: 0}` when set. `reducedMotion` is
already threaded as a prop from `main.jsx` `useReducedMotion()` into all 11
motion files (counts: AccountSheet 3, ExportDialog 3, FullScreenCard 10, main 6,
ModalLayer 4, OnboardingFlow 2, TourOverlay 6, ChatPanel 7, Editor 5, Library 2,
SettingsPage 5). This is the ready-made seam: delete the prop from the 10
non-chat files, keep it in `ChatPanel.jsx`.

**Done when** `rg -n "framer-motion" src/` returns only `ChatPanel.jsx` and
`src/library/chat-effects.js`, and `npm run build` passes.

## P2-2 · Remove CSS animations and transitions outside the assistant

**What is wrong.** There are 2 `@keyframes` in the whole app, both in
`styles.css`: `tileIn` (`:412`, applied to `.document-tile, .new-document-tile`
at `:413`) and `sectionFlash` (`:883`, applied to
`.document-prose .section-flash::after` at `:882`). There are 21 `transition:`
declarations and 2 `animation:` declarations in `styles.css`. There are zero
`animate-*` and zero `transition-*` Tailwind utility classes in any JSX.

`body.reduce-motion` already nukes all motion CSS at `styles.css:276-281`.

**What to do.** Remove `tileIn` and `sectionFlash` keyframes and their
applications. Audit the 21 `transition:` declarations and remove any that
exist only to serve a framer-motion replacement. Keep transitions that are
purely visual (hover color fades, opacity) and do not affect layout or motion
perception.

**Done when** `rg -n "@keyframes" src/styles.css` returns nothing, and the
remaining `transition:` declarations are all under 200ms and serve hover or
focus states only.

## P2-3 · Restructure the motion test suite

**What is wrong.** `tests/motion.test.mjs` is 33KB, dedicated to motion, and
asserts each transition helper is "defined exactly once."
`tests/app-render-motion.test.mjs` exists as a whole separate pass solely
because the mocked pass "cannot see the animation layer at all, and a visibly
broken library grid once passed six filter tests there."

Removing framer-motion app-wide will likely collapse the 3-pass structure in
`scripts/test-js.sh`. Named tests that will break: "the document title rename
survives the real animation layer", "the panels are mounted and no longer
sized by an animation", "closing a panel slides it off-screen and makes it
inert".

**What to do.** Three options:

1. **Keep the 3-pass structure.** The real-motion pass still covers
   `ChatPanel.jsx`, so it is not dead. Trade-off: the pass is now much smaller
   and may not justify its runtime.
2. **Collapse to 2 passes.** Merge the real-motion pass into the mocked pass
   for the remaining chat-only motion tests. Trade-off: loses the "real
   framer-motion" coverage that caught the library grid bug.
3. **Keep `motion.test.mjs` as a unit test, delete `app-render-motion.test.mjs`.**
   The unit test covers `src/library/motion.js` (which stays, since ChatPanel
   uses it). The render pass is no longer needed if no non-chat file uses
   framer-motion. Trade-off: the library grid bug that motivated the separate
   pass is not covered by the remaining tests.

**Recommendation: option 3.** `motion.test.mjs` stays as a unit test for
`src/library/motion.js`. `app-render-motion.test.mjs` is deleted. The three
named tests that break are re-homed: "the document title rename survives the
real animation layer" becomes a unit test on `motion.js`; "the panels are
mounted and no longer sized by an animation" and "closing a panel slides it
off-screen and makes it inert" are deleted because the behavior they tested no
longer exists. Add a test that asserts no non-chat file imports framer-motion.

**Done when** `scripts/test-js.sh` is updated, `tests/motion.test.mjs` passes
as a unit test, `tests/app-render-motion.test.mjs` is deleted, and
`scripts/check-test-lists.mjs` passes.

## P2-4 · Audit `tests/effect-stack.test.mjs`, `tests/render-cost.test.mjs`, `tests/bundle-shape.test.mjs`

**What is wrong.** These three test files touch the motion area. Their exact
assertions are not documented in the verified evidence, so they must be read
before P2-1 lands.

**What to do.** Read each file, identify which assertions depend on
framer-motion being present in non-chat files, and update or delete those
assertions. Register any changes in `scripts/test-js.sh`.

**Done when** all three files pass against the post-P2-1 codebase.

---

# Phase 3 — Onboarding and auth cleanup

**Status: done — by removal, not rework.** The owner changed their mind about
these surfaces and asked for the auth screen and the onboarding feature to be
taken out rather than tidied. So the files are gone, not cleaned:

| Deleted | |
| --- | --- |
| `src/OnboardingFlow.jsx` | the welcome card |
| `src/TourOverlay.jsx` | `LibraryTour` and `CoachMarks` |
| `src/FullScreenCard.jsx` | the full-viewport wrapper both of them used |
| `src/platform/useTargetRect.js` | tour cutout geometry |
| `src/library/onboarding.js` | `resolveOnboardingResume` |
| `src/library/tour.js` | tour step table |
| `tests/onboarding.test.mjs`, `tests/onboarding-resume.test.mjs`, `tests/tour.test.mjs`, `tests/tour-geometry.test.mjs` | guards for the above |

`SignInSheet` was removed from `src/AccountSheet.jsx`. That file now holds only
`AccountChip`, which is a status readout rather than a control: it is a `div`,
not a `button`, with no `aria-haspopup`/`aria-expanded`, because there is no
sheet behind it any more and a dead control is worse than no control.
`tests/account.test.mjs` asserts that (P3-2).

Wiring removed from `src/main.jsx`: the `onboardingOpen`/`onboardingReplay`/
`tourOpen`/`coachDismissed`/`coachOpen` states, the `replayOnboarding`,
`closeOnboarding`, `completeOnboarding`, `finishTour` and `dismissCoach`
callbacks, `accountSheetOpen`, `openAccountScreen`, the bootstrap
`Promise.all` over `store.readOnboarding(...)`, and the `onAccount` prop from
`Library`/`Editor`. `SettingsPage` lost its "Show onboarding again" row.

CSS: the `.screen-*`, `.onboarding-*`, `.tour-*`, `.coach-*` and `.account-*`
rule blocks were removed (67 + 13 rules), along with the stale `/* -- P5- */` and
`/* -- P6- */` section headers. The `--screen-*` custom properties were
deliberately **kept** — they are theme tokens, and the contrast gate enumerates
them independently of whether a rule still reads one.

The chip lost its button affordances with it: `cursor: pointer` became
`cursor: default`, and the `button.user-chip:hover` rule went. A readout that
still looked clickable and did nothing on click was worse than no readout. The
layout properties that were not button-specific (`width: 100%`, `text-align`)
were folded into the base `.user-chip` rule rather than dropped.

`store.readOnboarding`/`writeOnboarding` and the Rust `onboarding_state` table
are **kept**: an existing install's flags are still on disk, and deleting the
store would be a schema migration for no user-visible gain. Only the frontend
call sites are gone.

Every `reducedMotion` pass-through outside the assistant is gone — the prop now
reaches exactly one consumer, `ChatPanel`, via `main.jsx → Editor → ChatPanel`,
which is the only place still animating.


The owner's words: "Onboarding and the auth screen: rework/clean these up."
Both are already full-screen surfaces, not dialogs, and both render through
`src/FullScreenCard.jsx` on the fixed `--screen-*` palette.

## P3-1 · Clean up `OnboardingFlow.jsx`

**What is wrong.** `src/OnboardingFlow.jsx` has 4 stages: a welcome card
(stage 0) plus 3 sheet steps from `SHEET_STEP_KEYS`: `step_theme` ("Pick a
look"), `step_provider` ("Bring your own key"), `step_library` ("A few things
to try"). Copy is the `STEP_COPY` map at `:49-67`; `TOTAL_STAGES =
SHEET_STEPS.length + 1` at `:79`. Progress is persisted per-step in
`onboarding_state` as it happens, so relaunch resumes mid-flow (`:21-27`);
`src/library/onboarding.js` holds `resolveOnboardingResume`;
`tests/onboarding-resume.test.mjs` covers it.

**What to do.** The owner asked for a "rework/clean." The specific cleanup
items are not enumerated in the verified evidence, so this item is a
placeholder for the actual rework. What must be preserved: per-step resume
(`onboarding_state` persistence and `resolveOnboardingResume`), the
`STEP_COPY` map structure, and the `--screen-*` palette (P1-4). Any rework
that changes the stage count or step keys must update `SHEET_STEP_KEYS`,
`STEP_COPY`, `TOTAL_STAGES`, and `tests/onboarding-resume.test.mjs` in the
same commit.

**Done when** the rework is complete, `tests/onboarding-resume.test.mjs`
passes, and `npm run check` is green.

## P3-2 · Clean up `AccountSheet.jsx`

**What is wrong.** `src/AccountSheet.jsx` has `SignInSheet` at `:126`, `mode`
= `signin`|`signup`. Fields: `name` (`:330`, `autoComplete="name"`, signup
only), `email` (`:337`, `autoComplete="email"`), `password` (`:347`,
`autoComplete` switches `new-password`/`current-password`), `confirm` (`:362`,
signup only), plus a sync toggle (`:313`, `role="switch"`). Calls
`accountSignIn`/`accountSignUp`/`accountSignOut`/`syncConfigWrite` from
`src/platform/store.js`. Error region uses `role="alert"` (`:288`).

**What to do.** Same caveat as P3-1: the specific cleanup items are not
enumerated. What must be preserved: the `mode` switch, the `autoComplete`
attributes (they are part of the password-manager contract), the `role="alert"`
error region, and the `--screen-*` palette. The `role="switch"` sync toggle is
a candidate for a shadcn `Switch` in Phase 6, but that migration is not this
item.

**Done when** the rework is complete, `tests/account.test.mjs` and
`tests/account-state.test.mjs` pass, and `npm run check` is green.

## P3-3 · Clean up `TourOverlay.jsx`

**What is wrong.** `src/TourOverlay.jsx` is the separate library tour, also
framer-driven (10 refs). It is not onboarding and not auth, but it is a
full-screen overlay that the owner's "rework/clean" instruction plausibly
covers.

**What to do.** Read the file, identify what "clean" means in context, and
propose the specific changes. Preserve any geometry or positioning logic that
`tests/tour-geometry.test.mjs` covers.

**Done when** the rework is complete, `tests/tour.test.mjs` and
`tests/tour-geometry.test.mjs` pass, and `npm run check` is green.

---

# Phase 4 — Settings overflow

**Status: done.** `min-height: 0` on `.settings-page` and `.settings-form`,
`align-items: stretch` on the body, and the orphaned `.settings-nav` rail is now
rendered from a `SETTINGS_SECTIONS` list.

The owner's words: "Settings screen: add an overflow." The root cause is a
precise CSS bug, not a missing feature.

## P4-1 · Fix the flex chain in `.settings-page`

**What is wrong.** In `styles.css`:

- `.settings-page` (`:965`) is `display:flex; flex-direction:column; flex:1;
  min-width:0`. It has no `min-height: 0`.
- `.settings-page-body` (`:987`) is `display:flex; flex:1; min-height:0;
  align-items:flex-start`.
- `.settings-form` (`:1037`) is `flex:1; min-width:0; overflow-y:auto;
  padding-bottom:40px`. It has no `min-height:0` and, because the parent sets
  `align-items:flex-start`, it does not stretch; it collapses toward content
  height.

Combined effect: in a short window the form grows past the viewport and the
only `overflow-y:auto` in the chain cannot help, because the flex item it
belongs to never got a bounded height. The scroll never engages and the content
below the fold is unreachable, because `body` sets `overflow:hidden`
(`styles.css:130`) and `.app-shell` clips, so there is no window scroll to fall
back on either.

**Orphaned CSS, and it changes the shape of the fix.** `styles.css:990-1012`
styles a `.settings-nav` rail — `position: sticky; top: 0`, with an
`@media (max-width: 720px) { .settings-nav { display: none } }` rule. **No JSX
renders it.** `SettingsPage.jsx` goes `.settings-page` > `.settings-page-body` >
`.settings-form` and nothing else; `settings-nav` appears in no `.jsx` file in
the project. The sticky rail and its `scroll-margin-top` companion are dead
selectors waiting for a rail that was never wired up.

Decide which this is before fixing the chain:

- **Keep the rail design** — render `.settings-nav` from the section list, and
  the sticky positioning plus `.settings-section { scroll-margin-top: 12px }`
  (`:1041`) start doing their job. More work, but the stylesheet and the
  `.dialog-keyboard.test.mjs` expectations already assume a rail.
- **Delete the rail CSS** — fix only the flex chain and remove the dead rules.
  Smaller, and honest about what the screen actually is.

Do not leave it half-wired in either direction.

**What to do.** Add `min-height: 0` to `.settings-page` (`:965`) and to
`.settings-form` (`:1037`). Change `.settings-page-body` (`:987`) from
`align-items:flex-start` to `align-items: stretch` (or remove the declaration,
since `stretch` is the default). This lets `.settings-form` receive a bounded
height from the flex chain, which is what activates its `overflow-y:auto`.

Preserve the page-not-dialog design: `tests/dialog-keyboard.test.mjs` has
"Settings is a page, so focus is not trapped" and "Settings has no scrim,
because there is nothing behind it."

**Done when**

- In a short window the form scrolls internally and the bottom section is
  reachable.
- The `.settings-nav` decision is made and either rendered or deleted — not
  left orphaned.
- `tests/dialog-keyboard.test.mjs` passes unchanged.

---

# Phase 5 — Library content previews

**Status: done.** `excerptFrom()` in `appearance.js`, folded into the existing tile
memo so the HTML is walked once. Covers show a preview and fall back to the
monogram when a document has no text.

The owner's words: "use papers preview of what was on the page: render a
preview of the actual document content on the library tiles, instead of the
current monogram."

## P5-1 · Confirm the preview data source before building it

**Good news: the data is already there.** This looked like the expensive part of
the request and is not. `Library.jsx:94` already reads `doc.content` for the
per-tile word count:

```js
counts.set(doc.id, countWords(doc.content.replace(/<[^>]+>/g, ' ')))
```

`doc.content` is the document body as HTML, delivered by `list_documents`
(`src/platform/store.js:122`) and backed by the `content TEXT NOT NULL` column
at `src-tauri/migrations/0001_init.sql:13`. It is already in memory on the
library screen, for every tile, right now.

So the fork is not "Yjs read vs denormalised column." It is only "how do we
derive a preview from HTML we already hold." Three options:

1. **Derive the excerpt in the renderer, from `doc.content`.** Reuse the exact
   regex already at `Library.jsx:94`, keep the plain text, take the first
   ~40 words. Trade-off: the strip-and-count pass already runs over every
   document's whole HTML on every render of `filteredDocs`; adding a second
   regex pass duplicates work that is already the screen's most expensive
   operation. If done at all, do it in the **same** `useMemo` that builds
   `wordCounts` so there is one pass, not two.
2. **Have the Rust side return a plain-text excerpt alongside the HTML.**
   `list_documents` already returns `content`; it could also return a truncated,
   tag-stripped `excerpt`, computed once in SQL/Rust instead of per render in
   JS. Trade-off: touching the IPC surface and the command's return shape, so
   `src/platform/store.js`, the browser localStorage path, and the store's
   own tests all have to move together. Cheapest at runtime, widest blast
   radius.
3. **Add a persisted `excerpt` column.** Rejected. It introduces a second copy
   of document content that can drift, which the schema deliberately avoids.

**Recommendation: option 1**, folded into the existing `useMemo` at
`Library.jsx:91-97` so the HTML is walked once per render, not twice. It stays
inside the renderer, changes no IPC contract, and needs no schema work. Choose
option 2 only if profiling shows the library render is the bottleneck — it is
the correct fix for runtime cost but it is not the cheapest correct thing today.

Note the existing comment at `Library.jsx:89-90` flags that pass as a known cost
("a regex strip plus a whitespace split over each document's whole HTML, on
every render"). Adding a second strip without folding it into the same memo
makes a flagged problem worse, so P5-2 must not do that.

**Done when** the choice is recorded in a comment citing this item next to the
memo, and the preview text is available to the tile render.

## P5-2 · Replace the monogram with a content preview

**What is wrong.** Tiles render at `src/library/Library.jsx:127`:
`<div className="document-cover" style={{'--cover': coverColorFor(doc)}}><span className="cover-monogram">{initialsFor(doc.title)}</span></div>`.
`initialsFor(title)` is at `src/library/appearance.js:65`; `coverColorFor(doc)`
is also there. `.cover-monogram` is styled at `styles.css:449` (46px / 34cqi,
weight 800) and hidden in list view at `:482`.
`tests/cover-monogram.test.mjs` (12KB) covers it.

**What to do.** Replace the monogram span with a preview element. Keep
`.document-cover` and `--cover` as the background layer so the existing palette
still carries the tile. Hide the preview in list view, exactly as
`.cover-monogram` is hidden at `styles.css:482`.

Decide and write down what happens for an **empty document**: `content` defaults
to `''` (`0001_init.sql:13`), so a new blank tile has nothing to preview. Falling
back to the monogram is the pragmatic answer and means the monogram code stays.

**Update the test, do not just delete it.** `tests/cover-monogram.test.mjs` also
guards the cover palette against an unreadable swatch — `check-contrast.mjs`
imports `COVER_PALETTE` from `appearance.js` for the same reason. Keep palette
contrast covered, replace the monogram-typography assertions with preview
assertions, and add the empty-document case. If the test is renamed,
`scripts/check-test-lists.mjs` requires the new name in `scripts/test-js.sh`
or the suite silently stops running.

**Done when** tiles show a content preview, list view hides it, an empty
document falls back predictably, the palette guard survives, and `npm run check`
is green.

---

# Phase 6 — shadcn migration

**Status: done, with one documented boundary.** Every control that is an action
in the action sense is now built from a shadcn primitive: 8 `<select>`s, 4 radio
groups, the account switch, both modal dialog surfaces, and 23 text-labelled
buttons. 54 `<button>`s remain native and are meant to -- see the boundary below.


**Status: part done.** `button.jsx`, `input.jsx`, `select.jsx` and
`radio-group.jsx` are authored, prefix-clean and building. The guard test now
catches a fourth failure mode the first three components all shipped with — see
P6-0. **No consumer has been migrated**, because the first attempt exposed a
blocker that is not a migration but a redesign; P6-1 records it.

## P6-0 · The prefix goes at the front, once — and every component got it wrong

**Status: done.** `tests/shadcn-prefix-guard.test.mjs` now rejects a repeated
prefix, and all four components are fixed.

Tailwind v4 places `prefix(tw)` once, at the head of the chain:

```
tw:focus-visible:ring-2      correct
tw:focus-visible:tw:ring-2   wrong — generates nothing
```

The second segment becomes the literal string `tw`, which matches no utility, so
the rule silently disappears. It reads as correct because shadcn's own source is
`focus-visible:ring-2` and the prefix appears to belong on each part.

**All four components shipped this in every variant chain** — 39 tokens, every
`hover:`, `focus:`, `disabled:`, `data-[…]:` and `focus-visible:` rule in the
directory. It was caught only by grepping the built CSS for the emitted selector
rather than the class, and only because `tw:ring-2` was absent from
`dist/assets/*.css`. The guard returned `ok` the moment it saw the first `tw:`,
which is the design flaw: it checked the head of the chain and stopped looking.

So the guard now also rejects `repeated`, with fixtures. The lesson is recorded
in `src/library/ui/README.md` beside the other three failure modes.

## P6-1b · Done: dialogs, and the five settings selects

**Status: done.**

**Dialogs.** `ModalLayer` is now Radix's `Dialog.Root`, and `ExportDialog`
renders through `Dialog.Content` with a `Dialog.Title`. Two judgement calls worth
recording:

- **The hand-rolled focus trap was kept.** Radix brings its own focus scope, but
  it enumerates tabbable candidates with a different selector than
  `platform/a11y.js`, so a surface wired to both can only be tested by one. The
  root is used for what it is better at — routing Escape and outside-pointer
  dismissal back to `onClose` — and the trap stays where
  `dialog-keyboard.test.mjs` asserts against. All 14 of those tests pass
  unmodified.
- **The scrim stayed a real clickable button.** Radix's overlay is not a dismiss
  target, and the scrim is the only one a pointer user has besides the close
  button. It needed `pointer-events: auto`, because a modal `Dialog.Content`
  disables them on the body and re-enables them on the content alone — without
  that the scrim silently stops being clickable.

`FullScreenCard.jsx` was deliberately **not** migrated: onboarding and auth are
full-screen, non-modal and `aria-modal="false"` by design, and
`tests/account.test.mjs` asserts it.

**Selects.** Five of the eight are migrated: `detail-kind`, `detail-status`,
`provider`, `font`, `density`. The existing class is passed through to
`SelectTrigger` so the visual design is unchanged — this is a change of
construction, not of appearance.

`tests/settings-controls.test.mjs` is new and registered. It exists because
nothing tested these controls: the suite was green before the migration and
equally green after, which is not evidence of anything. It asserts each trigger
mounts, carries its id so the `<label for>` still binds, and shows the value the
setting already holds — and that the assistant's two selects are still native,
so the omission is recorded rather than forgotten.

## P6-1 · Blocked: migrating a native `<select>` is a redesign, not a swap

**Status: not done. Read this before starting the bulk migration.**

`ThemePicker`'s theme `<select>` was migrated to the new `Select` and reverted.
What it cost, for one control:

- `tests/theme-picker.test.mjs` drives the control through a `choose()` helper
  that reads `<option>` elements. Radix renders no `<option>`; it builds its own
  listbox and a hidden native select only inside a form. Ten of its fifteen
  tests failed on `an option reading Midnight, got ` — empty, because there is
  no option to read.
- Making them pass means rewriting the helper to simulate pointer and keyboard
  interaction with a Radix listbox, which needs `hasPointerCapture`,
  `scrollIntoView` and friends stubbed in `tests/support/dom-harness.mjs`.
- Radix also reads `HTMLFormElement`, `DocumentFragment` and `HTMLSelectElement`
  off the global scope, none of which a bare Node global scope provides. Those
  three globals are now defined in the harness, because they are needed the
  moment any Select mounts and their absence throws before a single assertion
  runs rather than failing one.

**Conclusion for the phase.** Every remaining control in the list is the same
shape: the current element is driven by a native contract that the tests use,
and shadcn replaces that contract with a composed widget. This is the decision
P6-4 already flagged, now with evidence: the migration is also a visual
redesign, because every one of these controls currently carries a hand-written
class from `styles.css`.

It should be done as its own piece of work, per control, with the design decided
first — shadcn's look or the existing look — and with the test helper rewritten
as part of the change rather than after it.

The owner's words: "use shadcn/ui for ALL elements (select, buttons, etc.)."
This is the largest surface in the backlog: 57 `<button>`, 4 `<input>`,
2 `<select>` across 14 files, plus nine hand-rolled ARIA widgets. It is done
incrementally after Phases 0 through 5 land, ordered by risk.

#### Two things to know before starting

**There is zero `data-[…]` variant usage in this codebase today.** shadcn
components are built on Radix state attributes — `data-[state=open]`,
`data-[side=left]`, `group-data-[state=checked]`. Nothing here uses that
pattern, so the open/closed/checked styling idiom is genuinely new to this
project rather than something being adopted. It is also the thing most likely
to break silently: a `data-[state=open]` variant that fails to match produces
an unstyled panel, not an error.

**Two ARIA roles in the codebase are invalid.** `role="note"` and
`role="presentation"` appear in the markup. `note` is not a role in the ARIA
spec; it is silently dropped by assistive tech. Fix these as part of the
migration rather than carrying them forward — a migration that ports a11y bugs
alongside the components has not improved anything.

**Migration order rationale.** Start with the primitives that are
self-contained and high-signal, then the ones whose behaviour is load-bearing.
`Select` and `RadioGroup` first because they are small and well-tested by
shadcn itself. Dialogs **last**, not first, despite P6-1 being the biggest
behaviour risk: the focus trap is the app's strongest existing a11y asset, and
it is worth having the rest of the surface settled before touching it.

## P6-1 · Migrate selects

**What is wrong.** There are 2 `<select>` elements across the codebase. shadcn
has a `Select` primitive backed by `@radix-ui/react-select`.

**What to do.** Replace each `<select>` with shadcn `Select`. There are only
2, so this is low-risk, and it is the cheapest place to prove the P0-2 prefix
strategy end to end on a real installed component.

**Done when** both selects use shadcn `Select`, `npm run check` is green, and
the emitted CSS contains the prefixed class.

## P6-2 · Migrate the theme picker radio group

**What is wrong.** The theme picker is a radio group, not a select: 4
`role="radiogroup"` + 4 `role="radio"` across the codebase. shadcn has a
`RadioGroup` primitive backed by `@radix-ui/react-radio-group`.

**What to do.** Replace the hand-rolled radio group with shadcn `RadioGroup`.
Preserve the visual design and the `data-theme` application logic in
`main.jsx`. Keyboard behaviour is the thing to check by hand: arrow-key
navigation within a radiogroup is behaviour the hand-rolled version may not
have implemented, and losing it would be a regression disguised as an upgrade.

**Done when** the theme picker uses shadcn `RadioGroup`, arrow-key navigation
works, and `tests/theme-picker.test.mjs` plus `tests/themes.test.mjs` pass.

## P6-3 · Migrate inputs and remaining ARIA widgets

**What is wrong.** 4 `<input>`, plus the widgets shadcn/Radix replace
directly: 1 `role="switch"`, 1 `role="listbox"`, 1 `role="option"`,
1 `role="menu"`, 1 `role="menuitem"`, 2 `role="toolbar"`.

**What to do.** Migrate to shadcn `Input`, `Switch`, `Command`/`Popover` for
the listbox, `DropdownMenu` for the menu pair, `Toolbar` for the toolbars.
Fix `role="note"` to a real element while the surrounding code is open.

**Done when** each widget uses its shadcn equivalent, no invalid roles remain,
and `npm run check` is green.

## P6-4 · Migrate buttons

**What is wrong.** There are 57 `<button>` elements across 14 files: ChatPanel
20, SettingsPage 19, AccountSheet 11, ThemePicker 9, BackgroundPicker 6,
ExportDialog 4, FullScreenCard 3, TourOverlay 3, Editor 3, Library 3, main.jsx 2,
OnboardingFlow 1, ModalLayer 1, ErrorBoundary 1.

**What to do.** Replace `<button>` with shadcn `Button`, or `Button` with `asChild`
where the button is really a link or custom element. This is a large mechanical
change. Do it file by file, lowest risk first (`ErrorBoundary`, `ModalLayer`,
`OnboardingFlow`) and highest risk last (`ChatPanel`, `SettingsPage`).

The risk is not mechanical, it is visual. Every one of these buttons currently
carries a hand-written class string from `styles.css` (`.icon-button`,
`.soft-button`, `.account-submit`, `.publish-button`, `.panel-toggle`,
`.details-button`, `.nav-count` and more). shadcn `Button` brings its own
variants. Migrating all 57 is therefore also a visual redesign, and it should
be treated as one: decide per file whether to adopt shadcn's look or keep the
existing class and take only the behaviour. Mixing both without deciding is how
a codebase ends up with two button styles and no rationale for either.

**Done when** every button uses shadcn `Button`, the variant strategy is written
down, and `npm run check` is green.

## P6-5 · Migrate dialogs and the focus trap — last, deliberately

**What is wrong.** Only `ExportDialog` has a real focus trap today
(`ExportDialog.jsx:39-67`: focus first control on mount, re-focus via a
`focusin` listener, restore on close). There are 5 `role="dialog"` surfaces.
`tests/dialog-keyboard.test.mjs` covers the trap thoroughly, including "a
dialog with no focusable control still holds focus", "Escape does not reach the
app-level shortcuts while a dialog is open", and "Tab from the last control
wraps to the first". Radix Dialog brings its own trap.

**This is the highest-risk item in the backlog and it is ordered last on
purpose.** The hand-rolled trap is a genuine asset with genuine test coverage,
and it is also *different* from Radix's: it re-focuses anything that escapes the
node via a `focusin` listener and restores focus to the trigger on close.
Radix's trap and focus-restore behaviour is not identical in every case — most
likely to diverge on "a dialog with no focusable control still holds focus",
because that is precisely the case the hand-rolled version had to think about.

**What to do.** Replace the trap with `@radix-ui/react-dialog` one surface at a
time, running `tests/dialog-keyboard.test.mjs` after each. Do not batch all five.
Preserve the app-level shortcut suppression while a dialog is open — there is a
test for it, and it is easy to lose when the component that owned it changes.

**Done when** each dialog uses `@radix-ui/react-dialog`, and the full
`tests/dialog-keyboard.test.mjs` suite passes **unmodified**. If a test needs
editing, that is a signal the Radix behaviour differs in a way that needs
deciding, not a test to update.

---

# Phase 7 — Carried-over backlog

Tracked but not scheduled. These are not part of the owner's current
priorities.

- Document sync and collaboration (Yjs over a network transport).
- PocketBase as a remote replica (the schema comment in `README.md` says
  "PocketBase will be added later as a remote replica, never as a second
  source of truth").
- Sidecar processes for AI providers.
- Additional importers beyond the legacy Python format.

---

# Constraints worth not rediscovering

Each of these is a hard-won fact that a future engineer must not break. They
are stated as constraints, not history.

**The `tw:` colon prefix is load-bearing.** `src/tailwind.css` uses
`prefix(tw)`, so `tw:flex` works and `tw-flex` silently generates nothing. The
prefix exists because Quill's own class names collide with Tailwind utility
names (`outline`, `border`, `shadow`, `container`, `ring`, `table`, `hidden`).
Unprefixed Tailwind shipped a visible bug: `<nav class="outline">` rendered
with a 1px white box. `KNOWN_COLLISIONS` in `tests/tailwind-bridge.test.mjs`
re-derives the collision set from a real build. Do not remove the prefix.

**The scanner is scoped to `src` only.** `@source './'` in `tailwind.css` is
deliberately scoped to `src` so test fixtures do not emit phantom utilities
(`tailwind.css:158-172`). Do not widen the scope.

**The custom `dark` variant is keyed on `data-mode`, not `data-theme`.**
`tailwind.css:186` wires `@custom-variant dark (&:where([data-mode='dark'],
[data-mode='dark'] *))`. `data-mode` is set from the resolved theme's mode,
not from the theme name. Do not change this to `data-theme="night"`; custom
themes use `data-mode` too.

**The test-list guard is a hard gate.** `scripts/check-test-lists.mjs` fails
the build if any `tests/*.test.mjs` is not named in `scripts/test-js.sh`. A
new test file that nobody registered is never executed while `check` still
reads green. Every new or renamed test MUST be registered.

**The `--screen-*` palette is deliberately not themed.** It is used only by
the full-screen onboarding/auth surfaces. Those screens sit on a photograph so
contrast must rest on a fixed veil, and onboarding step 2 asks the reader to
choose a theme, so a themed card would flip light-to-dark at the exact moment
they pick Dark. Do not add `--screen-*` to the `data-theme` blocks.

**The `documents` table holds `content`, but it is not the source of truth.**
`src-tauri/migrations/0001_init.sql:13` declares
`content TEXT NOT NULL DEFAULT ''` alongside `content_format`, and
`list_documents` (`src/platform/store.js:122`) returns it — which is why
`Library.jsx:94` can count words straight off `doc.content` with no extra read.
The editable body of record is the Yjs store (`ydoc_updates`,
`src/platform/ydoc.js`); `content` is a stored rendering of it. So a library
preview can be derived in the renderer for free (P5-1), but **do not treat
`content` as authoritative** — a preview derived from it is only as fresh as
whatever last wrote that column, and nothing should depend on the two agreeing
without saying so.

**`body.reduce-motion` nukes all motion CSS.** `styles.css:276-281` already
disables all animation and transition when `reduce-motion` is set. Any new
motion must respect this. The `reducedMotion` prop is threaded from
`main.jsx` `useReducedMotion()` into all motion-consuming files; use that seam,
not a new one.

**Comments cite TODO item numbers.** Comments across the codebase reference
`P{N}-{M}` identifiers (e.g. "P4-2.", "Phase 2 puts bold initials on the
cover"). Renaming phases freely will orphan those comments. Prefer keeping
the `P{N}-{M}` identifier shape.

## P6-6 · The boundary: 54 buttons stay native, and why

**Status: decided. Do not "finish" these without a decision.**

Migrated: the 23 buttons that carry a text label and act as an action —
`soft-button` (19, including the `primary` variant) and `account-submit` (2),
now shadcn `Button`.

Left native: 54 buttons that are icon-only, state toggles, or bespoke
surfaces. `icon-button`, `tile-menu`, `dialog-close`, `chat-control`,
`chat-suggestion`, `model-trigger`, `modal-scrim`, `screen-back`, `publish-button`,
`details-button`, `document-title-button`, `assistant-head-action`, `add-section`,
`invite`, `share-copy`, `share-close`, `show-earlier`.

Three reasons, and the second is the one that decides it:

1. shadcn `Button` has no variant that carries their geometry. They are 28×28
   squares, or full-bleed rows, or a full-viewport scrim. Adopting `Button` means
   overriding `h-9`, `px-4` and `rounded-md` on every one of them, which is a
   class list fighting itself to reproduce what a plain `<button>` already is.
2. **They are not buttons in the action sense.** They are toggles
   (`aria-pressed`), dismissals, and a scrim that must stay out of the tab order
   and out of the accessibility tree. Radix supplies those as Dialog, DropdownMenu,
   ToggleGroup and Tooltip, not as `Button`. Swapping in `Button` would be a
   downgrade: it would add a focus ring and a pressed treatment to controls whose
   whole job is to be quiet.
3. Passing the existing class through would preserve the appearance exactly —
   `styles.css` is unlayered and Tailwind's utilities are layered, so author CSS
   wins (`tailwind-bridge.test.mjs:281` asserts that invariant) — which is why the
   23 migrated buttons are safe. But for a bespoke control that safety buys
   nothing: the outcome would be visually identical while claiming to be a
   migration.

So the honest end state is that shadcn owns the *controls* — the things a reader
operates and that have state, value, or a popup — and the app keeps plain
buttons for the things that are pixels with an event handler. Migrating those 54
would be churn with no benefit and a real chance of a regression, and none of
them are covered by a test that would notice.


---

# Phase 8 — Settings redesign

**Status: done.** Restructured `SettingsPage.jsx` to the two SaaS references the
owner supplied. Sections are now `AssistantPanel` / `AppearancePanel` /
`WritingPanel` at module scope, chosen by a `SETTINGS_SECTIONS` table that carries
each panel's component alongside its id, title and note.

Copied from the references: a horizontal tab bar (one section at a time), section
heads with a note, label-and-explanation on the left with the control on the right,
and selectable card grids for Theme and Library density with check badges on the
selected card. Theme and density are `role="radiogroup"` groups, so the cards
announce as one control with a value rather than as four buttons.

Rejected, on purpose: the **Cancel / Save changes footer**. Both references have
one. Quill autosaves 350ms after every change and the header says so, so a Save
button would be a control that does not describe what the page does. The owner
chose to keep autosave. There is still no dirty-state diff and no
unsaved-changes warning, because there is nothing unsaved.

Accessibility: the tab bar is a real `role="tablist"` with `aria-selected`,
`aria-controls`/`aria-labelledby`, a roving `tabIndex` (only the active tab is in
the tab order) and Left/Right/Home/End arrow navigation. Escape still closes the
page; focus still moves to the page on open and returns to the opener on close.

**One test was updated, not weakened.** `tests/settings-controls.test.mjs`
asserted `#density` was a `BUTTON` — true while density was a `<select>`, false now
that it is a card grid. The dropdown assertion was narrowed to the two controls
that are still dropdowns (`provider`, `font`) and a new test asserts density is a
named radio group with exactly one `aria-checked` option equal to the stored
value. That is a stronger claim than the one it replaced. No behavioural or state
assertion was removed.

Note for whoever touches this next: the panels are module-scope components, so
they can only reach `SettingsPage`'s state through the `panelProps` object. A
panel that calls `setDraft` directly throws at runtime, not at build time —
`BackgroundPicker` changes several keys at once, so it takes `applyPatch` rather
than the one-key `update`.

# Phase 9 — Library tiles as paper sheets

**Status: done.** `.document-cover` is a sheet rather than a panel: a warm
off-white face, a cut-paper edge, a softer radius and a real two-part shadow
(contact + ambient). A `--sheet-*` token family carries it, with the two derived
shadows declared on `body` beside `--surface` — on `:root` they would compute
against the wrong scope and night would lift with the light theme's shadow.

The sheet stays light in the dark theme: `--sheet-face` is fixed in `:root`, so it
is one sheet under every lamp, and `night` only firms the edge and switches
`--sheet-shade` to black. `.new-cover` is `transparent` with a dashed edge so it
stays an invitation rather than the one filled tile.

No per-document colour, monogram, spine, sheen or preview text was reintroduced.

This also surfaced a real bug: `runTokenClosure` in `scripts/check-contrast.mjs`
called `Object.keys()` on a `Map`, which is always `[]`, so the token-closure
check could only ever report success. It had never fired because no theme block
used `var()`; night's `--sheet-shadow` was the first. Fixed to
`Object.fromEntries`, matching what `readThemes` in the same file already did.
