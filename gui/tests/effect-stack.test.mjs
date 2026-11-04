/**
 * The effect stack must not run behind the library screen.
 *
 * The editor layer stays mounted behind the library at `opacity: 0` so the two
 * can cross-fade, and a fully transparent element still intersects. That left
 * the whole decorative stack running while the reader was looking at the
 * library: MetalFx's shared WebGL2 context and rAF loop, a BotAvatar canvas per
 * AI message, the ThinkingOrb, and the Liquid SVG goo filter.
 *
 * Two of those are observable in jsdom as canvases. MetalFx's is not, because
 * `hasWebGL2()` is false under jsdom, so it takes the plain-button path whether
 * or not the gate works -- that is asserted separately below rather than
 * pretended at here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { assertGone, awaitBoot, dom, root, settle } from './support/dom-harness.mjs'

await import('../src/main.jsx')
await awaitBoot()

const { window } = dom

const editorLayer = () => root.querySelector('.editor-layer')
const canvasesInEditor = () => [...editorLayer().querySelectorAll('canvas')]
const openFirstDocument = async () => {
  root.querySelector('.document-tile:not(.new-document-tile)')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
}
/** The sidebar nav items filter; they do not navigate. The topbar control does. */
const backToLibrary = async () => {
  root.querySelector('[aria-label="Back to library"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
}

test('the editor layer is mounted while the library is showing', () => {
  // The premise of the whole item. If this ever stops being true, the gating
  // below is either unnecessary or hiding a different bug.
  assert.equal(root.querySelector('.app-shell').dataset.view, 'library')
  assert.ok(editorLayer(), 'the editor layer stays mounted behind the library')
  assert.ok(editorLayer().querySelector('.editor-shell'), 'and so does the editor inside it')
})

test('no effect canvas runs behind the library screen', () => {
  assert.equal(
    canvasesInEditor().length,
    0,
    `expected no canvases while the library is showing, found ${canvasesInEditor().length}`,
  )
  assert.equal(editorLayer().querySelectorAll('.message-avatar').length, 0, 'no BotAvatar')
})

test('the goo suggestion row is not mounted behind the library screen', () => {
  // The plain row is the faithful fallback, so the gooey wrapper is the tell.
  assert.equal(
    editorLayer().querySelectorAll('.chat-suggestion-items').length,
    0,
    'the Liquid goo row must not mount while the library is showing',
  )
  assert.ok(
    editorLayer().querySelector('.chat-suggestions'),
    'the plain suggestion row is still there',
  )
})

test('the assistant send button renders with the effects off', () => {
  // P1-2's fallback path. The button must never depend on an effect being live.
  assert.ok(editorLayer().querySelector('.send-button'), 'the send button is still rendered')
})

test('the effect stack is present once the editor is the visible view', async () => {
  await openFirstDocument()
  assert.equal(root.querySelector('.app-shell').dataset.view, 'editor')

  const avatars = editorLayer().querySelectorAll('.message-avatar')
  assert.ok(avatars.length > 0, 'BotAvatar is mounted on the editor screen')
  assert.ok(
    editorLayer().querySelector('.chat-suggestion-items'),
    'the Liquid goo row is mounted on the editor screen',
  )
})

test('a round trip to the library stops the effects and back restarts them', async () => {
  // The gate is on the visible view, not a one-way mount, so it has to survive
  // the reader switching back and forth.
  await backToLibrary()
  assert.equal(root.querySelector('.app-shell').dataset.view, 'library')
  assert.equal(canvasesInEditor().length, 0, 'canvases are released on the library screen')

  await openFirstDocument()
  assert.ok(
    editorLayer().querySelectorAll('.message-avatar').length > 0,
    'and come back on the editor screen',
  )
})

test('the assistant conversation survives a trip to the library', async () => {
  // The gate unmounts effects, not the panel. Losing the transcript because
  // someone glanced at the library would be a worse bug than the one fixed.
  const composer = () => editorLayer().querySelector('.chat-box textarea')
  assert.ok(composer(), 'the chat composer has a textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(composer(), 'a question about the draft')
  composer().dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()
  assert.equal(composer().value, 'a question about the draft', 'the draft text was entered')

  await backToLibrary()
  await openFirstDocument()

  assert.equal(
    composer().value,
    'a question about the draft',
    'the draft text must survive the round trip',
  )
})

test('the go back control leaves the editor without leaving effects stuck on', async () => {
  await openFirstDocument()
  await backToLibrary()
  assertGone('.message-avatar', 'no BotAvatar once back on the library')
  assert.equal(root.querySelector('.app-shell').dataset.view, 'library')
})
