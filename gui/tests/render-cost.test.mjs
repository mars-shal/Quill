/**
 * Guards the re-render cost of the library screen.
 *
 * These are source-level checks on purpose. Whether `React.memo` actually skips
 * a render cannot be observed from the DOM: a memoised and an unmemoised
 * library produce identical markup, and when they differ, React commits no DOM
 * mutation anyway, so neither a MutationObserver nor a timing assertion can tell
 * them apart without becoming flaky. Asserting the structure is stable and
 * catches the regressions that matter.
 *
 * The behaviour the structure exists to protect -- the sidebar counts and the
 * per-tile word counts -- is covered by `app-render.test.mjs`. This file is only
 * about whether the memoisation is still wired up.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const jsx = appJsx()
import { appJsx, appSources } from './support/app-source.mjs'

/** The `<Library ... />` call inside `App`. */
const libraryCall = () => {
  const match = jsx.match(/<Library\b[^>]*\/>/)
  assert.ok(match, 'expected a <Library /> call in App')
  return match[0]
}

/**
 * The body of `App`, from its declaration to the next top-level declaration.
 *
 * The transition helpers are called directly by `Editor` and others, which is
 * correct -- they have no memo to feed. Only the calls inside `App` matter,
 * because those are the ones that become `Library` props.
 */
const appBody = () => {
  const start = jsx.indexOf('\nfunction App(')
  assert.notEqual(start, -1, 'expected an App component')
  const rest = jsx.slice(start + 1)
  const next = rest.slice(1).search(/^function \w/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

test('Library is wrapped in memo', () => {
  assert.match(
    jsx,
    /const Library = memo\(function Library\(/,
    'Library must be memoised; the stats tick otherwise re-renders the whole grid',
  )
})

test('the library props are referentially stable', () => {
  const call = libraryCall()
  // An inline arrow here is a new prop identity on every App render, which
  // defeats the memo no matter how correctly the component is wrapped. These
  // three were arrows until the memo was added and silently made pointless.
  for (const name of ['onFilter', 'onSettings', 'onSort']) {
    const value = call.match(new RegExp(`${name}=\\{([^}]*)\\}`))?.[1]
    assert.ok(value, `expected a ${name} prop on <Library />`)
    assert.doesNotMatch(
      value,
      /=>/,
      `${name} must be a stable callback, not the inline ${value}`,
    )
  }
})



test('the per-tile word count is computed once per list, not per render', () => {
  // The expensive one: a regex strip and a whitespace split over each
  // document's entire HTML.
  //
  // Matched on the memo rather than on a variable name. The map used to be
  // called `wordCounts` and was renamed to `tiles` when the tile preview joined
  // it, but the invariant this test exists for is the one that must not change:
  // the strip runs once per list, not once per render.
  const inline = jsx.match(/\{countWords\(doc\.content/g)
  assert.equal(
    inline,
    null,
    'the tile word count is computed inline in JSX, so it runs on every render',
  )
  assert.match(jsx, /const tiles = useMemo\(/, 'expected a memoised tile map')
  assert.match(jsx, /\{tile\?\.words \?\? 0\} words/, 'the tile should read its count from that map')
})

test('the tile preview shares the word count pass instead of adding one', () => {
  // The preview needs the same tag-stripped text the count needs. A second
  // `doc.content.replace` would double this screen's most expensive operation,
  // which the memo's own comment says as much -- so the guard is that exactly
  // one strip exists in the file.
  const strips = jsx.match(/doc\.content\.replace\(/g) || []
  assert.equal(
    strips.length,
    1,
    `expected one tag-strip over doc.content, found ${strips.length} -- the preview and the count must share a pass`,
  )
  assert.match(jsx, /const plain = doc\.content\.replace/, 'the strip should feed a local both readers use')
  assert.match(jsx, /countWords\(plain\)/, 'the count should read the same stripped text')
})

test('the sidebar counts are computed once per docs change', () => {
  assert.match(jsx, /const navCounts = useMemo\(/, 'expected a memoised nav count map')
  const inRender = jsx.match(/<span className="nav-count">\{(.*?)\}<\/span>/)
  assert.ok(inRender, 'expected the nav count span')
  assert.match(
    inRender[1],
    /navCounts\.get\(/,
    `the nav count should read the memoised map, not recompute: ${inRender[1]}`,
  )
})

test('getCount is gone, so the counts have exactly one implementation', () => {
  // Two implementations of the same number is how the sidebar and the grid
  // start disagreeing.
  assert.doesNotMatch(jsx, /getCount\b/, 'the old per-item getCount helper is still defined')
})
