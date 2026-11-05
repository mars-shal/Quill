/**
 * Renders the real application with the REAL framer-motion.
 *
 * The companion suite (`app-render.test.mjs`) mocks framer-motion, which makes
 * it blind to the entire animation layer: `AnimatePresence` becomes a pass
 * through, `layout` does nothing, and exiting children vanish instantly. That
 * is how a visibly broken library grid passed six passing filter tests.
 *
 * This suite exists to close that gap. It mounts the same App with the same
 * stubbed IPC, but nothing about motion is faked, so the assertions below are
 * about the DOM as the animation actually leaves it.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./tests/setup.mjs \
 *        --test tests/app-render-motion.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  dom,
  root,
  tick,
  awaitBoot,
  calls,
  consoleErrors,
  captureConsoleErrors,
  assertGone,
  tileTitles,
  allTileCount,
  navButton,
  clickNav,
  typeInto,
  press,
} from './support/dom-harness.mjs'

const restoreConsole = captureConsoleErrors()

// main.jsx mounts itself into #root on import. Boot is async, so wait for the
// shell and for the boot overlay to clear rather than guessing a tick count.
await import('../src/main.jsx')
await awaitBoot()
restoreConsole()

// --- assertions -------------------------------------------------------------

test('the real framer-motion renders the library', () => {
  assert.match(root.innerHTML, /library-layout/, 'library layout missing')
  assert.match(root.innerHTML, /editor-shell/, 'editor layer missing')
  assert.deepEqual(tileTitles().sort(), ['Stub Chapter', 'Stub Document'])
  assert.equal(allTileCount(), 3, 'two documents plus the new-document tile')
})

test('motion did not throw on the way in', () => {
  const thrown = consoleErrors.filter((line) =>
    /AbortSignal|is not a function|Cannot read|Uncaught|TypeError|ReferenceError/i.test(line),
  )
  assert.deepEqual(thrown, [], `motion errors:\n${thrown.join('\n---\n')}`)
})

test('a collection filter leaves exactly the matching tiles', async () => {
  await clickNav('Essays')
  assert.deepEqual(tileTitles(), ['Stub Document'], 'only the essay should remain')
  assert.equal(
    root.querySelectorAll('.document-tile:not(.new-document-tile)').length,
    1,
    'no stray tiles may be left in the grid by the exit animation',
  )
  assert.ok(navButton('Essays').className.includes('active'), 'the active filter must be marked')
  assert.ok(!navButton('All documents').className.includes('active'), 'the old filter must be cleared')
})

test('the new-document tile survives every filter change', async () => {
  // It is a sibling inside the same AnimatePresence, so a bad exit handling can
  // take it out along with the filtered documents.
  await clickNav('Chapters')
  assert.deepEqual(tileTitles(), ['Stub Chapter'])
  assert.equal(allTileCount(), 2, 'the new-document tile must remain')
  await clickNav('Notes')
  assert.deepEqual(tileTitles(), [], 'Notes has no documents')
  assert.equal(allTileCount(), 1, 'only the new-document tile should be left')
})

test('switching filters back and forth does not accumulate tiles', async () => {
  for (const label of ['All documents', 'Essays', 'Chapters', 'All documents', 'Essays']) {
    await clickNav(label)
  }
  assert.deepEqual(tileTitles(), ['Stub Document'])
  assert.equal(allTileCount(), 2, `tiles accumulated: ${allTileCount()}`)
})

test('the document title rename survives the real animation layer', async () => {
  // The reported symptom was that tapping the title did nothing. Under the
  // mocked suite the component was remounted and the edit discarded, which may
  // or may not have matched the real app. This is the assertion that decides it.
  const button = root.querySelector('.document-title-button')
  assert.ok(button, 'the title must be a control')
  assert.equal(button.textContent, 'Stub Document')

  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(120)

  const input = root.querySelector('.document-title-input')
  assert.ok(
    input,
    'tapping the title must open an input under the real animation layer; ' +
      `still showing: ${root.querySelector('.document-title')?.outerHTML}`,
  )
  assert.equal(input.value, 'Stub Document')

  const before = calls.length
  typeInto(input, 'A Better Title')
  press(input, 'Enter')
  await tick(120)

  assertGone('.document-title-input', 'the input closes on commit')
  assert.equal(root.querySelector('.document-title-button').textContent, 'A Better Title')

  // The command takes a single `input` object; an unset field is null and means
  // "leave unchanged", so the title has to be read from there.
  const written = calls.slice(before).filter((c) => c.command === 'update_document')
  assert.equal(written.length, 1, 'committing must write exactly once')
  assert.equal(written[0].args.input.id, 'doc-1')
  assert.equal(written[0].args.input.title, 'A Better Title')
})

test('Escape abandons a rename without writing', async () => {
  root.querySelector('.document-title-button')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(120)
  const before = calls.length
  typeInto(root.querySelector('.document-title-input'), 'Discarded')
  press(root.querySelector('.document-title-input'), 'Escape')
  await tick(120)

  assertGone('.document-title-input', 'the inline input is gone')
  assert.equal(root.querySelector('.document-title-button').textContent, 'A Better Title')
  assert.equal(calls.slice(before).filter((c) => c.command === 'update_document').length, 0)
})

test('clicking away from the title commits the pending edit', async () => {
  root.querySelector('.document-title-button')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(150)
  const before = calls.length
  typeInto(root.querySelector('.document-title-input'), 'Blurred Title')
  // React delegates onBlur from `focusout`. A hand-dispatched blur or focusout
  // does not reach it, so focus is genuinely moved to another element and jsdom
  // produces the event itself.
  const elsewhere = dom.window.document.createElement('button')
  dom.window.document.body.appendChild(elsewhere)
  elsewhere.focus()
  await tick(150)
  elsewhere.remove()

  const written = calls.slice(before).filter((c) => c.command === 'update_document')
  assert.equal(written.length, 1, 'blur commits the pending edit')
  assert.equal(written[0].args.input.title, 'Blurred Title')
})

test('a blank title is refused and the previous one kept', async () => {
  root.querySelector('.document-title-button')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(150)
  const before = calls.length
  typeInto(root.querySelector('.document-title-input'), '   ')
  press(root.querySelector('.document-title-input'), 'Enter')
  await tick(150)

  assert.equal(calls.slice(before).filter((c) => c.command === 'update_document').length, 0,
    'a blank title must not be written')
  assert.equal(root.querySelector('.document-title-button').textContent, 'Blurred Title')
})

test('a rename after a cancelled one still commits', async () => {
  // Escape tears the input down before any blur can fire. The flag that
  // suppresses the blur-driven commit therefore survives into the next edit,
  // and used to swallow it: press Escape, reopen, click away, and the rename
  // was silently discarded.
  const open = async () => {
    root.querySelector('.document-title-button')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await tick(150)
    return root.querySelector('.document-title-input')
  }
  const commitByBlur = async () => {
    const other = dom.window.document.createElement('button')
    dom.window.document.body.appendChild(other)
    other.focus()
    await tick(150)
    other.remove()
  }

  const first = await open()
  typeInto(first, 'Discarded')
  press(first, 'Escape')
  await tick(150)

  const second = await open()
  typeInto(second, 'Kept Title')
  const before = calls.length
  await commitByBlur()

  const written = calls.slice(before).filter((c) => c.command === 'update_document')
  assert.equal(written.length, 1, 'the second rename must not be swallowed by a stale cancel flag')
  assert.equal(written[0].args.input.title, 'Kept Title')
  assert.equal(root.querySelector('.document-title-button').textContent, 'Kept Title')
})

test('the panels are mounted and no longer sized by an animation', () => {
  const left = root.querySelector('.left-panel')
  const right = root.querySelector('.right-panel')
  assert.ok(left && right, 'both panels must exist')
  // It used to assert an animated `width`, which is exactly what P1-7 removed: a
  // `width` tween on a grid `auto` track re-solved the grid and re-wrapped the
  // prose column every frame of a toggle. The panels stay mounted so the
  // outline and the conversation survive.
  assert.equal(left.style.width, '', 'the left panel width must not be animated')
  assert.equal(right.style.width, '', 'the right panel width must not be animated')
})

test('closing a panel slides it off-screen and makes it inert', async () => {
  const right = root.querySelector('.right-panel')
  const toggle = () => root.querySelector('[aria-label="Toggle Conclave panel"]')
  const press = async () => {
    toggle().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick(320)
  }
  // This suite shares one mounted app, so an earlier test may have left the
  // panel closed. Start from a known state rather than assuming the default.
  if (right.hasAttribute('inert')) await press()
  assert.equal(right.hasAttribute('inert'), false, 'the panel starts open and reachable')

  await press()
  assert.equal(right.hasAttribute('inert'), true, 'a closed panel must be inert, not just off-screen')
  const pressed = toggle().getAttribute('aria-pressed')
  assert.equal(pressed, 'false', `the toggle must report the new state, got ${pressed}`)
  assert.equal(
    root.querySelector('.left-panel').hasAttribute('inert'),
    false,
    'closing one panel must not touch the other',
  )
  const closed = right.style.transform
  // The closed transform lives in the stylesheet now, keyed off the shell's
  // `right-open` class, rather than in an inline style written by the animation.
  // So the assertion is on the class the shell carries, not on a style attribute
  // that is now always empty. `inert` above is what actually keeps a closed panel
  // unreachable; the transform only keeps it out of sight.
  assert.equal(
    root.querySelector('.app-shell').classList.contains('right-open'),
    false,
    'closing the panel must drop right-open from the shell',
  )
  assert.equal(closed, '', 'the panel position must not be set inline any more')

  // Reopening has to take it back out of the trap, or one toggle makes the
  // panel permanently unreachable.
  await press()
  assert.equal(right.hasAttribute('inert'), false, 'reopening must remove inert')
  assert.equal(
    root.querySelector('.app-shell').classList.contains('right-open'),
    true,
    'reopening must put right-open back on the shell',
  )
})

/**
 * The boot states must not tear the workspace down.
 *
 * They used to be early returns in `App`, so crossing a boot boundary swapped
 * the whole top-level tree and remounted everything inside it. That is the class
 * of bug that made the document title lose its rename state, and an auth gate
 * plus an onboarding flow would have added two more triggers.
 */
test('the app shell is rendered without any early return', () => {
  // A structural check, because the runtime symptom is a remount that a single
  // render cannot distinguish from an ordinary re-render.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.jsx'), 'utf8')
  const appStart = source.indexOf('function App() {')
  const appBody = source.slice(appStart, source.indexOf('\ncreateRoot('))

  // Match only a component-level early return, which renders JSX. A bare
  // `return;` is a guard inside a callback, and those are fine and necessary.
  const earlyReturn = (condition) =>
    new RegExp(`if \\(${condition}\\)\\s*\\{?\\s*return\\s*[<(]`).test(appBody)

  assert.ok(!earlyReturn('!bootstrapped'), 'App must not return early when not bootstrapped')
  assert.ok(!earlyReturn('bootError'), 'App must not return early on a boot error')
  assert.ok(!earlyReturn('!currentDoc'), 'App must not return early for an empty library')

  assert.match(appBody, /<BootLayer/, 'the boot states must be an overlay in the shell')
})

test('the ready workspace has no boot overlay', async () => {
  // The suite's stubbed bootstrap resolves immediately, so the ready state is
  // what is observable here: no overlay, and a real shell.
  assertGone('.boot-layer', 'no overlay once the workspace is ready')
  assert.match(root.innerHTML, /app-shell/)
  assert.match(root.innerHTML, /library-layout/)
})

test('an empty library shows a designed empty state rather than a blank window', async () => {
  // The library owns the empty state now; the boot overlay is reserved for a
  // store failure. The render suite's stub always returns documents, so this is
  // pinned at the source rather than by clearing a list that is already built.
  const library = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'library', 'Library.jsx'), 'utf8')
  assert.match(library, /<EmptyState/, 'the library must render the shared empty state')
  assert.match(library, /Your library is empty/, 'and say what the state is')
  assert.match(library, /New document/, 'with the action that leaves it')
})
