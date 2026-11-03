/**
 * The settings controls that were migrated onto the shadcn primitives.
 *
 * These five `<select>` elements were native, and a migration that nothing
 * exercises is a migration that cannot be trusted: the suite was equally green
 * before and after, because no test opened Settings and touched one of them.
 * Radix's Select mounts a portal, a hidden native select and a bubble input, so
 * "it rendered" is a real claim here rather than a formality — and the first
 * attempt at this migration did not even get that far, throwing
 * `ReferenceError: HTMLFormElement is not defined` before a single assertion.
 *
 * The tests assert that each control mounts, carries its id (the `<label
 * htmlFor>` association depends on it), and shows the value the setting already
 * holds. Choosing an item is not exercised: that needs pointer-capture and
 * scroll-into-view stubs in the harness, and it is the part the theme picker
 * tests already cover for the one control whose helper has been rewritten.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { clickAndSettle, root, settle, tick } from './support/dom-harness.mjs'

// main.jsx mounts itself into #root on import.
await import('../src/main.jsx')
await tick(300)

const openSettings = async () => {
  // The sidebar slot, not the tools row: the entry point moved there with the
  // chip it replaced, and a test that still reached into `.library-main-tools`
  // would pass for a design nobody ships.
  //
  // It is a toggle, because the sidebar stays on screen beside Settings and a
  // button that could only open would be dead in the one state where it is
  // visible. So this establishes the precondition rather than clicking blindly --
  // clicking a second time would close the page under the test that follows.
  const button = root.querySelector('.library-sidebar .sidebar-settings')
  assert.ok(button, 'the library sidebar has a Settings button')
  assert.match(button.textContent, /Settings/, 'and it is named')
  if (!root.querySelector('.settings-page')) await clickAndSettle(button)
  await settle()
  assert.ok(root.querySelector('.settings-page'), 'the settings page opened')
}

/**
 * The settings-page controls that are still dropdowns.
 *
 * `density` used to be in this list and no longer is: it is a card grid now, so it
 * is asserted separately below. It is not a `<select>` and asserting `BUTTON` on
 * it would be asserting the old design rather than the control.
 */
const PAGE_SELECTS = ['provider', 'font']

/** The two that live in the document Details dialog. */
const DIALOG_CONTROLS = ['detail-kind', 'detail-status']

const openDetails = async () => {
  const tile = root.querySelector('.document-tile')
  assert.ok(tile, 'a document tile rendered')
  tile.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 90 }))
  await tick()
  const details = [...root.querySelectorAll('.tile-context [role="menuitem"]')]
    .find((node) => node.textContent === 'Details')
  assert.ok(details, 'the right-click menu offered Details')
  await clickAndSettle(details)
  assert.ok(root.querySelector('.details-dialog'), 'the details dialog opened')
}

test('every migrated settings control mounts and keeps its id', async () => {
  await openSettings()

  for (const id of PAGE_SELECTS) {
    const trigger = root.querySelector(`.settings-form #${id}`)
    assert.ok(
      trigger,
      `#${id} did not render. A Radix Select mounts a trigger button carrying the id, ` +
        'so a missing one means the control threw during mount rather than rendered empty.',
    )
    assert.equal(trigger.tagName, 'BUTTON', `#${id} should be the Select trigger button`)
    // The trigger is the labelled control, so the association has to hold or the
    // field loses its name.
    assert.ok(root.querySelector(`label[for="${id}"]`), `#${id} keeps its <label for>`)
  }
})

test('density is a named radio group, not a dropdown', async () => {
  await openSettings()

  const group = root.querySelector('.settings-form #density')
  assert.ok(group, '#density did not render')
  assert.equal(
    group.getAttribute('role'),
    'radiogroup',
    'the two density cards are one control with a value, not two buttons',
  )

  // A `role="radiogroup"` div is not a labelable element, so `<label for>` would be
  // invalid here. The association still has to exist -- by `aria-labelledby`,
  // which is how a group is named.
  assert.equal(
    group.getAttribute('aria-labelledby'),
    'density-label',
    'the group points at its visible label',
  )
  const labelId = group.getAttribute('aria-labelledby')
  assert.ok(root.querySelector(`#${labelId}`), 'and that label exists')

  const options = [...group.querySelectorAll('[role="radio"]')]
  assert.equal(options.length, 2, 'comfortable and compact')
  assert.equal(
    options.filter((node) => node.getAttribute('aria-checked') === 'true').length,
    1,
    'exactly one is checked, so the group carries a value',
  )
  assert.equal(
    options.find((node) => node.getAttribute('aria-checked') === 'true')?.getAttribute('value'),
    'comfortable',
    'and it is the one the setting already holds',
  )
})

test('the two migrated Details controls mount too', async () => {
  await openDetails()

  for (const id of DIALOG_CONTROLS) {
    const trigger = root.querySelector(`.details-dialog #${id}`)
    assert.ok(trigger, `#${id} did not render inside the details dialog`)
    assert.equal(trigger.tagName, 'BUTTON', `#${id} should be the Select trigger button`)
    assert.ok(root.querySelector(`label[for="${id}"]`), `#${id} keeps its <label for>`)
  }
})

test('a migrated control shows the value the setting already holds', async () => {
  await openSettings()

  // The harness stubs `theme: 'light'` and `density: 'comfortable'`.
  const density = root.querySelector('.settings-form #density')
  assert.match(density.textContent, /comfortable/i, 'density shows its stored value')

  const font = root.querySelector('.settings-form #font')
  assert.match(font.textContent, /Inter/, 'font shows its stored value')
})

test('the model picker is a hand-built listbox, and the shadcn primitive covers the rest', async () => {
  // No native `<select>` is left anywhere in the app. The editor toolbar's two
  // were the last, and they needed `pointerdown` rather than `mousedown` for
  // the stopPropagation that keeps the toolbar from opening the editor's
  // selection bubble.
  //
  // The model picker used to be the documented exception (a native select for
  // type-ahead and the OS's own list). It is now the hand-built listbox the
  // reference designs asked for -- rows with a badge and a selection dot --
  // and the comment on the constants in ChatPanel.jsx is the argument. What
  // the native control gave for free is pinned here instead: the listbox
  // roles, the announced popup, and the selection state.
  const { readFileSync } = await import('node:fs')
  const url = new URL('../src/library/ChatPanel.jsx', import.meta.url)
  const source = readFileSync(url, 'utf8')

  // The picker's docstring quotes `<select>` in prose, so the count looks for
  // the element form only (`<select` not followed by `>`).
  const native = source.match(/<select(?!\>)/g) || []
  assert.equal(native.length, 0, `no native select belongs in ChatPanel, found ${native.length}`)
  assert.match(source, /className="model-trigger"/, 'the picker renders its trigger')
  assert.match(source, /aria-haspopup="listbox"/, 'the trigger announces the popup')
  assert.match(source, /role="listbox"/, 'the popover is a real listbox')
  assert.match(source, /role="option"/, 'its rows are options')
  assert.match(source, /aria-selected=\{selected\}/, 'the chosen model is reported')
  assert.match(source, /ui\/select\.jsx/, 'it uses the shadcn primitive')
  assert.match(source, /aria-label="Font family"/, 'the font control keeps its name')
  assert.match(source, /aria-label="Text size"/, 'and so does the size control')
  assert.match(
    source,
    /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/,
    'the trigger still stops propagation, on the event Radix actually opens on',
  )
})