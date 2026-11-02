/**
 * The wallpaper overlay must not take clicks.
 *
 * `.app-shell` paints its wallpaper with `::before` and the reader's dim over it
 * with `::after`. Both are `position: absolute; inset: 0`, and `.app-shell` is
 * `position: relative; z-index: auto` -- so it is *not* a stacking context, and
 * the two pseudo-elements resolve against the root. At z-index 0 they paint
 * above the entire Settings page, which is `position: static` and paints
 * earlier. That makes them, in paint order, the topmost thing on screen.
 *
 * With no `pointer-events: none`, that is a full-viewport click-eater. In real
 * Chromium `document.elementFromPoint` over the Appearance tab returned
 * `DIV.app-shell` instead of the tab, and a real `Input.dispatchMouseEvent` click
 * at those coordinates changed nothing -- while `element.click()` from script
 * switched the panel perfectly. Which is why every earlier test was green.
 *
 * jsdom has no hit-testing at all and `element.click()` bypasses the compositor,
 * so no DOM-level assertion in this suite can ever see this class of bug. The
 * only guard available inside `npm test` is to assert that the stylesheet
 * *declares* the intent, which is what this file does.
 *
 * Two halves:
 *
 *   1. The two `.app-shell` layers by name, so a regression names itself.
 *   2. A sweep over every other `::before`/`::after` in the sheet that is
 *      absolutely positioned at `inset: 0` and paints something. This is the half
 *      worth having: it catches the *next* click-eater instead of re-reporting
 *      this one. Every selector the sweep checks is printed, so a failure names
 *      the rule rather than saying "an overlay".
 *
 * The sweep is restricted to pseudo-elements on purpose. `.modal-scrim` and
 * `.boot-layer` are also full-viewport and also opaque, and both are *meant* to
 * receive the click -- dismissing a dialog is the scrim's entire job, and the
 * boot screen has buttons on it. They are real elements with real handlers, so no
 * pseudo-element sweep reaches them; `the interactive full-viewport layers are
 * real elements` pins that reasoning rather than leaving it a coincidence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stylesheet = readFileSync(join(root, 'src', 'styles.css'), 'utf8')

/** `inset: 0`, in the shapes it is actually written in. Not `inset: -2px`. */
const ZERO_INSET = /^0(?:px|%)?(?:\s+0(?:px|%)?){0,3}$/

/**
 * Background values that paint nothing.
 *
 * Deliberately narrow. The sweep exists to catch a layer that covers the screen,
 * and "I think this one is invisible" is exactly the judgement that let the bug
 * through, so a value has to be *provably* see-through to be excused. Anything
 * that goes through `var()` is treated as painting, because only the theme knows
 * what it resolves to.
 */
const TRANSPARENT = /^(transparent|none|0x0{4,8}|#0{4,8})$|^rgba?\([^()]*[,/]\s*0(?:\.0+)?\s*\)$/i

/**
 * Full-viewport surfaces that are meant to be clicked.
 *
 * Listed rather than silently skipped, and asserted to be real elements below,
 * so "the sweep does not cover these" is a checked statement instead of an
 * assumption that happens to hold.
 */
const REAL_INTERACTIVE_SURFACES = [
  {
    selector: '.modal-scrim',
    why: 'dismissing the dialog by clicking the scrim is the behaviour it exists for',
  },
  {
    selector: '.boot-layer',
    why: 'the boot screen carries its own buttons, which have to be clickable',
  },
]

// ---------------------------------------------------------------------------
// the two layers by name
// ---------------------------------------------------------------------------

test('the extractor returns the whole rule body, not a fragment', () => {
  // This is the precondition for every assertion below. A brace matcher that
  // stopped early, or a regex that matched only up to the first `;`, would hand
  // back a plausible-looking slice and pass vacuously. So the body is checked for
  // the declarations that only the *complete* rule can contain: `content: ""` is
  // the last line of `.app-shell::before`, and the wallpaper image is the only
  // `background-image` in it.
  const body = ruleBody(stylesheet, '.app-shell::before')

  assert.ok(body.includes('content: "";'), `extractor lost the tail of the rule: ${JSON.stringify(body)}`)
  assert.ok(body.includes('background-image: var(--wallpaper);'), 'extractor lost the wallpaper declaration')
  assert.ok(body.includes('inset: 0;'), 'extractor lost the geometry')
  // The dim is the sibling's business; this rule must not have absorbed it.
  assert.ok(!body.includes('--wallpaper-dim'), 'the wallpaper body picked up the dim layer')
})

test('the wallpaper layer does not take clicks', () => {
  // The regression, named. This is the declaration that was missing.
  const decls = declarations(ruleBody(stylesheet, '.app-shell::before'))

  assert.equal(
    withoutImportant(decls['pointer-events']),
    'none',
    '.app-shell::before is a full-viewport layer above the whole Settings page; without `pointer-events: none` it swallows every click meant for the app',
  )
})

test('the dim layer over it does not take clicks', () => {
  // Same geometry, same stacking step, and it already had the declaration. Asserted
  // so the pair cannot drift apart again -- the two rules are identical in every
  // respect that matters and should stay that way.
  const decls = declarations(ruleBody(stylesheet, '.app-shell::after'))

  assert.equal(
    withoutImportant(decls['pointer-events']),
    'none',
    '.app-shell::after must match .app-shell::before: neither wallpaper layer may receive clicks',
  )
})

// ---------------------------------------------------------------------------
// the sweep: the next click-eater, not this one
// ---------------------------------------------------------------------------

test('the sweep finds the app-shell layers, so it cannot pass by finding nothing', () => {
  // A sweep over a list that comes back empty is indistinguishable from a sweep
  // that works. If the extractor ever stops matching these, the guard below goes
  // green while checking nothing, so the two are pinned here.
  const checked = checkedSelectors(stylesheet)

  for (const expected of ['.app-shell::before', '.app-shell::after']) {
    assert.ok(checked.includes(expected), `the sweep no longer sees ${expected}; checked: ${checked.join(', ')}`)
  }
  assert.ok(checked.length >= 2, `the sweep found ${checked.length} overlay(s): ${checked.join(', ')}`)
})

test('no full-viewport pseudo-element overlay paints without opting out of hit-testing', (t) => {
  const checked = checkedSelectors(stylesheet)
  for (const selector of checked) t.diagnostic(`checked ${selector}`)

  const violations = overlayViolations(stylesheet)

  assert.deepEqual(
    violations,
    [],
    [
      violations.length
        ? `${violations.length} full-viewport pseudo-element overlay(s) would take clicks:`
        : 'overlay guard found no problems',
      ...violations.map((selector) => `  ${selector}`),
      '',
      'These are `::before`/`::after` rules with `position: absolute` and `inset: 0`',
      'that paint something, so they cover the viewport and sit above whatever',
      '`z-index: 0` resolves against. A decorative layer needs',
      '`pointer-events: none`; a genuinely interactive surface belongs in a real',
      'element with a real handler instead.',
    ].join('\n'),
  )
})

test('the interactive full-viewport layers are real elements', (t) => {
  // The exclusions, checked rather than assumed. If either of these is ever
  // rewritten as a pseudo-element it stops being an interactive surface and
  // becomes exactly what the sweep is looking for -- so this test is where that
  // change has to be noticed.
  for (const { selector, why } of REAL_INTERACTIVE_SURFACES) {
    t.diagnostic(`excluded ${selector}: ${why}`)

    const matches = allRules(stylesheet).filter((rule) => rule.prelude === selector)
    assert.equal(matches.length, 1, `expected one "${selector}" rule, found ${matches.length}`)

    const decls = declarations(matches[0].body)
    assert.ok(ZERO_INSET.test(decls.inset ?? ''), `${selector} is no longer full-viewport; the exclusion needs revisiting`)
    assert.ok(paints(decls), `${selector} no longer paints anything; the exclusion needs revisiting`)
    assert.ok(!matches[0].prelude.includes('::'), `${selector} is a pseudo-element now, so the sweep must cover it`)
    assert.ok(
      !checkedSelectors(stylesheet).includes(selector),
      `${selector} is being swept as a pseudo-element overlay; it is interactive and must not be forced to ` +
        '`pointer-events: none`',
    )
  }
})

// ---------------------------------------------------------------------------
// the predicate, pinned against fixtures -- a guard that cannot fail is worse
// than no guard
// ---------------------------------------------------------------------------

test('the sweep catches a click-eater shaped exactly like the wallpaper', () => {
  // The regression itself, as a fixture: the pre-fix `.app-shell::before`.
  const before = `.app-shell::before {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-image: var(--wallpaper);
  background-size: cover;
  content: "";
}`
  assert.deepEqual(overlayViolations(before), ['.app-shell::before'], 'the missing declaration must be flagged')

  // And the fixed one: the stylesheet's own rule, with the declaration back in.
  const after = before.replace('  content: "";', '  pointer-events: none;\n  content: "";')
  assert.deepEqual(overlayViolations(after), [], 'the fixed rule must be clean')

  // Each of these paints something opaque and is absolutely positioned, so only one
  // thing puts it out of scope -- which is the point of pinning them individually.
  // A hit-box that is not the whole viewport is not a full-window click-eater.
  assert.deepEqual(
    overlayViolations(`.nav-item::before { position: absolute; inset: auto 0 0 0; background: #000; }`),
    [],
    'a bar along the bottom edge is not a full-viewport overlay',
  )
  // A real element with a real handler is allowed to be clickable; see the
  // exclusions above.
  assert.deepEqual(
    overlayViolations(`.modal-scrim { position: absolute; inset: 0; background: var(--scrim); }`),
    [],
    'the sweep is for pseudo-elements, not for interactive elements',
  )
  // In-flow, or not positioned at all: no box over the viewport.
  assert.deepEqual(overlayViolations(`.a::before { inset: 0; background: #000; }`), [])
  assert.deepEqual(overlayViolations(`.a::before { position: static; inset: 0; background: #000; }`), [])

  // An overlay that paints nothing cannot eat a click, so it is excused -- and
  // `opacity: 0` does *not* excuse one, because an invisible layer still
  // intercepts the hit test. That distinction is the whole reason the predicate
  // looks at the background rather than at a computed style it cannot compute.
  assert.deepEqual(
    overlayViolations(`.a::before { position: absolute; inset: 0; background: transparent; }`),
    [],
    'a provably see-through overlay is not a click-eater',
  )
  assert.deepEqual(
    overlayViolations(`.a::before { position: absolute; inset: 0; background: rgba(0, 0, 0, 0); }`),
    [],
    'zero alpha is zero alpha, whatever the colour',
  )
  assert.deepEqual(
    overlayViolations(`.a::before { position: absolute; inset: 0; background: black; opacity: 0; }`),
    ['.a::before'],
    'opacity: 0 hides the layer but does not stop it taking clicks',
  )
  assert.deepEqual(
    overlayViolations(`.a::before { position: absolute; inset: 0; background-image: var(--x); }`),
    ['.a::before'],
    'a value behind var() paints unless the theme says otherwise',
  )

  // `pointer-events` is compared by value, so the `!important` spelling and the
  // grouped-selector spelling are both read correctly.
  assert.deepEqual(overlayViolations(`.a::before { position: absolute; inset: 0; background: #000; pointer-events: none !important; }`), [])
  assert.deepEqual(overlayViolations(`.a::before, .b::before { position: absolute; inset: 0; background: #000; pointer-events: none; }`), [])

  // Nesting is followed, because a decorative overlay written inside a media query
  // is just as much of a click-eater as one written outside it.
  const nested = `@media (min-width: 900px) {
  .a::before { position: fixed; inset: 0; background: var(--x); }
}`
  assert.deepEqual(overlayViolations(nested), ['.a::before'], 'an overlay inside @media must still be swept')

  // A comment mentioning `::before` is not a rule. Sweeping the raw sheet would
  // count this one.
  assert.deepEqual(overlayViolations('/* ::before { position: absolute; inset: 0; } */\n.a { color: red; }'), [])
})

// ---------------------------------------------------------------------------
// helpers: enough CSS to read the sheet, and no more
// ---------------------------------------------------------------------------

/**
 * Comments blanked out, character for character.
 *
 * Length-preserving on purpose: a rule's position in the source is not needed, but
 * a stripped string that silently diverges in length would mean the stripper
 * mangled something, and that is exactly the kind of quiet wrong answer a guard
 * must not be built on. The comment characters become spaces (newlines survive)
 * so a comment cannot join two declarations into one.
 */
function stripComments(src) {
  let out = ''
  let i = 0
  for (;;) {
    const open = src.indexOf('/*', i)
    if (open === -1) {
      out += src.slice(i)
      return out
    }
    const close = src.indexOf('*/', open + 2)
    if (close === -1) throw new Error('unterminated comment in the stylesheet')
    out += src.slice(i, open)
    for (let c = open; c < close + 2; c += 1) out += src[c] === '\n' ? '\n' : ' '
    i = close + 2
  }
}

/**
 * Every `{ ... }` block in `src`, with the prelude that opened it.
 *
 * Brace-matched rather than regex-matched: a regex cannot see a nested `@media`
 * block, an `@keyframes` body, or a declaration value containing a brace, and all
 * three appear in this sheet. Depth-counting from the opening brace is the only
 * reading here that cannot stop at the wrong `}`.
 */
function blocks(src) {
  const found = []
  let preludeStart = 0
  let i = 0
  while (i < src.length) {
    if (src[i] !== '{') {
      i += 1
      continue
    }
    const prelude = src.slice(preludeStart, i).trim()
    let depth = 1
    let cursor = i + 1
    while (cursor < src.length && depth > 0) {
      if (src[cursor] === '{') depth += 1
      else if (src[cursor] === '}') depth -= 1
      cursor += 1
    }
    if (depth > 0) throw new Error(`unbalanced braces after ${JSON.stringify(prelude)}`)
    found.push({ prelude, body: src.slice(i + 1, cursor - 1) })
    i = cursor
    preludeStart = i
  }
  return found
}

/**
 * Every style rule in the sheet, from inside `@media` blocks too.
 *
 * At-rule bodies are descended rather than read: `@media` holds rules, while
 * `@keyframes` holds percentage selectors, and neither can be mistaken for a
 * pseudo-element rule on the way through.
 */
function allRules(src = stylesheet) {
  const clean = stripComments(src)
  assert.equal(clean.length, src.length, 'stripping comments must preserve length, or the stripper mangled the sheet')
  const out = []
  for (const { prelude, body } of blocks(clean)) {
    if (prelude.startsWith('@')) {
      out.push(...allRules(body))
      continue
    }
    out.push({ prelude, body })
  }
  return out
}

/**
 * The declarations of one rule body, lower-cased property names.
 *
 * Only the text before the first `{` is read, because that is where a rule's own
 * declarations live -- anything after it belongs to a nested block. Splitting on
 * `;` does not survive a `data:` URI in a background value; no overlay in this
 * sheet has one, and a sweep that could not see such a rule would still require
 * `pointer-events: none` of it by failing loudly rather than by skipping.
 */
function declarations(body) {
  const out = {}
  for (const chunk of body.split('{')[0].split(';')) {
    const colon = chunk.indexOf(':')
    if (colon === -1) continue
    const prop = chunk.slice(0, colon).trim().toLowerCase()
    const value = chunk.slice(colon + 1).trim()
    if (prop && value) out[prop] = value
  }
  return out
}

/** Whether a rule's own background declarations paint a visible layer. */
function paints(decls) {
  return Object.entries(decls).some(([prop, value]) => prop.startsWith('background') && !TRANSPARENT.test(value))
}

function withoutImportant(value) {
  return (value ?? '').replace(/\s*!important\s*$/i, '')
}

/**
 * The pseudo-element overlays a reader can be looking at: full-viewport, painted,
 * and therefore either deliberately click-through or a bug.
 */
function fullViewportOverlays(src) {
  return allRules(src).filter((rule) => {
    if (!/::(before|after)/.test(rule.prelude)) return false
    const decls = declarations(rule.body)
    if (!/^(absolute|fixed)$/.test(decls.position ?? '')) return false
    if (!ZERO_INSET.test(decls.inset ?? '')) return false
    return paints(decls)
  })
}

function checkedSelectors(src) {
  return fullViewportOverlays(src).map((rule) => rule.prelude)
}

function overlayViolations(src) {
  return fullViewportOverlays(src)
    .filter((rule) => withoutImportant(declarations(rule.body)['pointer-events']) !== 'none')
    .map((rule) => rule.prelude)
}

/** The body of exactly one rule with this selector, or a failure that says so. */
function ruleBody(src, selector) {
  const matches = allRules(src).filter((rule) => rule.prelude === selector)
  assert.equal(
    matches.length,
    1,
    [
      `expected exactly one "${selector}" rule, found ${matches.length}.`,
      `Pseudo-element rules in the sheet: ${allRules(src).filter((r) => /::(before|after)/.test(r.prelude)).map((r) => r.prelude).join(' | ') || '(none)'}`,
      'If the selector was regrouped, this test needs to follow it -- do not delete the assertion.',
    ].join('\n'),
  )
  return matches[0].body
}