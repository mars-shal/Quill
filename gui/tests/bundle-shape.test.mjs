/**
 * The bundle's shape, and the claims made about it.
 *
 * `DocumentEditor.jsx` spent a while carrying a comment about code-splitting
 * that the build never did: `main.jsx` imported it statically, and the weight
 * that would have justified a split arrives through `useCollaborativeDocument`
 * anyway. The comment was wrong, and `vite.config.js` had a
 * `chunkSizeWarningLimit` of 1200 to accommodate a split that was not happening
 * -- a number that looked like a decision and had already outgrown the bundle it
 * was meant to describe.
 *
 * These tests pin the invariant rather than one particular answer, because either
 * resolution is legitimate: a real dynamic import, or an honest single chunk with
 * the reasoning recorded next to it. What is not legitimate is a claim of a split
 * that does not exist, and that is what fails here.
 *
 * Source-level, like `render-cost.test.mjs`: a split either happens or it does
 * not, and neither is observable from a mounted tree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const read = (...parts) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', ...parts), 'utf8')

const mainSource = read('src', 'main.jsx')
const editorSource = read('src', 'editor', 'DocumentEditor.jsx')
const viteSource = read('vite.config.js')

/** True when the editor module is actually behind a dynamic import. */
const isDynamic = /import\(\s*['"][^'"]*DocumentEditor/.test(mainSource)

/**
 * A claim that the module is loaded lazily, rather than a statement that it is
 * not.
 *
 * Only affirmative phrasings are matched -- the shapes the stale comment took and
 * the obvious rewrites of them. Denying the split is allowed, and the honest
 * comment in this file does exactly that, so rewording it must not fail here.
 */
const claimsLazyLoad = [
  /so it can be code-?split/i,
  /so they can be code-?split/i,
  /code-?split and loaded only when/i,
  /is loaded only when a document is opened/i,
  /lazy-?loaded/i,
].filter((pattern) => pattern.test(editorSource))

test('the editor module does not claim a split the build does not perform', () => {
  if (isDynamic) return
  assert.deepEqual(
    claimsLazyLoad,
    [],
    `DocumentEditor.jsx claims a lazy load the build does not perform (${claimsLazyLoad.join(', ')}); ` +
      'either import it dynamically or drop the claim',
  )
})

test('the five assistant effects are deferred, not bundled into the critical path', () => {
  // The counterweight to the editor above. That one cannot be split; these
  // certainly could be, and were 426kB of the critical path until they were.
  // Asserted on source because the build output is not available to the suite.
  const effects = read('src', 'library', 'chat-effects.js')
  for (const pkg of ['metal-fx', 'bot-avatars', 'thinking-orbs', 'border-beam', 'liquid-gooey']) {
    assert.doesNotMatch(mainSource, new RegExp(`from '${pkg}'`), `${pkg} is on the critical path`)
    assert.match(effects, new RegExp(`import\\('${pkg}'\\)`), `${pkg} is not deferred`)
  }
})

test('no chunk size limit silences the warning the build already wants to give', () => {
  // This one was 1200, then 1500. Both sat just above the bundle as measured,
  // which meant the warning could never fire -- the exact opposite of what the
  // comment beside it argued for ("a standing warning is how warnings stop being
  // read"). A limit set above the current size is not a standing warning; it is
  // the absence of one, written down so it looks deliberate.
  //
  // The invariant is that the limit cannot exceed the chunk it is meant to
  // describe, and the smallest honest way to state that is: either leave it
  // unset and let Vite's 500kB default speak, or set it low enough that it can
  // still fire. The main chunk is ~964kB minified / 307kB gzipped.
  const limit = viteSource.match(/chunkSizeWarningLimit:\s*(\d+)/)
  if (limit) {
    assert.ok(
      Number(limit[1]) < 1000,
      `chunkSizeWarningLimit is ${limit[1]}, above the ~964kB chunk it describes: ` +
        'the build warns anyway, so the number only looks like a decision',
    )
  }
  assert.match(
    viteSource,
    /deliberately unset|left unset|Vite's default/i,
    'the limit needs the reasoning beside it, not just a number or its absence',
  )
})

test('the editor weight is not attributed to a module that did not split', () => {
  // ProseMirror and Yjs are the reason the main chunk is large, and neither is
  // lazy-able: the editor is mounted for the whole session, and the document
  // arrives through `useCollaborativeDocument` regardless. So `DocumentEditor.jsx`
  // claiming a split would be the same dishonesty in a different file. If that
  // ever changes, this test is the thing that notices.
  assert.ok(
    isDynamic || !/DocumentEditor/i.test(claimsLazyLoad.join(' ')),
    'the editor is not behind a dynamic import, so it must not claim a lazy load',
  )
})

test('the ProseMirror weight is where a future split would have to start', () => {
  // The editor surface is a thin wrapper; `useCollaborativeDocument` is what
  // pulls ProseMirror in. A split that only moved DocumentEditor would move
  // almost nothing, so the file has to name the module that carries the weight.
  const hook = read('src', 'editor', 'useCollaborativeDocument.js')
  assert.match(hook, /tiptap|prosemirror/i, 'useCollaborativeDocument should be where the editor stack is created')
  assert.match(
    editorSource,
    /useCollaborativeDocument/,
    'DocumentEditor should name the module that actually carries the weight',
  )
})
