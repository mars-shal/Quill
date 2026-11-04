/**
 * Renders the real application against a stubbed Tauri IPC.
 *
 * A blank window with no visible error means React threw during render: `App`
 * had no error boundary, so the whole tree unmounted and left nothing visible.
 * This test mounts the real component tree so that class of failure fails
 * loudly here instead of silently in the window.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./tests/setup.mjs \
 *        --test tests/app-render.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// The JSDOM instance, the browser API gaps, the stubbed Tauri IPC, the stub
// documents and the navigation helpers all come from the shared harness. They
// used to be copied into this file, which is how the two render suites drifted:
// the harness grew a `localStorage` stub and this suite kept the old copy.
import {
  awaitBoot,
  calls,
  captureConsoleErrors,
  clickNav,
  emitIntersections,
  consoleErrors,
  dom,
  handlers,
  lastIntersectionObserver,
  navButton,
  press,
  root,
  settle,
  tick,
  mockFramerMotion,
  tileTitles,
  typeInto,
} from './support/dom-harness.mjs'

// Used directly by the boundary tests below, which build their own tree.
const React = (await import('react')).default

mockFramerMotion()

// --- mount ------------------------------------------------------------------

const restoreConsole = captureConsoleErrors()

// main.jsx mounts itself into #root on import. Boot is async (a run of IPC
// round trips), so wait for it rather than guessing a tick count: under load
// 250ms was not enough and the suite reported a stuck boot screen that was
// merely slow. Two phases, because the first check can run before React has
// painted anything at all -- wait for the shell to exist, then for the boot
// overlay (which only exists while boot is in flight) to clear. A genuine
// boot failure keeps the overlay up and the assertions below fail with the
// real message after the timeout.
await import('../src/main.jsx')
await awaitBoot()
restoreConsole()


const html = root.innerHTML

// --- assertions -------------------------------------------------------------

test('the app shell rendered', () => {
  assert.match(html, /app-shell/, 'app shell should be present')
})

test('it is not stuck on the boot screen', () => {
  assert.doesNotMatch(html, /Opening your workspace/, `stuck booting:\n${html.slice(0, 400)}`)
})

test('React did not throw during render', () => {
  const thrown = consoleErrors.filter((line) =>
    /Error:|is not a function|is not defined|Cannot read|Uncaught|Invalid hook/i.test(line),
  )
  assert.deepEqual(thrown, [], `render errors:\n${thrown.join('\n---\n')}`)
})

test('the library rendered with its document', () => {
  assert.match(html, /library-layout/, 'library layout missing')
  assert.match(html, /Stub Document/, 'document title missing')
  assert.match(html, /document-cover/, 'document card missing')
  assert.match(html, /All documents/, 'library nav missing')
})

test('the editor layer is present in the DOM', () => {
  assert.match(html, /editor-shell/, 'editor shell missing')
})

test('bootstrapping used the expected commands', () => {
  const commands = calls.map((c) => c.command)
  assert.ok(commands.includes('bootstrap'), `calls: ${commands.join(', ')}`)
  assert.ok(commands.includes('list_documents'), `calls: ${commands.join(', ')}`)
})

test('the account is read after bootstrap, not inside it', async () => {
  // `account_state` makes a live network call with an 8s timeout when sync is on,
  // so folding it into `bootstrap` would put the app's launch behind the network
  // round trip. This used to live in `account.test.mjs`, which mounted the app for
  // the account chip's benefit; the chip is gone, but the ordering it guarded is
  // not — the state is still read, and it is still what `Editor`'s export author
  // comes from.
  //
  // The call lands from an effect once bootstrapped flips, so the assertion
  // waits for it rather than racing the effect (it intermittently arrived one
  // tick late and failed as a missing call).
  for (let i = 0; i < 60 && !calls.some((call) => call.command === 'account_state'); i += 1) {
    await tick(25)
  }
  const order = calls.map((call) => call.command)
  const bootIndex = order.indexOf('bootstrap')
  const accountIndex = order.indexOf('account_state')
  assert.ok(accountIndex > bootIndex, `account_state must follow bootstrap: ${order.join(', ')}`)
})

test('no unstubbed IPC command was attempted', () => {
  const unexpected = calls.map((c) => c.command).filter((c) => !(c in handlers))
  assert.deepEqual([...new Set(unexpected)], [], `unexpected: ${unexpected.join(', ')}`)
})

// --- a failing effect must not take the window with it ---------------------
// `metal-fx` threw during render in the real WebKitGTK webview ("WebGL2 not
// supported"), reached the top-level boundary and unmounted the whole editor.
// These tests pin the containment behaviour so that cannot regress.

test('EffectBoundary keeps its fallback and leaves siblings mounted', async () => {
  const { EffectBoundary, ErrorBoundary } = await import('../src/ErrorBoundary.jsx')

  const Boom = () => {
    throw new Error('WebGL2 not supported')
  }

  const root = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(root)

  const draw = React.createElement(
    'div',
    null,
    React.createElement('p', { id: 'before' }, 'editor content'),
    React.createElement(
      EffectBoundary,
      { fallback: React.createElement('span', { id: 'fallback' }, 'plain button') },
      React.createElement(Boom),
    ),
    React.createElement('p', { id: 'after' }, 'status bar'),
  )

  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args[0])

  try {
    const { createRoot } = await import('react-dom/client')
    const { flushSync } = await import('react-dom')
    flushSync(() => { createRoot(root).render(draw) })
    await tick(60)

    assert.ok(root.querySelector('#fallback'), `the fallback should render in place of the effect; got: ${root.innerHTML}`)
    assert.ok(root.querySelector('#before'), 'content before the effect must survive')
    assert.ok(root.querySelector('#after'), 'content after the effect must survive')
    assert.ok(!root.querySelector('.boot-error'), 'the crash page must not replace the app')
    assert.ok(errors.length > 0, 'the failure should still be logged')
  } finally {
    console.error = originalError
  }
})

test('a boundary with no fallback still reports the crash', async () => {
  const { ErrorBoundary } = await import('../src/ErrorBoundary.jsx')
  const Boom = () => {
    throw new Error('kaboom')
  }
  const root = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(root)
  const originalError = console.error
  console.error = () => {}
  try {
    const { createRoot } = await import('react-dom/client')
    const { flushSync } = await import('react-dom')
    flushSync(() => { createRoot(root).render(React.createElement(ErrorBoundary, null, React.createElement(Boom))) })
    await tick(60)
    assert.ok(root.querySelector('.boot-error'), `the top-level boundary keeps its crash page; got: ${root.innerHTML}`)
  } finally {
    console.error = originalError
  }
})

// --- sidebar filters ---------------------------------------------------------
// The Collections and Status buttons rendered and showed correct counts, but
// clicking them did not change the grid. A count is computed from a different
// predicate than the filter in some refactors, so the counts alone prove
// nothing; these tests drive the actual click.

test('the sidebar shows both stub documents', () => {
  const titles = tileTitles()
  assert.ok(titles.includes('Stub Document'), `expected the first stub, got ${titles.join(', ')}`)
  assert.ok(titles.includes('Stub Chapter'), `expected the second stub, got ${titles.join(', ')}`)
})

test('a collection filter narrows the grid', async () => {
  await clickNav('Essays')
  assert.deepEqual(tileTitles(), ['Stub Document'], 'Essays should show only the essay')
  assert.ok(navButton('Essays').className.includes('active'), 'the active filter must be marked')
})

test('a second collection filter replaces the first', async () => {
  await clickNav('Chapters')
  assert.deepEqual(tileTitles(), ['Stub Chapter'], 'Chapters should replace the Essays filter')
})

test('a status filter narrows the grid', async () => {
  await clickNav('Published')
  assert.deepEqual(tileTitles(), ['Stub Chapter'], 'Published should show only the published doc')
})

test('the status group filters independently of collections', async () => {
  await clickNav('Drafts')
  assert.deepEqual(tileTitles(), ['Stub Document'], 'Drafts should show the draft')
  // Switching from a status filter to a collection filter must not leave the
  // status filter applied underneath.
  await clickNav('Notes')
  assert.deepEqual(tileTitles(), [], 'Notes has no documents, so the grid empties')
})

test('All documents restores every document', async () => {
  await clickNav('All documents')
  assert.deepEqual(tileTitles().sort(), ['Stub Chapter', 'Stub Document'], 'All documents resets the filter')
  assert.ok(!navButton('All documents').className.includes('active') === false, 'All documents should be active')
})

// --- sidebar counts ---------------------------------------------------------
// The counts were a `docs.filter` per nav item per render, then rebuilt as a
// single memoised pass. The values have to survive that: a stale or zeroed
// count is worse than a slow one, and nothing else in the suite reads them.

const navCount = (label) => {
  const button = navButton(label)
  assert.ok(button, `no nav button for ${label}`)
  return Number(button.querySelector('.nav-count').textContent)
}

test('every sidebar count matches the documents behind it', () => {
  // Two stubs: one Essay/Draft, one Chapter/Published. Notes and Revising have
  // none, which is the case a memoised pass is most likely to drop the key for.
  assert.equal(navCount('All documents'), 2)
  assert.equal(navCount('Essays'), 1)
  assert.equal(navCount('Chapters'), 1)
  assert.equal(navCount('Notes'), 0)
  assert.equal(navCount('Drafts'), 1)
  assert.equal(navCount('Revising'), 0)
  assert.equal(navCount('Published'), 1)
})

test('the sidebar counts describe the whole library, not the filtered view', async () => {
  // Filtering to one document must not leave the other groups counting 1.
  await clickNav('Published')
  assert.equal(navCount('Published'), 1, 'the active filter still counts the filtered group')
  assert.equal(navCount('Essays'), 1, 'a hidden collection is still counted')
  assert.equal(navCount('All documents'), 2, 'and the total is the library, not the grid')
  await clickNav('All documents')
})

test('a tile reports a word count for its own document', () => {
  // The count is memoised per filtered list now, so a lookup miss would render
  // "0 words" rather than an exception.
  const wordCountFor = (title) => {
    const tile = [...root.querySelectorAll('.document-tile')].find((node) =>
      node.querySelector('strong')?.textContent === title,
    )
    assert.ok(tile, `no tile for ${title}`)
    const label = tile.querySelector('.tile-copy span').textContent
    const words = Number(label.match(/·\s*(\d+)\s*words/)[1])
    assert.ok(words > 0, `${title} reported ${words} words: ${label}`)
    return words
  }
  assert.ok(wordCountFor('Stub Document') > 0)
  assert.ok(wordCountFor('Stub Chapter') > 0)
})

// --- renaming the document from its title ----------------------------------
// The title was a `contentEditable` heading that wrote on every keystroke, so
// React re-rendered and reset the text under the caret. It is now a button that
// opens a real input, and these tests drive that whole path.

const titleButton = () => root.querySelector('.document-title-button')
const titleInput = () => root.querySelector('.document-title-input')

test('the title is a button, not a contentEditable heading', () => {
  assert.ok(titleButton(), 'the title must be an activatable control')
  assert.equal(titleButton().textContent, 'Stub Document')
  assert.equal(titleButton().closest('[contenteditable]'), null, 'no contentEditable on the title')
  assert.equal(titleInput(), null, 'the input only exists while editing')
  // Spelt titles are as annoying as spelt body text.
  assert.equal(titleButton().getAttribute('spellcheck'), null)
})

// The rename interactions are covered in `app-render-motion.test.mjs`, which
// runs the real framer-motion. This suite mocks it, and under the mock the
// title component remounts on click and discards the edit — a divergence the
// mock introduces, not something the app does. Since the app ships real
// framer-motion, the faithful test is the one that uses it.

// --- toolbar font and size pickers -----------------------------------------
// The pickers used to show a hardcoded "Inter"/"16" whenever the caret carried
// no textStyle mark, which read as though the document had been set to Inter at
// 16. They now read the caret itself and show a placeholder when nothing is
// applied. The list is the assistant's listbox, with each font row set in the
// face it names.

const fontTrigger = () => root.querySelector('[aria-label="Font family"]')
const sizeTrigger = () => root.querySelector('[aria-label="Text size"]')

test('an untouched paragraph is not reported as Inter at 16', () => {
  assert.ok(fontTrigger(), 'the font picker is in the toolbar')
  assert.ok(sizeTrigger(), 'the size picker is in the toolbar')
  assert.equal(fontTrigger().textContent, 'Font', 'no family applied is shown as a prompt')
  assert.equal(sizeTrigger().textContent, 'Size', 'no size applied is shown as a prompt')
  assert.ok(fontTrigger().classList.contains('is-placeholder'), 'the placeholder is styled as one')
  assert.equal(fontTrigger().getAttribute('aria-haspopup'), 'listbox', 'it announces a listbox')
})

test('the font picker opens a listbox with every face in its own typeface', async () => {
  fontTrigger().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(20)

  const listbox = dom.window.document.body.querySelector('.tool-listbox-popover')
  assert.ok(listbox, 'the click should open the listbox')
  assert.equal(listbox.getAttribute('role'), 'listbox', 'the popover is a real listbox')

  const options = [...listbox.querySelectorAll('[role="option"]')]
  assert.ok(options.length >= 21, `the list should offer the full family set, found ${options.length}`)
  assert.equal(options[0].textContent.trim(), 'Funnel Display', 'the app face leads the list')

  const georgia = options.find((option) => option.textContent.trim() === 'Georgia')
  assert.ok(georgia, 'Georgia is one of the offered families')
  assert.match(georgia.getAttribute('style') || '', /Georgia/, 'each row is set in the face it names')

  // Dismiss again so the next test starts from a closed toolbar.
  listbox.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await tick(20)
  assert.equal(dom.window.document.body.querySelector('.tool-listbox-popover'), null, 'Escape closes it')
})

// --- active-section tracking -------------------------------------------------
// The scroll handler that tracked the active section read a bounding rect for
// every heading on every scroll frame, after a ProseMirror tree walk to resolve
// each one. The observer is the replacement, so these assert it is wired to the
// scroll container with the reading line as its root margin -- and that the
// highlight follows the observer rather than the other way round.
//
// jsdom computes no geometry, so `emitIntersections` drives the callback by
// hand. That is the only way to test this, and it is also why the ordering rule
// lives in a pure helper with its own tests: a one-heading stub document cannot
// exercise "the last one wins".

const activeOutlineRow = () => root.querySelector('.outline-row.active')
const observedHeadings = () => {
  const observer = lastIntersectionObserver()
  return observer ? observer.targets.filter((node) => node.matches('h1, h2, h3')) : []
}

test('the active section is tracked by an observer on the scroll container', () => {
  const observer = lastIntersectionObserver()
  assert.ok(observer, 'expected an IntersectionObserver to have been constructed')
  assert.equal(observer.options.root, root.querySelector('.editor-scroll'), 'the root must be the scroll container')
  // The 190px reading line used to be compared against a rect; it is now the top
  // margin of the observed region.
  assert.equal(observer.options.rootMargin, '-190px 0px 0px 0px')
  assert.equal(observer.options.threshold, 0)
})

test('the observer watches the rendered heading nodes', () => {
  const headings = observedHeadings()
  assert.ok(headings.length > 0, 'the editor rendered no heading nodes to observe')
  // The nodes must be the real rendered elements, not a detached copy.
  for (const node of headings) assert.ok(node.isConnected, 'an observed heading is not in the document')
})

test('a heading entering the region moves the outline highlight', async () => {
  const headings = observedHeadings()
  const matched = emitIntersections(headings, true)
  assert.ok(matched.length > 0, 'the observer is not watching the heading nodes')
  await settle()
  assert.ok(activeOutlineRow(), 'no outline row was marked active')
  const activeText = activeOutlineRow().textContent
  assert.match(activeText, /Heading|Opening/, `unexpected active row: ${activeText}`)
})

test('leaving the region keeps the highlight instead of clearing it', async () => {
  // The reader is in the body text between headings, where nothing intersects.
  // Clearing here would make the outline flicker through the whole document.
  emitIntersections(observedHeadings(), false)
  await settle()
  assert.ok(activeOutlineRow(), 'the highlight must be kept when the region is empty')
})

test('a target the observer does not track is ignored', async () => {
  const stray = document.createElement('h2')
  root.appendChild(stray)
  const before = activeOutlineRow() && activeOutlineRow().textContent
  const observer = lastIntersectionObserver()
  observer.emit([{ target: stray, isIntersecting: true, intersectionRatio: 1 }])
  await settle()
  const after = activeOutlineRow() && activeOutlineRow().textContent
  assert.equal(after, before, 'an untracked target must not change the active section')
  stray.remove()
})

test('the scroll container no longer has a rect-reading scroll handler', () => {
  // Belt and braces for the P1-8 change: a listener here means the per-frame
  // layout is back, whatever the observer does.
  const scroll = root.querySelector('.editor-scroll')
  assert.ok(scroll, 'the scroll container is missing')
  assert.equal(scroll.onscroll, null, 'an inline scroll handler is attached')
})
