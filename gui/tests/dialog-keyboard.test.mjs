/**
 * Modal keyboard behaviour.
 *
 * Details and Settings both render through `ModalLayer`, which had only a fade
 * and a clickable scrim. Nothing moved focus in, nothing pulled it back, and
 * Escape did not close either: `App`'s global keydown handler returns early
 * while a dialog is open, so the one key that would have closed them was
 * swallowed. Tab walked straight out to the page behind the scrim.
 *
 * `ExportDialog` had a working trap of its own, so the point of moving it into
 * `platform/a11y.js` is that all three surfaces behave identically -- not that
 * one of them does.
 *
 * Every assertion here goes through `activeElementLabel` or `assertGone`
 * rather than comparing DOM nodes. See the note on those helpers for why.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeElementLabel,
  assertGone,
  dom,
  root,
  settle,
  tick,
} from './support/dom-harness.mjs'

// main.jsx mounts itself into #root on import.
await import('../src/main.jsx')
await tick(250)

const { window } = dom

const pressKey = (key, init = {}) =>
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  )

/**
 * Focuses the control, then clicks it.
 *
 * The focus call is not decoration. `dispatchEvent` does not move focus the way
 * a real click does, so without it the trap would record `body` as the element
 * to restore to and the focus-restore behaviour would never be exercised.
 */
const click = async (node) => {
  node.focus()
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
}

const settingsButton = () => root.querySelector('.library-sidebar .sidebar-settings')

const openSettings = async () => {
  const button = settingsButton()
  assert.ok(button, 'the library sidebar has a Settings button')
  // The entry point is a toggle, because the library sidebar stays on screen
  // beside Settings and a button that could only open would be dead in the one
  // state where it is visible. Consecutive tests here each ask for Settings to be
  // open, so this checks first -- clicking again would close the page that the
  // previous test left up.
  if (!root.querySelector('.settings-page')) await click(button)
  assert.ok(root.querySelector('.settings-page'), 'the settings page opened')
  return button
}

const { focusableWithin } = await import('../src/platform/a11y.js')

/**
 * The dialog's controls, in the same order the trap sees them.
 *
 * `focusableWithin` lives in the app and is deliberately not reimplemented here:
 * a second copy of the selector would be a second thing to keep in step, and the
 * scrim is excluded because it is `tabIndex={-1}`.
 */
const controlsIn = (selector) => focusableWithin(root.querySelector(selector))

/** The label `activeElementLabel` would print for a given node. */
const labelOf = (node) => {
  if (window.document.activeElement === node) return activeElementLabel()
  const tag = node.tagName.toLowerCase()
  const cls = typeof node.className === 'string' && node.className
    ? `.${node.className.trim().split(/\s+/)[0]}`
    : ''
  const name = node.getAttribute('aria-label')
    || node.getAttribute('id')
    || (node.textContent || '').trim().slice(0, 24)
  return `${tag}${cls}${name ? `[${name}]` : ''}`
}

const escape = async () => {
  pressKey('Escape')
  await settle()
}

test('opening Settings moves focus to the page', async () => {
  // Not to the first field. Settings used to autofocus the provider select, which
  // meant the first Tab jumped to *Model* while the reader was still looking at
  // the heading. The page itself takes focus instead.
  await openSettings()
  assert.equal(
    window.document.activeElement,
    root.querySelector('.settings-page'),
    `focus should land on the page, was ${activeElementLabel()}`,
  )
})

test('Escape leaves the settings page', async () => {
  await openSettings()
  await escape()
  assertGone('.settings-page', 'Escape must return to the library')
})

test('Escape closes the details dialog', async () => {
  const tile = root.querySelector('.document-tile')
  assert.ok(tile, 'a document tile rendered')
  tile.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 90 }))
  await tick()
  const details = [...root.querySelectorAll('.tile-context [role="menuitem"]')]
    .find((node) => node.textContent === 'Details')
  assert.ok(details, 'the right-click menu offered Details')
  await click(details)
  assert.ok(root.querySelector('.details-dialog'), 'the details dialog opened')

  await escape()
  assertGone('.details-dialog', 'Escape must close the details dialog')
})

test('Escape does not reach the app-level shortcuts while a dialog is open', async () => {
  // App's global keydown bails out while a dialog is open, so zen cannot be
  // toggled from behind the scrim.
  //
  // Compared as a token set rather than as a string, because the shell's
  // className is one template with an empty slot in it and an off modifier leaves
  // a run of spaces behind -- a string compare would fail on the whitespace.
  const shellTokens = () =>
    root.querySelector('.app-shell').className.split(/\s+/).filter(Boolean)

  await openSettings()
  const before = shellTokens()
  pressKey('Escape', { metaKey: true })
  await settle()
  const after = shellTokens()
  // `settings-open` is the one modifier allowed to change, and it is Settings'
  // own Escape handler that closed the page rather than an app shortcut. It is
  // named in the shell now that the page is a flex sibling of the library layer
  // rather than an overlay floating over it, which is what this assertion had to
  // give way to. Every other modifier -- and zen most of all -- has to be untouched.
  assert.deepEqual(
    after.filter((token) => token !== 'settings-open'),
    before.filter((token) => token !== 'settings-open'),
    'the shell must be unchanged apart from Settings closing',
  )
  assert.ok(!after.includes('zen'), 'zen is the app-level shortcut under test')
  assertGone('.settings-page', 'Escape must still leave the page')
})

test('leaving Settings returns focus to the control that opened it', async () => {
  const button = await openSettings()
  assert.notEqual(
    activeElementLabel(),
    labelOf(button),
    'focus should have left the opener for the dialog',
  )

  await escape()
  assertGone('.settings-page', 'the page is gone')
  assert.equal(
    activeElementLabel(),
    labelOf(button),
    'focus must return to the button that opened the dialog',
  )
})

test('the details dialog restores focus to its own trigger', async () => {
  const tile = root.querySelector('.document-tile')
  tile.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 90 }))
  await tick()
  const details = [...root.querySelectorAll('.tile-context [role="menuitem"]')]
    .find((node) => node.textContent === 'Details')
  await click(details)
  await escape()
  assert.match(
    activeElementLabel(),
    /Open /,
    `focus must return to the tile the menu opened from, got ${activeElementLabel()}`,
  )
})

test('Tab from the last control wraps to the first', async () => {
  // On a dialog, not on Settings. These two used to run against Settings, which
  // was a dialog then; now that Settings is a page it has no trap to test, and
  // the export dialog is the surface that still has one.
  await openExport()
  const items = controlsIn('.export-dialog')
  assert.ok(items.length > 1, `expected several controls, found ${items.length}`)

  const first = items[0]
  const last = items[items.length - 1]
  last.focus()
  assert.equal(activeElementLabel(), labelOf(last), 'the last control has focus to start')

  pressKey('Tab')
  await tick(20)
  assert.equal(
    activeElementLabel(),
    labelOf(first),
    'Tab from the last control must wrap to the first',
  )
  await escape()
})

test('Shift+Tab from the first control wraps to the last', async () => {
  await openExport()
  const items = controlsIn('.export-dialog')
  const first = items[0]
  const last = items[items.length - 1]
  first.focus()
  assert.equal(activeElementLabel(), labelOf(first), 'the first control has focus to start')

  pressKey('Tab', { shiftKey: true })
  await tick(20)
  assert.equal(
    activeElementLabel(),
    labelOf(last),
    'Shift+Tab must wrap to the last control',
  )
  await escape()
})

test('Tab in the middle of the dialog is left alone', async () => {
  await openExport()
  const items = controlsIn('.export-dialog')
  const middle = items[Math.floor(items.length / 2)]
  middle.focus()
  const label = labelOf(middle)
  pressKey('Tab')
  await tick(20)
  assert.equal(
    activeElementLabel(),
    label,
    'the trap must not intercept Tab away from the ends of the list',
  )
  await escape()
})

test('Settings is a page, so focus is not trapped', async () => {
  // The inverse of the dialog rule, and deliberately so.
  //
  // A focus trap exists to stop Tab walking out of a dialog into the page it is
  // covering. Settings covers the library rather than floating over it, there is
  // nothing behind it to walk into, and trapping here would strand a keyboard
  // user on a page they cannot leave with Tab -- the Back button is right there.
  await openSettings()
  settingsButton().focus()
  await tick(20)
  assert.equal(
    window.document.activeElement,
    settingsButton(),
    `focus is the caller's to move, was ${activeElementLabel()}`,
  )
  await escape()
})

test('Settings has no scrim, because there is nothing behind it', async () => {
  // It was a dialog over the library, so it had a scrim, and clicking that scrim
  // dismissed it. As a page it fills the window: there is no library showing
  // through to click, and a scrim here would be a grey sheet over grey.
  await openSettings()
  assert.equal(
    root.querySelector('.settings-page').closest('.modal-layer'),
    null,
    'the page must not be wrapped in the modal layer',
  )
  assert.equal(root.querySelector('.modal-scrim'), null, 'and so there is no scrim')
  await escape()
})

// --- the export dialog -------------------------------------------------------
// It had a trap and a scrim of its own, which is how an unstyled `dialog-scrim`
// survived in the tree: nothing here ever opened it. It now renders through the
// shared `ModalLayer`, and these are the assertions that would have caught the
// missing overlay -- the dialog has to be inside the fixed layer, not inline in
// the editor's flow.

const openExport = async () => {
  const button = [...root.querySelectorAll('.publish-button')][0]
  assert.ok(button, 'the editor has an Export button')
  await click(button)
  assert.ok(root.querySelector('.export-dialog'), 'the export dialog opened')
  return button
}

test('the export dialog renders inside the shared modal layer', async () => {
  const button = await openExport()
  const dialog = root.querySelector('.export-dialog')
  const layer = dialog.closest('.modal-layer')
  assert.ok(layer, 'the export dialog must be inside a modal layer')
  // The layer is the thing that positions it over the window; inline in the
  // editor flow it would just be a block of content at the top of the document.
  assert.ok(root.querySelector('.modal-scrim'), 'the shared scrim is present')
  assert.equal(
    root.querySelectorAll('.modal-scrim').length,
    1,
    'one scrim per surface, not one per implementation',
  )
  assert.match(layer.getAttribute('class') || '', /modal-layer/)
  await escape()
  assertGone('.export-dialog', 'Escape must close the export dialog too')
  // Compared by label, not by node: see the note at the top of this file.
  assert.equal(
    activeElementLabel(),
    labelOf(button),
    'focus must return to the Export button that opened the dialog',
  )
})

test('the export dialog traps focus like the other two', async () => {
  await openExport()
  const dialog = root.querySelector('.export-dialog')
  const controls = controlsIn('.export-dialog')
  assert.ok(controls.length > 1, `expected several controls, found ${controls.length}`)
  controls.at(-1).focus()
  pressKey('Tab')
  await settle()
  assert.equal(
    activeElementLabel(),
    labelOf(controls[0]),
    `Tab from the last control should wrap to the first, landed on ${activeElementLabel()}`,
  )
  await escape()
})

test('a dialog with no focusable control still holds focus', async () => {
  // The hook's degenerate case: an empty dialog must not leak focus to the
  // document body.
  const { useFocusTrap } = await import('../src/platform/a11y.js')
  const { useRef, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')

  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const reactRoot = createRoot(host)

  const Empty = () => {
    const ref = useRef(null)
    useFocusTrap(ref, true, () => {})
    return h('div', { ref, className: 'empty-dialog', tabIndex: -1 })
  }

  await new Promise((resolve) => {
    reactRoot.render(h(Empty))
    setTimeout(resolve, 60)
  })
  await tick(30)

  assert.ok(host.querySelector('.empty-dialog'), 'the empty dialog rendered')
  assert.match(
    activeElementLabel(),
    /empty-dialog/,
    `focus must land on the dialog itself when it has nothing to focus, was ${activeElementLabel()}`,
  )

  reactRoot.unmount()
  host.remove()
})
