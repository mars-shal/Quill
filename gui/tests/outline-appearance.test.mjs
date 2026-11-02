/**
 * Outline hierarchy and cover appearance.
 *
 * Two bugs motivated this file:
 *
 *  1. `collectHeadings` skipped H1 outright and the outline treated H2 as the
 *     section level, so a document written with the most natural heading level
 *     showed no sections at all.
 *  2. Cover colours were fixed at creation time, so two documents in the same
 *     collection could look unrelated and a draft could not be recognised as
 *     part of its collection.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectHeadings,
  getParentId,
  hasChildren,
  sectionNumber,
  pickActiveHeading,
  SECTION_LEVEL,
  OUTLINE_LEVELS,
} from '../src/editor/outline.js'

/** A ProseMirror-shaped stub good enough for collectHeadings. */
const editorWith = (nodes) => ({
  state: {
    doc: {
      descendants(visit) {
        nodes.forEach((node, index) => {
          const descend = visit(
            { type: { name: node.type }, attrs: { level: node.level }, textContent: node.text },
            index,
          )
          // A heading never has heading children.
          return descend !== false
        })
        return undefined
      },
    },
  },
})

const heading = (level, text) => ({ type: 'heading', level, text })
const paragraph = (text) => ({ type: 'paragraph', text })

test('an H1 registers as a section', () => {
  const headings = collectHeadings(editorWith([heading(1, 'Morning light'), paragraph('body')]))
  assert.equal(headings.length, 1, 'the H1 must not be skipped')
  assert.equal(headings[0].level, 'h1')
  assert.equal(headings[0].text, 'Morning light')
  assert.equal(SECTION_LEVEL, 'h1', 'H1 is the section level')
})

test('headings below the outline depth are ignored', () => {
  // The editor allows h1-h3; anything else is not part of the outline.
  const headings = collectHeadings(editorWith([heading(1, 'One'), heading(4, 'Four'), heading(3, 'Three')]))
  assert.deepEqual(headings.map((h) => h.level), ['h1', 'h3'])
  assert.deepEqual(OUTLINE_LEVELS, ['h1', 'h2', 'h3'])
})

test('H2 and H3 nest under the nearest H1 section', () => {
  const headings = collectHeadings(
    editorWith([
      heading(1, 'First section'),
      heading(2, 'Subsection'),
      heading(3, 'Detail'),
      heading(1, 'Second section'),
      heading(2, 'Another subsection'),
    ]),
  )

  assert.equal(getParentId(headings, 0), null, 'a section is top level')
  assert.equal(getParentId(headings, 1), headings[0].id, 'h2 nests under the h1')
  assert.equal(getParentId(headings, 2), headings[1].id, 'the h3 takes the nearer h2, not the h1')
  assert.equal(getParentId(headings, 3), null, 'the second section is top level')
  assert.equal(getParentId(headings, 4), headings[3].id, 'h2 nests under the second h1')
})

test('an h3 under an h2 belongs to the h2, not the section', () => {
  const headings = collectHeadings(editorWith([heading(1, 'Section'), heading(2, 'Sub'), heading(3, 'Leaf')]))
  assert.equal(getParentId(headings, 2), headings[1].id, 'the nearest h2 wins')
})

test('sections are numbered in document order and only sections are numbered', () => {
  const headings = collectHeadings(
    editorWith([heading(1, 'One'), heading(2, 'Sub'), heading(1, 'Two'), heading(2, 'Sub')]),
  )
  assert.equal(sectionNumber(headings, 0), 1)
  assert.equal(sectionNumber(headings, 2), 2, 'numbering continues across nested rows')
})

test('only rows that actually nest get a disclosure toggle', () => {
  const headings = collectHeadings(
    editorWith([heading(1, 'One'), heading(2, 'Sub'), heading(3, 'Leaf'), heading(1, 'Two')]),
  )
  assert.equal(hasChildren(headings, 0), true, 'the section has a subsection')
  assert.equal(hasChildren(headings, 1), true, 'the subsection has a detail')
  assert.equal(hasChildren(headings, 2), false, 'a leaf row has nothing under it')
  assert.equal(hasChildren(headings, 3), false, 'the last section is empty')
})

test('an h3 directly under an h1 still folds into that section', () => {
  // getParentId falls back to the h1, so the section must be foldable even
  // though the next heading is not the level below it.
  const headings = collectHeadings(editorWith([heading(1, 'Section'), heading(3, 'Detail')]))
  assert.equal(getParentId(headings, 1), headings[0].id)
  assert.equal(hasChildren(headings, 0), true, 'the section must offer the fold toggle')
})












// --- which section the reader is in -----------------------------------------
// The rule moved out of the editor effect so it can be tested without a DOM:
// jsdom computes no geometry, so nothing ever intersects on its own, and a
// two-heading document cannot be typed into through the harness.

const TRACKED = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

test('the last heading in the region wins, so scrolling down advances', () => {
  assert.equal(pickActiveHeading(TRACKED, new Set(['a'])), 'a')
  assert.equal(pickActiveHeading(TRACKED, new Set(['a', 'b'])), 'b')
  // Set order is insertion order, and the observer does not report in document
  // order, so a Set-only implementation would pick 'a' here.
  assert.equal(pickActiveHeading(TRACKED, new Set(['c', 'a'])), 'c')
})

test('an empty region is null, and the caller must keep the previous heading', () => {
  // The reader spends most of their time in the body text between headings.
  // Returning the first heading, or a stale one, would make the outline jump.
  assert.equal(pickActiveHeading(TRACKED, new Set()), null)
})

test('an id that is not tracked is ignored', () => {
  // The observer is torn down and rebuilt as the outline changes, so an entry
  // can arrive for a heading that is no longer in the list.
  assert.equal(pickActiveHeading(TRACKED, new Set(['a', 'gone'])), 'a')
  assert.equal(pickActiveHeading([], new Set(['a'])), null)
})
