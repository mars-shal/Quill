# Settings usability fixes — broken selects, back chevron, autosave line, filter clicks

Follows `.omo/plans/narrow-width-settings-fixes.md`. Both plans are outstanding;
neither depends on the other, but do them in either order.

## Status — all four implemented 2026-10-08

Gate green: build exit 0, contrast "All checks meet target", prefix guard 5/5,
test-list gate ok, **301 passing (196+76+29), 0 failing**.

| # | Item | Where | State |
| --- | --- | --- | --- |
| 1 | Select text sizing | `styles.css:414` | `[x]` `font: inherit` → `font-family: inherit` |
| 2 | Chevron removal | deleted from `SettingsPage.jsx`; dead rule gone from `styles.css` | `[x]` |
| 3 | "Saved as you go" removal | deleted from `SettingsPage.jsx`; 3 dead rules gone from `styles.css` | `[x]` |
| 4 | Filter click closes Settings | `main.jsx:421-424` — `applyFilter` now calls `setSettingsOpen(false)` | `[x]` |

Test routes repointed at Escape, reusing `pressKey` from `dialog-keyboard.test.mjs:36-39` and
`assertGone` from the harness. Both suites now assert closure at *every* `closeSettings` call site
(15 in theme-picker, 17 in background-picker) — coverage went up, not down. `.dialog-actions`
assert and the `set_settings` persistence assert both retained. A stale comment in `styles.css`
that still described the deleted autosave rules as present was also removed.

**Added `tests/settings-tabs.test.mjs` (5 tests, registered in `scripts/test-js.sh`).**
Not part of the original four — it exists because the Appearance/Writing tabs were reported
broken and no test covered panel switching. See `.omo/plans/settings-render-smear.md` for why
every existing test was blind to it. It passes, proving the tab wiring is sound and the real-app
fault is outside React state.

**Accepted consequence, on the record:** there is now no Save button and no "saved" indicator
anywhere in Settings. A change saves silently with zero on-screen feedback. The retained
`set_settings` assertion is what covers it, and it covers it invisibly.

---

## Source

Owner reports, against a running build, with screenshots:

1. The settings selects are not working.
2. Remove the chevron next to the "Settings" heading.
3. Remove the "Saved as you go" text.
4. Clicking any collection or status in the sidebar should close Settings and open
   that filter.

---

## 1. Fix the settings selects

### What is confirmed from the code

The screenshot shows the Provider trigger's value text rendering visibly larger
than the row label beside it. Everything else about the trigger — its width, its
placement in the right-hand 236px control box, and the chevron sitting at the far
edge of that box — is consistent with `tw:flex tw:justify-between tw:w-full`
working. The oversized text is the fault.

**Confirmed cause.** `src/styles.css:414`:

```css
button, input, textarea, select { font: inherit; }
```

`styles.css` is unlayered; Tailwind's utilities are layered. Unlayered CSS
outranks layered CSS for any property **both** rules set, so this shorthand beats
`tw:text-sm` on the trigger no matter what. `font` is a shorthand, so it also
resets `line-height`. The value inherits the body size instead of the 14px the
component asked for.

This is not specific to the Select — it hits every shadcn control that sets a
`tw:text-*` size, which is why `.dialog-select` needed a `width: 100%` patch at
`styles.css:1217` to look right at all.

Two other unlayered rules clobber the same trigger, and are worth knowing about
even though they are not what the owner is complaining about:

- `styles.css:415` `button { border: 0; cursor: pointer; }` beats `tw:border`
  on the trigger. The control therefore has no border of its own and relies on
  the page behind it for its edge.

`tailwind.css:41-42` gives the rule for reading this: *"treat a utility not
applying as a signal that its hand-written counterpart still exists."* Lines 414
and 415 are those counterparts for this trigger.

### Two readings of "aren't working" — do not conflate them

The owner's phrase could mean either, and they have different fixes:

**(A) It looks wrong.** The value text is oversized. Fully explained by line 414,
and fixed by the change below. This is what the screenshot shows.

**(B) Clicking it does nothing — the dropdown never opens.** *This has no CSS
cause and is not explained by anything above.* Checked and ruled out: Radix
`SelectContent` renders through `SelectPrimitive.Portal`, which mounts to
`document.body` — outside `.app-shell { overflow: hidden }`
(`styles.css:421`), so it cannot be clipped. The portal is `tw:z-[200]`, and
`.app-shell` is `position: relative` with `z-index: auto`, which creates no
stacking context for it to lose to.

So if the owner means (B), it is a behaviour bug and none of this section fixes
it. Do not "fix" it with CSS. Get a reproduction — does the trigger get
`aria-expanded="true"` on click, and does a `[role="listbox"]` appear in the
document? — and report back rather than guessing.

### Fix

**Do not add an `@layer base`.** `src/tailwind.css` imports only two layers —
`layer(theme)` (line 156) and `layer(utilities)` (line 170). There is no base
layer, and creating one to hold a single rule would change the cascade order for
the whole app on the strength of one symptom.

**Do not wrap `styles.css` in `@layer components` as a quick fix either.** That is
the architecturally correct move and `tailwind.css:37-40` documents it as the
intended end state — but the same comment block (lines 42-55) explains why it is
not incidental: the moment `styles.css` becomes layered, the colliding class
names (`.border`, `.shadow`, `.outline`, `.container`, `.hidden`, `.table`,
`.ring`, `.filter`, `.absolute`, `.flex`, `.static`, `.sticky`) start meaning
Tailwind's values instead of Quill's. `KNOWN_COLLISIONS` in
`tests/tailwind-bridge.test.mjs` exists to gate that day. It is a migration, not
a patch. Leave it out of this task.

**The narrow fix that is correct here: stop the shorthand from clobbering size.**
`styles.css:414` needs to exist so native controls inherit the app's self-hosted
Inter / DM Mono instead of the UA default — that is the whole reason it is there.
It does that through `font-family`. It does not need the `font` shorthand. Change
one line:

```css
/* before */
button, input, textarea, select { font: inherit; }

/* after */
button, input, textarea, select { font-family: inherit; }
```

`font-family` does not collide with `tw:text-sm`, which sets `font-size` and
`line-height`, so the trigger picks up its intended size and the shadcn components
stop fighting the hand-written sheet.

**Consequence to check, not assume.** `font: inherit` was also resetting
`line-height` on `input` / `textarea` / `button` to the inherited value. Narrowing
it to `font-family` lets `line-height` fall back to the UA default on those
elements, which will slightly change the height of Quill's own hand-authored
inputs. Check an ordinary field outside Settings — the document Details dialog,
or a toolbar input — and confirm it still sits right. If it does not, set
`line-height` explicitly on those rules rather than reverting to the shorthand.

Do **not** try to fix this by re-declaring font sizes per component. That
reintroduces the drift the shadcn migration was meant to remove. And do not patch
`.dialog-select` again — `styles.css:1217` is already such a patch, and adding
another would hide a cascade fault rather than fix it.

If the flex/height symptom turns out to be independent of the font, fix that on
its own terms and say so in the report.

### Verify

`#provider` and `#font` must sit at the same height as the `#model` and
`#endpoint` inputs in the same rows, at the same font size as the row labels. Both
must open, and choosing an item must update the setting.

---

## 2. Remove the chevron next to "Settings"

That is the back button in the settings page header —
`src/library/SettingsPage.jsx`, the `.settings-back` button rendering
`<Icon name="back" />` immediately left of the `<h1>Settings</h1>`.

Delete the button. Leave `.settings-page-head`'s title block and its spacing
intact.

This is now redundant *and* misleading: with the sidebar permanently visible
beside Settings, the sidebar's own Settings button toggles the page closed, and
so does Escape. A back chevron implies Settings is a page you arrived at and must
return from.

**Check before deleting — exactly two test files click it, not three:**

| File | Line | What it does |
| --- | --- | --- |
| `tests/theme-picker.test.mjs` | 90 | `root.querySelector('.settings-page .settings-back')` |
| `tests/background-picker.test.mjs` | 98 | `await click(root.querySelector('.settings-page .settings-back'))` |

Both close Settings by clicking the back button. Repoint both at another real
route — Escape, or the sidebar's `.library-sidebar .sidebar-settings` — and keep
them asserting that Settings closes. **Do not delete either test**; closing
Settings is real behaviour worth keeping covered. If repointing at the sidebar
button, note that button is a toggle, so a test that opens Settings and then
clicks it must expect it to close.

`tests/dialog-keyboard.test.mjs` does **not** touch `.settings-back`. Do not go
looking for it there.

Then remove `.settings-back` from `styles.css:1097`.

---

## 3. Remove the "Saved as you go" line

Delete the status paragraph in the settings page header: the
`.settings-autosave` element with the `.settings-autosave-dot` span and the text
"Saved as you go. There is nothing to confirm."

Then remove the now-dead CSS: `.settings-page-head .settings-autosave` at
`styles.css:1103`, and `.settings-autosave` / `.settings-autosave-dot` at
`styles.css:1796-1797`.

**Do not touch the autosave behaviour itself.** The 350ms debounced `onPersist`
effect stays, and `apiKey` stays out of `draft`. Only the sentence goes.

### This line is load-bearing — read this before removing it

`tests/background-picker.test.mjs:364-373` asserts two things together:

```js
assert.equal(root.querySelector('.settings-page .dialog-actions'), null,
  'no action row, and so no Save and no Cancel')
assert.match(root.querySelector('.settings-autosave')?.textContent || '',
  /Saved as you go/,
  'and a line saying so, so the missing button is not read as unsaved')
```

The first assertion encodes the owner's earlier decision that there is no Save
button. The second exists **because of** the first: with no button to press, the
sentence is the only thing telling a reader their change was already written. Its
removal reason is stated in the test itself.

So removing the line leaves the app with no Save button **and** no indication that
anything saved. That is the owner's call to make — they asked for it — but it must
be made knowingly, and the second assertion has to go with it rather than be left
failing or deleted silently.

When you remove it, replace that second assertion with one that keeps the
*behaviour* it was protecting and drops the *copy* it was asserting. The behaviour
worth keeping is already asserted two lines later: past the 350ms debounce,
`set_settings` was called with the new value and nobody pressed anything. So:

- delete the `.settings-autosave` `assert.match` block
- keep the `set_settings` persistence assertion that follows it
- keep the `.dialog-actions` `assert.equal` — that one is about the absent
  button, not about the sentence

Do not delete the test. Do not weaken the persistence check to compensate.

### Consequence to state plainly in the report

After this change a settings change is saved silently and invisibly: no button,
no status line, no confirmation. The owner has asked for the line twice in
effect, so proceed — but say this back explicitly when you finish, because it is
the kind of thing that is only obvious before the change and invisible after it.

Then remove the now-dead CSS: `.settings-page-head .settings-autosave` at
`styles.css:1103`, and `.settings-autosave` / `.settings-autosave-dot` at
`styles.css:1796-1797`. Confirm nothing else references either class first.

---

## 4. A collection or status click closes Settings and shows that filter

Every filter button in the sidebar — collections *and* statuses — routes through
the single `onFilter` prop, which lands on `applyFilter` in `src/main.jsx:418`:

```js
const applyFilter = useCallback((type, value) => setFilter({ type, value }), [])
```

Today that only changes the filter. Because
`.app-shell.settings-open .library-main { display: none }`, the grid is hidden
while Settings is open, so the click appears to do nothing at all.

Fix it at that single point in `src/main.jsx:418`:

```js
const applyFilter = useCallback((type, value) => {
  setFilter({ type, value });
  setSettingsOpen(false);
}, []);
```

One change covers both groups, because both go through it. It also means
`.library-main` becomes visible again on the same tick, so the reader lands on the
filter they chose rather than on an empty shell.

Do not special-case `library-nav` or add a click handler on the sidebar. `applyFilter`
is the seam, and a second listener would double-apply.

---

## Constraints

- Derived/composed tokens go on `body { }`, not `:root`. None of these fixes add a
  token.
- Tailwind prefix is `tw:` exactly once at the front. Item 1 does not add utilities.
- **Trap:** `tests/themes.test.mjs`'s `block()` finds theme blocks with `indexOf`
  over the raw stylesheet. Never write the literal `body[data-theme="paper"]`
  (or `light` / `night`) inside a CSS comment.
- `gui/` is untracked in git — no `git checkout` safety net. Item 1 moves a rule
  between two files; make both edits or neither.
- Do not add animation. Motion stays restricted to the assistant panel and
  `ChatPanel`.
- Do not change the settings tab bar, row layout, or theme/density card grids.
- Do not commit to git.

## Tests

- `tests/settings-controls.test.mjs` and `tests/dialog-keyboard.test.mjs` use
  `.library-sidebar .sidebar-settings` to open Settings. That still works — leave
  it. `dialog-keyboard.test.mjs` additionally clicks `.settings-back`; see item 2.
- No test may be weakened or deleted to accommodate any of this. Every change
  above is either a removal or a route change; the tests that reference removed
  elements must be repointed at a surviving route, and must still assert the same
  behaviour.

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

**These four items are all visual, and none of them can be verified by that
suite.** Item 1 in particular is a rendering fault the tests are blind to. The
owner has a running build and took the screenshots, so ask them to re-check all
four against a real window rather than reporting this as visually confirmed.