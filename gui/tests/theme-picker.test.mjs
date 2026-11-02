/**
 * The theme picker, and the applier it drives.
 *
 * Two things are being guarded here, and both had a plausible-looking wrong
 * version.
 *
 * The applier's cleanup. The effect that paints a custom theme writes its tokens
 * onto `<html>` as inline custom properties, and an effect that does not remove
 * them leaves them for the rest of the session. The previous version of this
 * effect did exactly that with `--reading-font`, and a theme switch would have
 * done it with all thirty-odd of a theme's tokens -- switch to a custom dark
 * theme, switch back to Light, and the page keeps the dark palette while
 * `data-theme="light"` says otherwise. Every test here that changes the theme
 * twice is checking for that.
 *
 * The save-time contrast gate. A theme is applied by the applier on the next
 * launch with nothing in front of it, so a picker that saves a failing theme with
 * a warning hands the reader an unreadable document and a promise to come back
 * and delete it. The Save button has to be disabled instead, with the reason
 * named.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./tests/setup.mjs \
 *        --test tests/theme-picker.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  assertGone,
  dom,
  root,
  settle,
  tick,
  calls,
  handlers,
  themeFixtures,
  mockFramerMotion,
} from './support/dom-harness.mjs'

mockFramerMotion()

// Seeded before the import, because `App` loads the theme list during bootstrap
// and a fixture reset afterwards would leave the picker showing an empty list.
themeFixtures.reset([
  { theme_id: 'midnight', name: 'Midnight', mode: 'dark', tokens: { '--main': '#0b1020', '--text-1': '#e6ecff' } },
])

await import('../src/main.jsx')
await tick(250)

const { window } = dom
const html = window.document.documentElement
const body = window.document.body

const click = async (node) => {
  node.focus()
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
}

const pressKey = (key, init = {}) =>
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  )

const setColor = async (input, value) => {
  // React listens for `input`, not `change`, on a colour input, and jsdom does
  // not let `value` be set to a value the control would refuse.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()
}

const openSettings = async () => {
  // The sidebar slot the chip used to occupy, which is where the entry point
  // lives now.
  const button = root.querySelector('.library-sidebar .sidebar-settings')
  assert.ok(button, 'the library sidebar has a Settings button')
  await click(button)
  assert.ok(root.querySelector('.settings-page'), 'the settings page opened')
  // Every test in this file drives the theme picker, and the picker lives in the
  // Appearance panel, so each one takes the trip a reader takes. Going through
  // the real tab is also what proves the panel is reachable at all -- the panels
  // stay mounted and hidden, so a test that ignored the tab bar would pass while
  // the control behind it was unreachable.
  await click(tabNamed('Appearance'))
}

const closeSettings = async () => {
  // Escape, not a button in the page. The library sidebar stays on screen beside
  // Settings and carries the Settings button that toggles the page closed, so the
  // page has no way back of its own and no chevron claiming otherwise. Dispatched
  // on `document` because that is where the app's global keydown listener lives.
  pressKey('Escape')
  await settle()
  assertGone('.settings-page', 'Escape closed the settings page')
}

const picker = () => root.querySelector('.theme-picker')

/**
 * The tab bar's buttons, matched by their visible text.
 *
 * `role="tab"` rather than a class name: the role is the contract, and a test that
 * went through the class would keep passing if the semantics were dropped.
 */
const tabNamed = (name) => {
  const tab = [...root.querySelectorAll('.settings-tabs [role="tab"]')].find(
    (node) => node.textContent.trim() === name,
  )
  assert.ok(tab, `a settings tab reading ${name}`)
  return tab
}

/**
 * The theme cards, which are Radix radio items in one group.
 *
 * These were `[role="option"]`s inside a portal on `document` and needed a
 * pointerdown/pointerup pair to commit. A card is a button inside `#root`, so it
 * is read the way a reader reaches it and it needs no portal helper at all.
 */
const themeCards = () => [...root.querySelectorAll('.theme-cards-list [role="radio"]')]

const cardLabel = (card) => card.querySelector('.choice-card-name').textContent.trim()

const cardNamed = (name) => {
  const found = themeCards().find((card) => cardLabel(card).includes(name))
  assert.ok(
    found,
    `a theme card reading ${name}, got ${themeCards().map(cardLabel).join(' | ')}`,
  )
  return found
}

const choose = async (name) => {
  await click(cardNamed(name))
}

/** The one card the group reports as its value. */
const checkedCard = () => themeCards().find((card) => card.getAttribute('aria-checked') === 'true')

/** The edit/delete pair, which only exists while a reader's own theme is chosen. */
const themeAction = (label) =>
  [...root.querySelectorAll('.theme-actions-buttons button')].find((node) => node.textContent.trim() === label)
const inlineTokens = () => new Set(
  [...html.style].map((property) => property).filter((property) => property.startsWith('--')),
)

// ---------------------------------------------------------------------------
// the picker
// ---------------------------------------------------------------------------

test('the picker offers the three built-ins and every saved theme', async () => {
  await openSettings()
  const names = themeCards().map(cardLabel)

  // The three answers every reader has, first, in the order the tab bar implies.
  assert.deepEqual(names.slice(0, 3), ['Light', 'Paper', 'Dark'], 'the built-ins come first')
  assert.ok(names.includes('Midnight'), `the saved theme is listed, got ${names.join(', ')}`)
  // The reader's own themes follow rather than interleave: a card grid has no
  // optgroup to put them under, so their position after the three built-ins is
  // what stops six of them reading as six more built-ins that cannot be edited.
  assert.ok(
    names.indexOf('Midnight') > names.indexOf('Dark'),
    `a saved theme sits after the built-ins, got ${names.join(', ')}`,
  )
  // And each card carries the sentence the dropdown used to have to spell out in
  // the option text: a thumbnail shows the mode, a name does not.
  for (const card of themeCards()) {
    const note = card.querySelector('.choice-card-note')
    assert.ok(note?.textContent.trim(), `the ${cardLabel(card)} card has a one-line description`)
  }
  await closeSettings()
})

test('the card previews the merged set, not just the stored overrides', async () => {
  // A preset row sets the tokens it changes. A preview built from the row alone
  // would show `#0b1020` on a white page with no ink on it, and the reader would
  // be choosing from blank rectangles. Each card now draws its own miniature from
  // the *resolved* set, so this asserts on the chosen card rather than on one
  // small picture of whatever happened to be in use.
  await openSettings()
  await choose('Midnight')
  const preview = picker().querySelector('.theme-cards-list [data-state="checked"] .theme-preview-page')
  assert.ok(preview, 'the selected card has a preview of what it applies')
  assert.equal(
    preview.style.backgroundColor,
    'rgb(11, 16, 32)',
    'the page fill is the resolved --main, not just the stored overrides',
  )
  assert.equal(
    preview.style.color,
    'rgb(230, 236, 255)',
    'the preview uses the resolved ink, not just the stored overrides',
  )
  // Decoration. The card is the radio and announces its own name and value, so a
  // preview that was also announced would read the whole palette out loud on top
  // of it.
  const card = picker().querySelector('.theme-cards-list [data-state="checked"]')
  assert.equal(
    card.querySelector('.theme-preview').getAttribute('aria-hidden'),
    'true',
    'the miniature on the card is hidden from assistive technology',
  )
  await closeSettings()
})

test('choosing a card applies the theme immediately', async () => {
  // Not on "Save changes". A theme is the one setting you cannot judge from a
  // dropdown, and a preview behind a submit button is not a preview.
  await openSettings()
  await choose('Midnight')
  assert.equal(body.dataset.theme, 'midnight')
  assert.equal(body.dataset.mode, 'dark', 'the mode comes from the theme, not from a name check')
  assert.equal(html.style.getPropertyValue('color-scheme'), 'dark', 'native widgets follow the mode')
  await closeSettings()
})

test('a custom theme writes its tokens and a built-in takes them back off', async () => {
  await openSettings()
  await choose('Midnight')
  const written = [...inlineTokens()]
  assert.ok(written.includes('--main'), `a custom theme writes --main, got ${written.join(', ')}`)
  assert.ok(written.includes('--text-1'))

  await choose('Light')
  assert.equal(body.dataset.theme, 'light')
  assert.deepEqual(
    [...inlineTokens()],
    // --reading-font is set by the reading-font setting, not by the theme, and
    // is re-applied on every settings change. Everything else has to be gone:
    // a leftover Midnight token is a dark page that claims to be light.
    ['--reading-font'],
    'switching back to a built-in must leave no theme token on the document element',
  )
  await closeSettings()
})

test('the effects follow the resolved mode, not the theme name', async () => {
  // `effectTheme` used to ask whether the theme was called "night", which lit the
  // canvas effects for every custom dark theme in the app. The chat effects are
  // not mounted in this harness, so this is the one rule in the file checked at
  // the source: the mode has to come from the resolved theme object, and the
  // name comparison has to be gone rather than merely unused.
  // `effectTheme` moved with the chat panel, which is where the effects are.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'library', 'ChatPanel.jsx'),
    'utf8',
  )
  assert.match(
    source,
    /const effectTheme = theme\?\.mode === 'dark' \? 'dark' : 'light'/,
    'effectTheme must read the resolved mode',
  )
  assert.ok(
    !/theme === 'night' \? 'dark'/.test(source),
    "asking whether the theme is named 'night' is the bug this replaced",
  )
  // And the observable half: a custom dark theme does set the mode.
  await openSettings()
  await choose('Midnight')
  assert.equal(body.dataset.mode, 'dark')
  await closeSettings()
})

test('making a theme offers the current one as a starting point, renamed', async () => {
  await openSettings()
  await choose('Light')
  await click(root.querySelector('.theme-new'))
  const nameInput = root.querySelector('#theme-name')
  assert.ok(nameInput, 'the editor opened')
  assert.equal(nameInput.value, 'Light copy', 'a built-in starts as a copy, never as an edit in place')
  await closeSettings()
})

test('the editor shows a real preview of the theme being built', async () => {
  await openSettings()
  await click(root.querySelector('.theme-new'))
  const preview = root.querySelector('.theme-preview')
  assert.ok(preview, 'there is a preview')
  // The preview carries the resolved set inline, so it is the applier's own
  // output and the numbers under it describe what is on screen.
  assert.ok(preview.style.getPropertyValue('--text-1'), 'the preview has resolved tokens')
  assert.ok(preview.style.getPropertyValue('--main'))
  await closeSettings()
})

test('an unreadable theme cannot be saved, and says which pair failed', async () => {
  await openSettings()
  await click(root.querySelector('.theme-new'))
  const before = calls.filter((call) => call.command === 'save_custom_theme').length

  // Drag the body text down until it is unreadable on the page.
  await setColor(root.querySelector('input[aria-label="Body text"]'), '#bbbbbb')
  const verdict = root.querySelector('.theme-verdict')
  assert.ok(verdict, 'there is a verdict line')
  assert.ok(verdict.classList.contains('failing'), 'an unreadable theme is a failure, not a warning')
  assert.match(verdict.textContent, /4\.5:1/, 'the failing pair and its threshold are named')

  const save = [...root.querySelectorAll('.theme-editor-actions button')].find((b) => b.textContent.includes('Save theme'))
  assert.ok(save.disabled, 'Save is disabled while a pair fails')

  await click(save)
  assert.equal(
    calls.filter((call) => call.command === 'save_custom_theme').length,
    before,
    'a disabled button must not reach the store',
  )
  await closeSettings()
})

test('a theme that fails only over the sidebar still cannot be saved', async () => {
  // The case a check against `--main` alone cannot see. `--text-3` on `--main`
  // is fine; the same ink on the sidebar is not.
  await openSettings()
  await click(root.querySelector('.theme-new'))
  await setColor(root.querySelector('input[aria-label="Faint text"]'), '#8f8f8f')
  const verdict = root.querySelector('.theme-verdict')
  assert.ok(
    verdict.classList.contains('failing'),
    `expected a failure, got "${verdict.textContent}"`,
  )
  assert.match(verdict.textContent, /--sidebar/, 'the failing surface is named')
  await closeSettings()
})

test('a readable theme saves, becomes selectable, and is applied', async () => {
  await openSettings()
  await click(root.querySelector('.theme-new'))
  const nameInput = root.querySelector('#theme-name')
  const setName = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setName.call(nameInput, 'Ash')
  nameInput.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()

  await setColor(root.querySelector('input[aria-label="Body text"]'), '#1a1a1a')
  const verdict = root.querySelector('.theme-verdict')
  assert.ok(!verdict.classList.contains('failing'), `a fresh light copy should be readable: ${verdict.textContent}`)

  const save = [...root.querySelectorAll('.theme-editor-actions button')].find((b) => b.textContent.includes('Save theme'))
  assert.ok(!save.disabled, `Save should be enabled: ${verdict.textContent}`)
  await click(save)

  assert.equal(body.dataset.theme, 'ash', 'the saved theme is applied, not just stored')
  assert.ok(themeCards().some((c) => cardLabel(c) === 'Ash'), 'and it is in the grid as a saved theme')
  const saveCall = calls.find((call) => call.command === 'save_custom_theme')
  assert.ok(saveCall, 'the store was asked to save it')
  assert.equal(saveCall.args.name, 'Ash')
  assert.equal(saveCall.args.mode, 'light')
  await closeSettings()
})

test('an unnamed theme cannot be saved', async () => {
  // The store rejects a blank name, and a rejected save throws into a click
  // handler. The button is disabled instead.
  await openSettings()
  await click(root.querySelector('.theme-new'))
  const nameInput = root.querySelector('#theme-name')
  const setName = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setName.call(nameInput, '   ')
  nameInput.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()
  const save = [...root.querySelectorAll('.theme-editor-actions button')].find((b) => b.textContent.includes('Save theme'))
  assert.ok(save.disabled, 'a blank name disables Save')
  await closeSettings()
})

test('a built-in cannot be deleted, and the actions follow the selection', async () => {
  // The edit/delete pair now belongs to the *selected* theme rather than to each
  // card, so there is one of them instead of two per saved theme. A built-in is
  // therefore never deletable, because there is nothing to delete: it is shared
  // by every reader of this build.
  await openSettings()
  // Say which theme is current rather than inheriting it. An earlier test saves
  // and applies one of the reader's own themes, so "the selected theme" is not a
  // fixed starting point here -- and an assertion about a built-in that depends
  // on whatever ran before is a test that passes or fails by luck.
  await choose('Light')
  assert.equal(themeAction('Delete'), undefined, 'on a built-in there is nothing to delete')
  assert.equal(themeAction('Edit'), undefined)

  await choose('Midnight')
  assert.ok(themeAction('Delete'), 'on one of the reader\'s own themes there is')
  assert.ok(themeAction('Edit'))
  await closeSettings()
})

test('deleting the selected theme falls back rather than leaving a dangling id', async () => {
  await openSettings()
  await choose('Midnight')
  assert.equal(body.dataset.theme, 'midnight')

  await click(themeAction('Delete'))

  assert.ok(!themeCards().some((c) => cardLabel(c) === 'Midnight'), 'the theme is gone from the grid')
  assert.equal(body.dataset.theme, 'light', 'a deleted theme does not leave the setting pointing at nothing')
  assert.deepEqual([...inlineTokens()], ['--reading-font'], 'and leaves no tokens behind')
  await closeSettings()
})

test('the picker is inside the page, not beside it', async () => {
  // The Appearance panel is a scroll region; a picker that rendered outside the
  // page would sit under the layer and be unreachable.
  await openSettings()
  const page = root.querySelector('.settings-page')
  assert.ok(page.contains(picker()), 'the picker is a descendant of the page')
  // Named by the visible "Theme" label above it, through `aria-labelledby` --
  // a radiogroup is not a labelable element, so `<label for>` cannot do this.
  assert.equal(picker().querySelector('.theme-cards-list').getAttribute('aria-labelledby'), 'theme-label')
  await closeSettings()
})

test('the cards are one single-choice control that says what is in use', async () => {
  // Nine cards that were plain buttons were a list, not a single-choice control:
  // a screen reader announced nine separate buttons and no indication of which
  // theme was in use. The dropdown that replaced them fixed that by being a
  // combobox, and these cards fix it by being a radiogroup -- one control
  // reporting a value, which is the same guarantee by a different mechanism and
  // is why they are Radix radio items rather than `<button onClick>`.
  //
  // A combobox has no `role` assertion to make here beyond its own, so the
  // equivalent claims are the group's role and `aria-checked` on exactly one
  // card.
  await openSettings()
  const group = root.querySelector('.theme-cards-list')
  assert.equal(group.getAttribute('role'), 'radiogroup', 'announced as one control')
  assert.ok(themeCards().length >= 4, `expected the three built-ins and a card for the preset, got ${themeCards().length}`)

  // Established, not inherited: earlier tests save, apply and delete themes, so
  // the current one is whatever they left behind.
  await choose('Light')
  assert.equal(themeCards().filter((c) => c.getAttribute('aria-checked') === 'true').length, 1, 'exactly one card is the value')
  assert.equal(cardLabel(checkedCard()), 'Light', 'and it is the theme in use')
  assert.equal(
    picker().querySelector('.choice-card-badge').parentElement.getAttribute('aria-checked'),
    'true',
    'the badge rides on the selected card',
  )

  // 'Dark' rather than a saved theme: the delete test above removes 'Midnight'
  // from the store, and this is about the control, not about any one theme.
  await choose('Dark')
  assert.equal(body.dataset.theme, 'night', 'changing it applies the theme')
  assert.equal(cardLabel(checkedCard()), 'Dark', 'and the group follows it')
  await closeSettings()
})
