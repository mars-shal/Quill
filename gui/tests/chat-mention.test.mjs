/**
 * `@` in the chat composer.
 *
 * The writer's picker and the composer's menu share the same section/file list,
 * but they are two different triggers: a ProseMirror plugin in the document and
 * a plain textarea here. This suite types into the real textarea so the trigger,
 * the filter, the keyboard path and the insertion are all exercised together.
 *
 * Boots its own app so it does not depend on whatever screen another suite left
 * open.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  awaitBoot,
  clickAndSettle,
  dom,
  mockFramerMotion,
  root,
  tick,
  typeInto,
} from './support/dom-harness.mjs'

mockFramerMotion()

const { window } = dom

await import('../src/main.jsx')
await awaitBoot()

const openDocument = async () => {
  if (!root.querySelector('.chat-box')) {
    const tile = root.querySelector('.document-tile:not(.new-document-tile)')
    assert.ok(tile, 'the library offers a document')
    await clickAndSettle(tile)
  }
  // The section list is built from the live editor, and the document seeds
  // asynchronously from Yjs. Waiting for the outline is waiting for the same
  // headings the mention list is built from.
  const deadline = Date.now() + 1500
  while (!root.querySelector('.outline-row') && Date.now() < deadline) {
    await tick(25)
  }
  const field = root.querySelector('.chat-box textarea')
  assert.ok(field, 'the composer is on screen')
  return field
}

const click = async (node) => {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(30)
}

test('typing @ offers the document sections and other files', async () => {
  const field = await openDocument()
  typeInto(field, 'compare @he')
  await tick(40)

  const menu = root.querySelector('.chat-mention')
  assert.ok(menu, 'typing @ opens the mention menu')
  const labels = [...menu.querySelectorAll('.chat-mention__row > span')].map((node) => node.textContent)
  assert.ok(
    labels.includes('Heading'),
    `the document's sections are offered, got: ${labels.join(', ')}`,
  )
})

test('arrow keys choose and Enter inserts the reference', async () => {
  const field = await openDocument()
  typeInto(field, 'compare @')
  await tick(40)

  const menu = root.querySelector('.chat-mention')
  assert.ok(menu, 'the menu is open')
  const first = menu.querySelector('.chat-mention__row')
  assert.ok(first, 'it has rows')

  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await tick(30)
  const second = root.querySelectorAll('.chat-mention__row')[1]
  assert.equal(second?.getAttribute('data-active'), '', 'ArrowDown moves the highlight')

  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await tick(40)

  assert.match(field.value, /compare @.+ /, 'Enter inserts the highlighted reference')
  assert.equal(root.querySelector('.chat-mention'), null, 'and closes the menu')
})

test('picking a row with the pointer inserts it and keeps the caret after it', async () => {
  const field = await openDocument()
  typeInto(field, 'see @he')
  await tick(40)

  const row = [...root.querySelectorAll('.chat-mention__row')].find((node) => /Heading/.test(node.textContent))
  assert.ok(row, 'the section row is there')
  await click(row)

  assert.equal(field.value, 'see @Heading ', 'the query is replaced by the reference')
  assert.equal(root.querySelector('.chat-mention'), null, 'the menu closes')
  assert.equal(field.selectionStart, field.value.length, 'the caret sits after the inserted reference')
})
