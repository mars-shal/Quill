/**
 * The margin ruler.
 *
 * The handles used to listen on themselves while the pointer was captured by
 * the button they were moving, so a drag could lose its capture and stop after
 * one frame. These assertions drive the window-level path the fix uses: a
 * pointerdown on a marker, then pointermove on `window`, with the values the
 * page actually consumes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { EditorRuler } = await import('../src/library/EditorRuler.jsx')

test('dragging the handles maps pointer position to the two margins', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const changes = []
  const root = createRoot(host)
  const Harness = () => {
    const [margins, setMargins] = useState({ left: 22, right: 22 })
    return React.createElement(EditorRuler, {
      ...margins,
      onChange: (next) => {
        changes.push(next)
        setMargins(next)
      },
    })
  }

  await act(async () => root.render(React.createElement(Harness)))

  const track = host.querySelector('.editor-ruler-track')
  track.getBoundingClientRect = () => ({
    left: 0, right: 210, top: 0, bottom: 23, width: 210, height: 23, x: 0, y: 0,
    toJSON() { return this },
  })

  const left = host.querySelector('.editor-ruler-marker.is-left')
  const right = host.querySelector('.editor-ruler-marker.is-right')
  assert.ok(left && right, 'both handles are rendered')

  await act(async () => {
    left.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 22 }))
    window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 40 }))
  })
  assert.deepEqual(changes.at(-1), { left: 40, right: 22 }, 'the left handle follows the pointer')

  await act(async () => {
    right.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 188 }))
    window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 170 }))
  })
  assert.deepEqual(changes.at(-1), { left: 40, right: 40 }, 'the right margin grows inward')

  await act(async () => {
    left.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40 }))
    window.dispatchEvent(new window.MouseEvent('pointerup', {}))
  })
  const before = changes.length
  await act(async () => {
    left.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  assert.equal(changes.length, before + 1, 'a focused handle moves with the arrow keys')
  assert.equal(changes.at(-1).left, 41)

  await act(async () => root.unmount())
  host.remove()
})
