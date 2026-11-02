# Narrow-width regression fixes — Settings entry point and empty strip

## Context: what is already done, do not redo

Five changes were implemented and the gates were green at **296 passing, 0 failing**:

| Change | State |
| --- | --- |
| (a) AccountChip removed | `src/AccountSheet.jsx` deleted; no call sites; no `user-chip` in `src/`, `tests/`, `scripts/` |
| (b) Library tile hover motion removed | no `translateY(-3px)`, no `scale(0.99)`, no `--sheet-shadow-lift`; resting `--sheet-shadow` and the `nth-child` entrance stagger deliberately kept |
| (c) Settings button moved to the sidebar | `Library.jsx:113` and `Editor.jsx:365`, class `sidebar-settings`, styled by `.sidebar-settings { width: 100%; margin-top: auto }` (styles.css:752) |
| (d) Graphics row removed | `describeGraphics` gone from `SettingsPage.jsx` and `capabilities.js`; `hasWebGL2` and the `ChatPanel.jsx` send-button gate deliberately kept |
| (e) Sidebar visible beside Settings | `.settings-layer` is a flex sibling; `.app-shell.settings-open` rules at styles.css:1060-1075 |

**Preserved on purpose:** the `account` state in `main.jsx` is still load-bearing
(`accountName = describeAccount(account).name` → `<Editor author={accountName}>`),
as are `src/library/account.js`, the `account_state` store bridge, `hasWebGL2`,
and `src/platform/capabilities.js`.

Two tests use the moved button's selector and were updated to the new location:
`tests/settings-controls.test.mjs` and `tests/dialog-keyboard.test.mjs`, both via
`.library-sidebar .sidebar-settings`. `theme-picker.test.mjs` and
`background-picker.test.mjs` were updated the same way.

---

## Remaining work — two defects introduced by (c) + (e) together

Both are narrow-width only. Neither was caught by the suite, which runs at one
viewport.

### Defect A — Settings is unreachable in the library below 940px

**Status.** `[x]` complete — fallback button at `Library.jsx:116`, CSS at `styles.css:757`
(`.settings-fallback { display: none; }`) and `styles.css:1261` (`display: inline-flex` inside the
940px media query). Verified: build clean, 296 passing.

**Cause.** The Settings button now exists in exactly one place in the library:
`Library.jsx:113`, inside `<aside className="library-sidebar">`. But
`styles.css:1253` has `@media (max-width: 940px) { .library-sidebar { display: none } }`.
At narrow widths the sidebar is gone, so there is no route to Settings at all from
the library. Before change (c) the button lived in `.library-main-tools` in the
header, which is visible at every width — so this is a regression, not a
pre-existing gap.

**Fix — add a second entry point that only appears where the sidebar is absent.**

1. In `src/library/Library.jsx`, in the `<div className="library-main-tools">` in
`.library-main-head`, insert a Settings button between the Sort button and the
New document button:

```jsx
<Button className="soft-button settings-fallback" type="button" onClick={onSettings}>
  <Icon name="settings" size={14} /><span>Settings</span>
</Button>
```

Same `onClick` as the sidebar button. `onSettings` is already in scope — it is
the existing prop.

2. In `src/styles.css`, next to `.sidebar-settings` (~line 752), hide it by default
and bring it back inside the 940px media query:

```css
/* The sidebar's Settings button is the primary way in, and the sidebar is
   hidden below 940px -- so this is the only route to Settings at narrow widths.
   Hidden by default and restored by that media query, so the two never show
   at the same time. */
.settings-fallback { display: none; }
```

```css
@media (max-width: 940px) {
  /* ...existing rules... */
  .settings-fallback { display: inline-flex; }
}
```

   `.soft-button` is `display: inline-flex` (styles.css:522), so `inline-flex`
   restores it correctly. Keep the `@media (max-width: 560px)` rule at
   styles.css:1272-1273 in mind — it hides the label text on `:not(.primary)`
   buttons in `.library-main-tools`, which will now also apply to the fallback at
   very narrow widths. That is consistent with how Sort is treated there.

**No equivalent fix is needed in the editor.** `.left-panel` / `.right-panel`
become drawers at narrow widths (`width: min(86vw, 282px)`) rather than
`display: none`, so the editor's `.panel-inner` Settings button stays reachable.

### Defect B — an empty 218px strip beside Settings below 940px

**Status.** `[x]` complete — `styles.css:1268`, inside the 940px media query:
`.app-shell.settings-open .library-layer { width: 0; }`. Same specificity as the rule at 1071 and
later in the file, so source order makes it win.

**Cause.** `styles.css:1066` gives the library layer a fixed width while Settings
is open:

```css
.app-shell.settings-open .library-layer { position: relative; inset: auto; width: 218px; flex: none; }
```

But at that width the only thing inside it, `.library-sidebar`, is
`display: none`. Result: a 218px empty strip to the left of the Settings page.

**Fix — collapse the layer when there is no sidebar to show.** Inside the existing
`@media (max-width: 940px)` block:

```css
/* No sidebar exists at this width, so the settings layout has no column to sit
   beside. Collapse the library layer rather than leaving an empty 218px strip. */
.app-shell.settings-open .library-layer { width: 0; }
```

Same selector and specificity as the rule at 1066, and later in the file, so it
wins. `.settings-layer` is `flex: 1`, so it takes the full width.

---

## Constraints

- Derived/composed CSS tokens go on `body { }`, not `:root`. Neither fix adds a
  token, so this only matters if you find yourself tempted to.
- Tailwind prefix is `tw:` exactly once at the front. Neither fix adds utility classes.
- **Trap:** `tests/themes.test.mjs`'s `block()` finds theme blocks with `indexOf`
  over the raw stylesheet. Never write the literal `body[data-theme="paper"]`
  (or `light` / `night`) inside a CSS comment.
- `gui/` is untracked in git — there is no `git checkout` safety net. These are
  two small, additive CSS rules plus one JSX attribute change; do not run broad
  regex rewrites across `styles.css`.
- Do not add animation. Motion in this app is restricted to the assistant panel
  and `ChatPanel`, and change (b) was specifically about removing hover motion.
- Do not touch `tests/settings-controls.test.mjs` / `dialog-keyboard.test.mjs`
  selectors — they target `.library-sidebar .sidebar-settings`, which the fallback
  does not collide with. But check whether any test asserts the *number* of
  buttons in `.library-main-tools`, or asserts Settings is absent from it; if so
  that test encodes the pre-(c) design and must be updated, not deleted.
- Do not commit to git.

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

All five must stay green. Baseline: build ✓, contrast "All checks meet target",
prefix guard 5/5, test-list gate ✓, **196 + 71 + 29 = 296 passing, 0 failing**.

No browser verification is possible in this environment — Chromium download fails
with `read ETIMEDOUT`. Both defects are below 940px, so **nothing in the suite can
catch a regression here**; the fixes must be reasoned from the CSS, and both
should be confirmed by eye on a real narrow window after implementation.