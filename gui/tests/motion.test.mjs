/**
 * Motion regression guards.
 *
 * The library grid and the side panels both visibly hunted frame to frame. Two
 * causes, both of which are easy to reintroduce because each prop looks
 * reasonable on its own:
 *
 *  1. Every tile carried `layout` *and* `animate={{ y }}` *and*
 *     `whileHover={{ y }}`. `layout` reprojects the transform on every frame
 *     while the other two also write it, so the tile oscillated between them.
 *     `layout` is for reordering a stable set; a filter replaces the set.
 *  2. The panels animated `width` under a spring. Width re-runs layout every
 *     frame, and a spring settles by overshooting, so the panel visibly hunted.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// These guards assert on markup rather than on which file it sits in, so they
// read every app module joined together -- see `support/app-source.mjs`. The
// per-file `appSources` list is still what the "defined exactly once" guards
// below use, because joining is the one thing that would break them.
const jsx = appJsx()

/** One module's source by its path relative to `src/`, for guards about that file. */
const sourceOf = (path) => {
  const found = appSources.find(([name]) => name === path)
  assert.ok(found, `expected ${path} among the app sources`)
  return found[1]
}
import { appJsx, appSources } from './support/app-source.mjs'
// The dialog transition moved out of `main.jsx` into a module the onboarding
// card could share, so the source-text guards that check its numbers read it from
// where it lives now. Reading it from `main.jsx` would slice an empty string and
// fail on a missing regex rather than on a bad spring.
const motionLib = readFileSync(join(root, 'src', 'library', 'motion.js'), 'utf8')
// Comments are stripped because these guards match CSS declarations, and the
// prose in this stylesheet names rules (`translateX`, `box-shadow`) that the
// assertions below are specifically trying to prove are or are not in effect.
const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The JSX for one `document-tile`, from its opening tag to the next one. */
/**
 * The document tiles, as they are now: plain `<article>` elements.
 *
 * They used to be `motion.article` with an `initial`/`animate` pair, a
 * `whileHover` lift, a `whileTap` press and an `exit` -- fifteen rAF-driven
 * animations in a fifteen-book library, competing with the layer fade for the
 * same frames. The entrance is a CSS keyframe with a stagger, hover and press are
 * transitions, and the grid is keyed on the view so the entrance replays.
 */
const tileTags = () => [...jsx.matchAll(/<article[^>]*document-tile[^>]*>/g)].map((m) => m[0])

/**
 * Every `motion.*` element that also carries a class we animate.
 *
 * Scoped to a list on purpose: the guard is about elements that write a
 * transform channel *and* ask framer to project it, so matching all of
 * `motion.` would be a broader rule than the bug it prevents. The outline rows
 * were missing here, which is exactly how `layout` survived on them -- the
 * tile-only regex never saw them.
 */
const projectedTags = () => [
  ...jsx.matchAll(/<motion\.[a-z]+[^>]*\bdocument-tile\b[^>]*>/g),
  ...jsx.matchAll(/<motion\.[a-z]+[^>]*\boutline-item\b[^>]*>/g),
  ...jsx.matchAll(/<motion\.[a-z]+[^>]*\bselection-bubble\b[^>]*>/g),
].map((m) => m[0])

test('the library grid uses no framer-motion at all', () => {
  // The regression this pins: fifteen books, fifteen springs. A spring is rAF-
  // driven, so a full library was running fifteen animations to do what one CSS
  // keyframe does on the compositor, and it showed up as an app-wide frame rate
  // problem rather than as anything visibly wrong with the grid.
  const tiles = tileTags()
  assert.ok(tiles.length >= 2, `expected the document and new-document tiles, found ${tiles.length}`)
  for (const tag of tiles) {
    assert.doesNotMatch(
      tag,
      /\b(initial|animate|exit|whileHover|whileTap|transition|layout)=/,
      `a tile is still animated by framer: ${tag.slice(0, 90)}`,
    )
  }
  // The keyframe that replaced the springs went too, in the phase that removed
  // animation outside the assistant. Asserted absent rather than left to a
  // comment: a keyframe with no rule applying it is dead CSS, and one with a rule
  // is the animation this phase was asked to delete.
  assert.doesNotMatch(css, /@keyframes tileIn/, 'the tile entrance keyframe is gone')
  assert.doesNotMatch(
    css,
    /\.document-tile[^{]*\{[^}]*\banimation:/,
    'and no tile rule animates on mount',
  )
})




// --- gap 1: the guard was scoped to a list of class names --------------------

/**
 * Every `<motion.*>` opening tag, with its attributes intact.
 *
 * A `[^>]*` scan is not enough: attributes carry arrow functions (`onClick={() => …`),
 * so the first `>` is inside the handler and the tag is cut in half. The one the
 * old scope list happened to use was `motion.article … document-tile`, and it
 * matched nothing else in the file -- which is exactly how `layout` survived on
 * the outline rows. This walks the bracket depth instead of guessing.
 */
const motionTags = () => {
  const tags = []
  const open = /<motion\.[a-zA-Z]+/g
  for (let match = open.exec(jsx); match; match = open.exec(jsx)) {
    let depth = 0
    let index = match.index + match[0].length
    for (; index < jsx.length; index += 1) {
      const character = jsx[index]
      if (character === '(' || character === '{' || character === '[') depth += 1
      else if (character === ')' || character === ']' || character === '}') depth -= 1
      else if (character === '>' && depth <= 0) break
    }
    tags.push(jsx.slice(match.index, index + 1))
  }
  return tags
}

/** A transform channel, as an object key: `{ y: 4 }`, `x: '-50%'`, `scale: 0.94`. */
const WRITES_A_TRANSFORM = /(?:^|[\s,{])(x|y|scale|rotate|skew)\s*:/





test('a closed panel is inert, not just off-screen', () => {
  // The panels stay mounted to preserve the outline and the conversation, so a
  // closed one that is still tabbable is a keyboard trap off the edge.
  //
  // Substring rather than a built regex on purpose. Interpolating a name into a
  // regex source is a trap: an escaping slip turns `rightOpen` into `\r`ightOpen`,
  // and `\r` is a carriage return, so the assertion fails for a reason that has
  // nothing to do with the code under test.
  for (const side of ['leftOpen', 'rightOpen']) {
    const expected = `inert={${side} ? undefined : ''}`
    assert.ok(jsx.includes(expected), `the ${side} panel must be inert when closed: missing ${expected}`)
  }
})




/**
 * Motion budget.
 *
 * "The animations feel slow" was reported after the jitter was fixed. The cause
 * was the spring rather than any tween: at stiffness 260 / damping 28 the
 * damping ratio is about 0.87, so it overshoots visibly and takes roughly 260ms
 * to settle, against 170ms for the current values. These assertions keep the
 * settle time and every duration inside a budget, so the tuning cannot drift
 * back without a test failing.
 */

/** Damping ratio and 1%-settle time for a mass-spring, both in ms. */
const springSettleMs = (stiffness, damping, mass = 1) =>
  (4 / damping) * Math.log(1 / (0.01 * Math.sqrt(stiffness / mass))) * 1000

const dampingRatio = (stiffness, damping) => damping / (2 * Math.sqrt(stiffness))

test('the spring settles quickly and does not visibly overshoot', () => {
  const helper = motionLib
  const stiffness = Number(helper.match(/stiffness:\s*(\d+)/)[1])
  const damping = Number(helper.match(/damping:\s*(\d+)/)[1])
  const mass = Number((helper.match(/mass:\s*([\d.]+)/) || [, '1'])[1])

  const settle = springSettleMs(stiffness, damping, mass)
  assert.ok(settle < 200, `spring settles in ${settle.toFixed(0)}ms; budget is 200ms`)

  // A ratio below about 0.9 reads as a wobble rather than a settle.
  const ratio = dampingRatio(stiffness, damping)
  assert.ok(ratio >= 0.9, `damping ratio ${ratio.toFixed(3)} is under 0.9 and will overshoot`)
})

test('no tween runs longer than the budget', () => {
  // `duration` is seconds under framer-motion and GSAP, and milliseconds under
  // the Web Animations API -- whose options are the ones carrying `composite`.
  // Reading both in one unit turned a 450ms shake into "450s", which is the one
  // thing this guard must not do: fail for a reason other than a slow tween.
  //
  // The unit is decided by a *lookahead*, never by capturing the rest of the
  // line. A capturing `([^\n]*)` is greedy, so it eats the remainder of the
  // line and the global scan resumes past every later `duration:` on it --
  // leaving only the first one visible. `motion.js` declares two on one line
  // (`{ duration: 0 } : { duration: 0.17, ... }`), so that silently hid the
  // one that matters. A lookahead consumes nothing, so every declaration on a
  // line is classified.
  const seconds = [...jsx.matchAll(/duration:\s*([\d.]+)(?![^\n]*composite:)/g)].map(([, value]) => Number(value))
  const milliseconds = [...jsx.matchAll(/duration:\s*([\d.]+)(?=[^\n]*composite:)/g)].map(([, value]) => Number(value))

  assert.ok(seconds.length > 0, 'the transition helpers must declare durations')
  for (const duration of seconds) {
    // A zero is the reduced-motion path and is always allowed.
    assert.ok(duration <= 0.2, `duration ${duration}s exceeds the 0.2s budget`)
  }
  for (const duration of milliseconds) {
    assert.ok(duration <= 500, `duration ${duration}ms exceeds the 500ms budget`)
  }
})

test('no CSS transition or keyframe runs longer than the budget', () => {

  // The assistant panel is the one transition the app keeps, at 0.22s. It is
  // allowlisted by exact declaration rather than by widening the budget, so a new
  // 0.5s transition anywhere else still fails.
  const ALLOWED_TRANSITIONS = new Set(['transform 0.22s cubic-bezier(0.32, 0.72, 0, 1)'])
  for (const [, value] of css.matchAll(/transition:\s*([^;]+)/g)) {
    if (ALLOWED_TRANSITIONS.has(value.trim())) continue
    for (const [, ms] of value.matchAll(/([\d.]+)s/g)) {
      assert.ok(Number(ms) <= 0.2, `CSS transition ${ms}s exceeds the 0.2s budget: ${value.trim()}`)
    }
  }

  // The section-flash halo is deliberately long: it is a highlight that has to
  // be noticed, not a transition. It is exempted by exact name *and* exact
  // duration. The old guard skipped anything matching /flash/i, so
  // `animation: flash-anything 4s` -- a name nobody had ever written -- passed
  // silently, as would any new animation with flash in its name. An allowlist of
  // name to duration is the only form where the exemption cannot grow.
  const LONG_ANIMATIONS = { sectionFlash: 1.6 }
  for (const [, name, seconds] of css.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)s/g)) {
    const allowed = LONG_ANIMATIONS[name]
    if (allowed !== undefined) {
      assert.equal(Number(seconds), allowed, `the ${name} exemption is for ${allowed}s, not ${seconds}s`)
      continue
    }
    assert.ok(
      Number(seconds) <= 0.2,
      `CSS animation ${name} ${seconds}s exceeds the budget and is not the exempted ${Object.keys(LONG_ANIMATIONS).join(', ')}`,
    )
  }
})

test('the section flash animates a compositor-only property', () => {
  // The exemption above says the 1.6s duration is a deliberate choice. It is
  // not a licence to repaint: `box-shadow` on a growing spread re-blurs the
  // region every frame, so the halo is a fixed shadow on a pseudo-element and
  // only its opacity moves.
  const keyframes = css.slice(
    css.indexOf('@keyframes sectionFlash'),
    css.indexOf('}', css.indexOf('@keyframes sectionFlash')),
  )
  assert.ok(keyframes.length > 0, 'expected a sectionFlash keyframes block')
  const properties = [...keyframes.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]).filter((p) => p !== 'from' && p !== 'to')
  assert.ok(properties.length > 0, 'the flash animates nothing')
  for (const property of properties) {
    assert.equal(property, 'opacity', `the flash must animate only opacity, not ${property}`)
  }
  // And the shadow it animates has to be a fixed one on a pseudo-element.
  const halo = css.match(/\.section-flash::after \{[^}]*\}/)
  assert.ok(halo, 'expected the flash halo to be a pseudo-element')
  assert.match(halo[0], /box-shadow: 0 0 0 \d+px var\(--accent-soft\)/, 'the halo shadow must not animate')
  assert.match(halo[0], /animation: sectionFlash/, 'the halo carries the animation')

  // The budget check above exempts anything named `*flash*`, which means a
  // shortened flash would pass it silently. The exemption is for the duration
  // being long on purpose, so the duration itself is pinned here: changing it is
  // a decision someone has to make in the open.
  const declared = halo[0].match(/animation: sectionFlash ([\d.]+)s/)
  assert.ok(declared, 'the halo must declare the flash duration')
  assert.equal(Number(declared[1]), 1.6, `the flash duration changed to ${declared[1]}s`)
  // And the removal timer has to outlast it, or the halo is cut off mid-halo.
  const removal = jsx.match(/classList\.remove\('section-flash'\), (\d+)\)/)
  assert.ok(removal, 'expected the flash removal timer in main.jsx')
  assert.ok(
    Number(removal[1]) > 1600,
    `the flash is removed after ${removal[1]}ms, before its 1600ms animation ends`,
  )
})

test('the flash halo has a visible colour in every theme', () => {
  // `--accent-soft` is what the halo is painted in, so a theme that left it
  // transparent or unset would make the highlight invisible in that theme only.
  const themes = [...css.matchAll(/body\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\n\}/g)]
  assert.ok(themes.length >= 3, `expected the built-in themes, found ${themes.length}`)
  for (const [, name, body] of themes) {
    const token = body.match(/--accent-soft:\s*([^;]+);/)
    assert.ok(token, `the ${name} theme does not define --accent-soft`)
    const alpha = Number(token[1].match(/rgba\([^)]*?,\s*([\d.]+)\s*\)/)?.[1] ?? 1)
    assert.ok(alpha > 0, `the ${name} theme would paint an invisible flash: ${token[1]}`)
  }
})

// --- gap 3: nothing covered the reduced-motion path ---------------------------

/**
 * Reduce motion is a setting, not a preference.
 *
 * The OS query alone left the in-app toggle decorative: a reader who turned
 * Reduce motion on in settings still got every spring. It also has to reach the
 * canvas effects, which are not CSS and so are untouched by the
 * `prefers-reduced-motion` block at the end of the stylesheet.
 */
test('reduce motion combines the OS preference with the in-app setting', () => {
  assert.match(
    jsx,
    /const osReducedMotion = useReducedMotion\(\)/,
    'the OS preference has to be read at all',
  )
  assert.match(
    jsx,
    /const reducedMotion = Boolean\(osReducedMotion\) \|\| Boolean\(settings\.reduceMotion\)/,
    'the setting and the OS preference must be or-ed, not one or the other',
  )
  assert.match(jsx, /reducedMotion=\{reducedMotion\}/, 'Editor has to receive the combined value')
  // The assistant is the one surface the combined value does NOT reach. It
  // follows the OS query alone, so it keeps animating when the reader has only
  // set the in-app toggle. The helpers themselves are untouched -- every other
  // surface still collapses to zero through them.
  assert.match(
    jsx,
    /const assistantReducedMotion = Boolean\(osReducedMotion\)/,
    'the assistant must follow the OS setting alone',
  )
  assert.match(
    jsx,
    /assistantReducedMotion=\{assistantReducedMotion\}/,
    'the assistant signal has to reach the editor, which forwards it to ChatPanel',
  )
})

test('every transition helper collapses to zero under reduce motion', () => {
  const helpers = ['getMotionTransition', 'getFastTransition']
  for (const helper of helpers) {
    // Not all of these live in one file any more: the dialog transition was
    // extracted so a second modal surface could share it. Search both sources and
    // assert that the helper was found in exactly one, so a duplicate copy
    // cannot satisfy the guard while the app uses the other one.
    const sources = appSources.filter(([, source]) => source.includes(`function ${helper}(`))
    assert.equal(
      sources.length,
      1,
      `expected exactly one definition of ${helper}, found ${sources.length} in ${sources.map(([name]) => name).join(' and ')}`,
    )
    const [source, at] = [sources[0][1], sources[0][1].indexOf(`function ${helper}(`)]
    const body = source.slice(at, source.indexOf('\n}', at))
    assert.match(
      body,
      /reducedMotion\s*\?\s*\{\s*duration:\s*0\s*\}/,
      `${helper} must return a zero duration when motion is reduced`,
    )
    // A helper that only collapses one branch is how a spring survives: the
    // panel tween kept `stiffness`/`damping` on its reduced branch at one point.
    assert.ok(
      /reducedMotion\s*\?\s*\{\s*duration:\s*0\s*\}\s*:/.test(body),
      `${helper} must return the zero duration directly, not merge it into spring values`,
    )
  }
})

test('reduce motion pauses the canvas effects, not just the transitions', () => {
  // `bot-avatars` and `thinking-orbs` run a rAF loop. CSS cannot reach them, and
  // the effects are mounted on the editor screen, so the setting has to arrive
  // as `paused`. It is the OS half of the setting that arrives here -- the
  // assistant is the carve-out -- but the shape is unchanged: under
  // `prefers-reduced-motion` every one of these is still frozen.
  assert.match(jsx, /const still = assistantReducedMotion \? \{ paused: true \} : \{\}/, 'the paused props are missing')
  const spreads = [...jsx.matchAll(/\{\.\.\.still\}/g)]
  assert.ok(spreads.length >= 2, `expected the paused props on the canvas effects, found ${spreads.length}`)
  for (const name of ['BotAvatar', 'ThinkingOrb']) {
    const at = jsx.indexOf(`<${name}`)
    assert.ok(at > 0, `expected ${name} to be mounted`)
    assert.match(jsx.slice(at, at + 900), /\{\.\.\.still\}/, `${name} does not receive the paused props`)
  }
  // `border-beam` is not a canvas effect and has no `paused` prop: `active` is
  // its only switch, so reduce motion has to be folded into it. It used to be
  // `active={typing}`, which meant the beam kept travelling while the reader had
  // asked for stillness.
  const beam = jsx.slice(jsx.indexOf('<BorderBeam'), jsx.indexOf('<BorderBeam') + 500)
  assert.ok(jsx.includes('<BorderBeam'), 'expected BorderBeam to be mounted')
  assert.match(beam, /active=\{typing && !assistantReducedMotion\}/, 'BorderBeam must not animate under a reduced-motion OS setting')
})

test('the stylesheet has a reduced-motion block for the CSS half', () => {
  const query = css.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.ok(query > 0, 'expected a prefers-reduced-motion block')
  const block = css.slice(query, css.indexOf('}', query))
  // Durations are collapsed rather than removed: `animation: none` also drops the
  // property the animation is meant to end on, which is the `section-flash` case.
  assert.match(block, /animation-duration:\s*0\.01ms\s*!important/, 'animations must collapse')
  assert.match(block, /transition-duration:\s*0\.01ms\s*!important/, 'transitions must collapse')
  assert.match(block, /scroll-behavior:\s*auto\s*!important/, 'smooth scrolling must be cancelled too')
})

// --- gap 4: no preset was ever checked against the library -------------------

/** The `{ … }` block that starts at `from`, brace-matched. */
function objectAt(source, from) {
  let depth = 0
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, index + 1)
    }
  }
  return ''
}

/**
 * The presets the installed libraries actually define.
 *
 * Read from `node_modules` rather than hardcoded, because a hardcoded list is
 * the same mistake as the comment it replaced: it goes stale silently on an
 * upgrade. `'sharp'` shipped because nothing compared the string against
 * anything.
 */
const libraryPresets = () => {
  const liquid = readFileSync(join(root, 'node_modules', 'liquid-gooey', 'dist', 'index.js'), 'utf8')
  const liquidBlock = objectAt(liquid, liquid.indexOf('presets = {'))
  const liquidNames = [...liquidBlock.matchAll(/([A-Za-z_$][\w$]*):\s*\{/g)].map((m) => m[1])
  assert.ok(liquidNames.length > 0, 'could not read the liquid-gooey presets')

  const types = readFileSync(join(root, 'node_modules', 'metal-fx', 'dist', 'index.d.ts'), 'utf8')
  const union = (name) => {
    const found = types.match(new RegExp(`export declare type ${name} = ([^;]+);`))
    assert.ok(found, `could not read the metal-fx ${name} union`)
    return [...found[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1])
  }
  return { liquid: liquidNames, preset: union('MetalFxPreset'), variant: union('MetalFxVariant') }
}

test('every effect preset is one the library defines', () => {
  const known = libraryPresets()
  for (const [, name] of jsx.matchAll(/preset="([\w-]+)"/g)) {
    assert.ok(
      known.preset.includes(name),
      `preset "${name}" is not a metal-fx preset; it defines ${known.preset.join(', ')}`,
    )
  }
  for (const [, name] of jsx.matchAll(/variant="([\w-]+)"/g)) {
    assert.ok(
      known.variant.includes(name),
      `variant "${name}" is not a metal-fx variant; it defines ${known.variant.join(', ')}`,
    )
  }
  assert.ok(known.preset.length > 0 && known.variant.length > 0, 'the metal-fx unions came back empty')
})

test('every liquid transition names a preset the library defines', () => {
  // This is the exact shape of the P1-4 bug: `transition={reducedMotion ? 'sharp'
  // : 'bouncy'}`. The library resolves the name by indexing its preset table, so
  // an unknown one throws a TypeError *during render* -- on the reduced-motion
  // branch, meaning the setting meant to calm the row was the one that broke it.
  //
  // The flag is matched loosely on purpose: this guard is about preset names, not
  // about which signal happens to carry the request into ChatPanel.
  const known = libraryPresets()
  const transitions = [
    ...jsx.matchAll(/transition=\{(\w*ReducedMotion) \? '([\w-]+)' : '([\w-]+)'\}/g),
  ]
  assert.ok(transitions.length > 0, 'expected a conditional liquid transition')
  for (const [, , calm, lively] of transitions) {
    for (const name of [calm, lively]) {
      assert.ok(
        known.liquid.includes(name),
        `liquid transition "${name}" is not a preset; liquid-gooey defines ${known.liquid.join(', ')}`,
      )
    }
    // The reduced branch should be the calmer of the two. `smooth` is the
    // library's own default and the calmest of the three.
    assert.ok(calm === 'smooth', `the reduced-motion branch should be 'smooth', not '${calm}'`)
  }
})

// --- modal scrim -------------------------------------------------------------

test('the modal scrim blur is painted once, not per frame', () => {
  // A `backdrop-filter` element whose own opacity animates forces the browser to
  // re-blur the viewport on every frame of the fade. The layer's opacity did the
  // fading instead, which was one compositor pass over an unchanged filter
  // result.
  //
  // There is no longer a fade to misplace -- the layer appears outright now -- so
  // the invariant is simply that nothing here animates the scrim or its layer
  // again. That is the cheaper guarantee of the two: no animation means no
  // per-frame blur by construction, rather than by arrangement.
  const source = readFileSync(join(root, 'src', 'ModalLayer.jsx'), 'utf8')
  const scrim = source.match(/<button className="modal-scrim"[^>]*\/?>/)
  assert.ok(scrim, 'expected the modal scrim button')
  assert.doesNotMatch(scrim[0], /\b(motion|animate|initial|exit)\b/, 'the scrim must not be animated')
  assert.doesNotMatch(
    source,
    /<motion\.|AnimatePresence/,
    'the modal layer must not animate: an opacity fade over a backdrop-filter is the per-frame blur',
  )
})

test('every modal surface shares the one scrim implementation', () => {
  // Export used to hand-roll a `dialog-scrim` div, which meant a second scrim
  // with no styling and no shared trap. There must be one scrim and one trap.
  const layer = readFileSync(join(root, 'src', 'ModalLayer.jsx'), 'utf8')
  assert.equal([...layer.matchAll(/className="modal-scrim"/g)].length, 1, 'expected one scrim in ModalLayer')
  // Named, not joined: `jsx` includes ModalLayer itself now, so joining would
  // make this assertion contradict the line above it.
  assert.doesNotMatch(
    sourceOf('main.jsx'),
    /className="modal-scrim"/,
    'the scrim belongs to ModalLayer, not the app shell',
  )
  const exportSource = readFileSync(join(root, 'src', 'ExportDialog.jsx'), 'utf8')
  assert.doesNotMatch(exportSource, /className="dialog-scrim"/, 'Export still has its own scrim')
  assert.match(exportSource, /<ModalLayer /, 'Export should use the shared ModalLayer')
  // Two traps on one surface fight over the same focus, so there is one.
  assert.doesNotMatch(exportSource, /useFocusTrap/, 'Export must not trap focus as well as the layer')
  assert.match(layer, /useFocusTrap\(layerRef, true, onClose\)/, 'the layer must trap focus')
  // The scrim is one real element, and it is carried by its own colour.
  //
  // It used to end in an assertion that `backdrop-filter: blur(3px)` was present,
  // which pinned the cost rather than the behaviour: a backdrop filter has to
  // re-snapshot and re-blur the page behind it on every frame that page changes,
  // and with panels on springs that is most frames. Every dialog in the app paid
  // it. The separation this test actually cares about -- one scrim, one trap, and
  // no dialog growing its own -- is asserted above and is unchanged.
  const rule = css.match(/\.modal-scrim \{[^}]*\}/)
  assert.ok(rule, 'expected the .modal-scrim rule')
  assert.match(rule[0], /background: var\(--scrim\)/, 'the scrim is opaque enough to stand alone')
  assert.doesNotMatch(
    rule[0],
    /backdrop-filter/,
    'no viewport-sized blur on every dialog',
  )
})

test('no stylesheet rule blurs a full-viewport layer', () => {
  // The auth screen shipped with `filter: blur(26px)` on a viewport-sized
  // backdrop. It was the most expensive paint in the app, it stuttered, and it
  // was the reason the photograph looked like a smudge rather than a picture.
  // The rule here is deliberately narrow -- full-viewport `inset: 0` layers only,
  // because a blur on a small element is somebody's business and not a
  // performance defect.
  const offenders = []
  for (const raw of css.split('}')) {
    const open = raw.indexOf('{')
    if (open < 0) continue
    const selector = raw.slice(0, open).trim()
    const body = raw.slice(open + 1)
    if (!/filter\s*:\s*blur|backdrop-filter/.test(body)) continue
    if (!/inset:\s*0/.test(body)) continue
    offenders.push(selector)
  }
  assert.deepEqual(offenders, [], 'a viewport-sized blur is a per-frame rasterisation')
})
