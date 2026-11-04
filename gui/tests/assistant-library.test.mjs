/**
 * Assistant panel and library regression guards.
 *
 * Covers the five Libraries.dev effects, the controls that were removed from
 * the assistant header, and the library cover that used to shear its own title.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const jsx = appJsx()
import { appJsx, appSources } from './support/app-source.mjs'
const chatEffects = readFileSync(join(root, 'src', 'library', 'chat-effects.js'), 'utf8')
const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const icons = readFileSync(join(root, 'src', 'Icon.jsx'), 'utf8')

const rulesFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = []
  // The selector may be followed by `{`, or by `,` when it is one item in a
  // selector list, in which case the declaration block is the list's own.
  const re = new RegExp(`(^|[,}\\n])\\s*${escaped}\\s*(?:,|\\{)([^}]*)\\}`, 'g')
  let match
  while ((match = re.exec(css)) !== null) out.push(match[2])
  return out
}
/**
 * The winning value of a property for a selector.
 *
 * Walks the rules in source order and keeps the last match, because a later
 * rule of equal specificity is the one the cascade applies. The stylesheet
 * layers several restyles of the same selector, so taking the first match
 * would report values that never render.
 */
const valueOf = (selector, prop) => {
  let found
  for (const body of rulesFor(selector)) {
    for (const part of body.split(';')) {
      const [key, ...rest] = part.split(':')
      if (key.trim() === prop) found = rest.join(':').trim()
    }
  }
  return found
}

/** A token's declared value inside a theme block, whatever its value type. */
const themeToken = (theme, name) => rulesFor(`body[data-theme="${theme}"]`)
  .join(';')
  .match(new RegExp(`${name}:\\s*([^;]+)`))?.[1]?.trim()

test('the five effect libraries are lazy, and each still has exactly one role', () => {
  // They are 426kB between them -- more than Yjs and ProseMirror View added
  // together -- and they render nothing until the Conclave panel is open with a
  // WebGL2 context. Importing them statically made every launch pay for that, so
  // they went behind `React.lazy` in `library/chat-effects.js`.
  //
  // The point of asserting it here rather than trusting the build output: a
  // stray `import { MetalFx } from 'metal-fx'` added while fixing something else
  // would quietly put 110kB back on the critical path, and nothing else in the
  // suite would notice.
  for (const pkg of ['border-beam', 'thinking-orbs', 'liquid-gooey', 'bot-avatars', 'metal-fx']) {
    assert.doesNotMatch(
      jsx,
      new RegExp(`from '${pkg}'`),
      `${pkg} must not be imported statically by main.jsx -- use library/chat-effects.js`,
    )
    assert.match(
      chatEffects,
      new RegExp(`import\\('${pkg}'\\)`),
      `${pkg} must be behind a dynamic import in chat-effects.js`,
    )
  }

  // Every one of those lazies is only useful behind an `EffectBoundary`, which
  // supplies the plain control as the Suspense fallback. A lazy component with
  // no boundary suspends the nearest one above it, which for the send button
  // would be the whole editor.
  assert.match(chatEffects, /\blazy\(/)
  for (const name of ['MetalFx', 'BotAvatar', 'ThinkingOrb', 'BorderBeam', 'Liquid', 'LiquidItem']) {
    assert.match(chatEffects, new RegExp(`export const ${name} = lazy\\(`), `${name} must be lazy`)
  }
  const boundary = readFileSync(join(root, 'src', 'ErrorBoundary.jsx'), 'utf8')
  assert.match(
    boundary,
    /<Suspense fallback=\{fallback\}>/,
    'EffectBoundary must be a Suspense boundary too, or the lazies have no fallback',
  )

  // One role each. Counting the JSX usages keeps a second, competing instance
  // of an effect from creeping into the panel.
  const uses = (component) => (jsx.match(new RegExp(`<${component}[\\s/>]`, 'g')) || []).length
  assert.equal(uses('ThinkingOrb'), 1, 'ThinkingOrb should appear once')
  assert.equal(uses('BorderBeam'), 1, 'BorderBeam should appear once')
  assert.equal(uses('MetalFx'), 1, 'MetalFx should appear once')
  assert.equal(uses('BotAvatar'), 1, 'BotAvatar should appear once')
  assert.equal(uses('Liquid'), 1, 'Liquid should wrap the suggestion chips once')
  // `Liquid.Item` is a static member of `Liquid`, so it cannot survive being a
  // lazy component -- `Liquid.Item` on one is `undefined`. It gets its own lazy
  // onto the same module, and the chips use that.
  assert.ok(uses('LiquidItem') >= 1, 'the chips must be LiquidItem children')
  assert.doesNotMatch(jsx, /<Liquid\.Item/, 'Liquid.Item is undefined on a lazy component')
})

test('canvas effects are told the theme explicitly', () => {
  // Both libraries default to theme="auto", which resolves from a
  // `data-theme="dark|light"` ancestor. Quill's dark theme is called "night",
  // so leaving it on "auto" renders the dark theme with the light palette.
  //
  // The mode comes from the resolved theme rather than from `settings.theme`,
  // because asking whether the theme is *named* "night" answers the wrong
  // question once a reader can call their own dark theme anything they like.
  assert.match(jsx, /const effectTheme = theme\?\.mode === 'dark' \? 'dark' : 'light'/)
  for (const component of ['ThinkingOrb', 'BotAvatar', 'BorderBeam', 'MetalFx']) {
    const usage = jsx.match(new RegExp(`<${component}[\\s\\S]*?/>`))
    assert.ok(usage, `${component} usage not found`)
    assert.match(usage[0], /theme=\{effectTheme\}/, `${component} must pass theme explicitly`)
  }
})

test('Reduce motion freezes the decorative effects, not just CSS transitions', () => {
  // The flag the effects read is the OS request alone. The in-app toggle is
  // deliberately not in it -- the assistant is the carve-out -- so it arrives as
  // `assistantReducedMotion` from main.jsx rather than as `reducedMotion`.
  assert.match(jsx, /const still = assistantReducedMotion \? \{ paused: true \} : \{\}/)
  // The orb and the avatar spread the shared flag.
  assert.match(jsx, /<ThinkingOrb[^>]*\{\.\.\.still\}/)
  assert.match(jsx, /<BotAvatar[^>]*\{\.\.\.still\}/)
  // MetalFx takes the flag directly. BorderBeam has no `paused` prop at all, so
  // the flag has to be folded into its only switch: `active={typing}` travelled
  // on while the reader had asked for stillness.
  assert.match(jsx, /<BorderBeam[^>]*active=\{typing && !assistantReducedMotion\}/)
  assert.match(jsx, /paused=\{assistantReducedMotion\}/)

  // The CSS half of the same carve-out. The blanket rule EXCLUDES the assistant
  // subtree rather than being overridden inside it: the four declarations it
  // carries are `!important`, so an opt-in inside the subtree would have to win
  // on specificity against a rule it cannot beat, and `revert` only reaches the
  // UA origin. Exclusion means there is no cascade to lose.
  assert.match(
    css,
    /body\.reduce-motion \*:not\(\.reduce-motion-exempt\):not\(\.reduce-motion-exempt \*\)/,
    'the blanket rule must exclude the exempt subtree instead of fighting it',
  )
  assert.match(
    jsx,
    /<aside className="assistant-panel reduce-motion-exempt"/,
    'the hook class belongs on the assistant root',
  )
  assert.equal(
    (jsx.match(/className="[^"]*\breduce-motion-exempt\b/g) || []).length,
    1,
    'only the assistant root may carry the exempt class',
  )
  // The OS-level block is a separate rule and has to keep covering everything:
  // an OS accessibility setting is not overruled surface by surface here.
  const osQuery = css.indexOf('@media (prefers-reduced-motion: reduce)')
  const osBlock = css.slice(osQuery, css.indexOf('}', osQuery))
  assert.match(osBlock, /animation-duration:\s*0\.01ms\s*!important/)
  assert.doesNotMatch(osBlock, /reduce-motion-exempt/, 'the OS block must keep covering everything')
  // And the rest of the app still follows the combined value -- the outline
  // scroll is the one JS motion outside the assistant, and it stays put.
  assert.match(jsx, /behavior: reducedMotion \? 'auto' : 'smooth'/)
})

test('the removed assistant header buttons stay removed', () => {
  assert.ok(!jsx.includes('assistant-icon-action'), 'the round icon buttons must not come back')
  assert.ok(!jsx.includes('FeedbackDialog'), 'the unreachable feedback dialog must stay deleted')
  assert.ok(!css.includes('assistant-icon-action'), 'their styles must stay deleted')
  assert.ok(!icons.includes('feedback:'), 'the now-unused feedback icon must stay deleted')
  // The Sections toggle still exists in the topbar, so nothing is lost.
  assert.match(jsx, /aria-label="Toggle Sections panel"/)
})

test('the library cover carries no text', () => {
  // A long title on a ~170px cover wrapped to five lines and `overflow: hidden`
  // sheared the last one. The reference design solves it by moving the title off
  // the cover entirely, so there is nothing left to clip.
  assert.ok(!jsx.includes('cover-copy'), 'the cover must not render a title')
  assert.ok(!css.includes('cover-copy'), 'cover-copy rules must be gone')
  // The cover stacks badge/title/edition in flow now (book.html), so its
  // padding is the reference's structural spacing, not a text inset.
  assert.match(
    valueOf('.document-cover', 'padding') || '',
    /\d+%/,
    'the cover keeps the reference flow padding',
  )

  // The title moved to the label under the cover, where it can use two lines.
  const clamp = valueOf('.tile-copy strong', '-webkit-line-clamp')
  assert.equal(clamp, '2', 'the label title may wrap to two lines')
  assert.equal(valueOf('.tile-copy strong', 'display'), '-webkit-box', 'the clamp needs a box display')

  // The "New document" tile reads the same way as the rest of the grid.
  assert.match(jsx, /<strong>New document<\/strong><span>Starts a blank draft<\/span>/)
})

test('list view has real styles', () => {
  // The original `.list-view` rules shrank the cover title to 9px inside a 64px
  // thumbnail, which was unreadable, and left the row unstyled otherwise.
  assert.ok(
    rulesFor('.list-view .document-tile').length > 0,
    'list rows must be laid out, not left as cover cards',
  )
  const grid = rulesFor('.list-view .document-tile')[0] ?? ''
  assert.match(grid, /grid-template-columns/, 'a list row is a grid, not a cover card')
  assert.ok(rulesFor('.list-view .tile-copy strong').length > 0, 'the label carries the title')
  assert.match(valueOf('.list-view .document-tile', 'padding') || '', /\d/, 'rows need vertical padding')
})

test('the dark theme is dark, with no light plates left behind', () => {
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const luminance = (hexColor) => {
    const clean = hexColor.replace('#', '')
    const [r, g, b] = [0, 2, 4].map((i) => srgb(parseInt(clean.slice(i, i + 2), 16)))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  const night = rulesFor('body[data-theme="night"]').join(';')
  const token = (name) => night.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
  // A token whose value is not a colour, e.g. --brand-filter.
  const rawToken = (name) => night.match(new RegExp(`${name}:\\s*([^;]+)`))?.[1]?.trim()

  // Every surface must be genuinely dark, not a lifted charcoal.
  for (const surface of ['--main', '--sidebar', '--chat', '--backdrop']) {
    const value = token(surface)
    assert.ok(value, `${surface} missing from the night theme`)
    const l = luminance(value)
    assert.ok(l < 0.012, `${surface} ${value} is not dark enough (L=${l.toFixed(4)})`)
  }

  // The greyscale brand assets are inverted for the dark theme instead of
  // sitting on a white plate, which was the last bright patch in the theme.
  // The inversion comes from --brand-filter, which the night block sets to
  // invert(1) and every light theme leaves as `none`.
  assert.equal(rawToken('--brand-filter'), 'invert(1)', 'the night theme must invert the brand assets')
  assert.equal(valueOf('.library-wordmark', 'filter'), 'var(--brand-filter)',
    'the wordmark must take its filter from the token, not a hardcoded invert(1)')
  assert.ok(!/night"\] \.library-wordmark \{[^}]*background:\s*#f/i.test(css), 'no white plate behind the wordmark')
  assert.match(rulesFor('[data-mode="dark"] .panel-mark').join(';'), /background:\s*transparent/,
    'the panel mark must drop its light plate in a dark mode')
})

test('darkness rules key on data-mode, not on the night theme id', () => {
  // A custom dark theme inherits none of a data-theme="night" rule, so it would
  // render a black wordmark on a black background and light scrollbars. Every
  // rule that is a property of darkness has to key on data-mode instead.
  // Only the token block itself may mention the night theme id. Every other
  // rule that needs darkness keys on data-mode instead.
  const nightSelectors = (css.match(/[^{}]*body\[data-theme="night"\][^{]*/g) || [])
    .map((raw) => raw.trim())
    .filter((selector) => selector !== 'body[data-theme="night"]')
  assert.deepEqual(nightSelectors, [],
    'no rule outside the token block may branch on the night theme id')

  // The attribute the app actually sets, and the value it sets.
  assert.match(jsx, /document\.body\.dataset\.mode\s*=/,
    'the app must write data-mode alongside data-theme')
  // The value is the resolved theme's mode rather than a comparison against the
  // id "night". For the three built-ins the two agree -- night is the only dark
  // one -- which is why this changed without anything visible moving, and why
  // the old expression was wrong: it lit the effects for every custom dark theme
  // in the app.
  assert.match(jsx, /document\.body\.dataset\.mode\s*=\s*theme\.mode/,
    'data-mode must be the resolved theme mode, not a test on the theme id')

  // A dark custom theme must get the same treatment, which is the point.
  // `.document-cover::before` used to be in this list: the cover carried a
  // per-document colour and needed a dark-mode overlay to keep white text on it
  // readable. The cover is a plain neutral card now, so the rule went with it.
  for (const selector of ['.panel-mark', '.editor-surface .ProseMirror code', '.editor-surface .ProseMirror pre', '.editor-surface .ProseMirror blockquote']) {
    const keyed = rulesFor(`[data-mode="dark"] ${selector}`)
    assert.ok(keyed.length > 0, `${selector} must have a data-mode="dark" rule`)
  }

  // The wordmark and the scrollbars go the other way: they take a token, so a
  // custom dark theme only has to set the token and gets the treatment without
  // needing its own rule here.
  assert.equal(valueOf('.library-wordmark', 'filter'), 'var(--brand-filter)')
  assert.equal(themeToken('night', '--brand-filter'), 'invert(1)')
  assert.match(rulesFor('[data-mode="dark"] ::-webkit-scrollbar-thumb').join(';'), /var\(--scrollbar-thumb\)/)
})

/**
 * Colours that are legitimately fixed in every theme, with the reason. Anything
 * not listed here and not inside a token block has to use a token, or a theme
 * swap silently misses it.
 */
const FIXED_COLORS = {
  '.document-cover': 'white monogram ink, and a contrast requirement of its own',
  '.cover-ribbon': 'a physical bookmark ribbon; fixed cloth in every theme, like the ink it sits beside',
  '.mode-card.is-dark': 'the dark-mode specimen card is a fixed picture of the dark theme, shown the same in every theme so the choice reads at a glance',
  '.tile-menu': 'sits over an arbitrary per-document cover colour, not a theme surface',
  '.avatar': 'identity colours, not theme colours',
  '.user-avatar': 'identity colours, not theme colours',
  '.presence': 'semantic status dots, fixed in every theme',
  ':root': 'the token declarations themselves',
  '@import': 'the font import',
  // The violet note panel is the reference artboard's managed-credits offer, not
  // a surface any theme recolours: it is one fixed promotional block shown the
  // same in every theme, so its tint, its tile and its button are literal. The
  // green panel beside it does take tokens, because that one is about the vault
  // this app owns.
  '#settings-assistant .keys-banner.is-violet': 'fixed promotional tint, identical in every theme',
  '#settings-assistant .keys-banner-action': 'the button inside that fixed tint',
  // The `#000` in `--accent-hover` is not a palette colour but the "mix toward
  // black" end of a color-mix, which is how the token darkens itself. The accent
  // it derives from is themed; the black it mixes with is arithmetic. It moved
  // here from `:root`, which this map exempts wholesale, into the `body` rule --
  // where it actually resolves against the right accent -- and that brought it
  // under the guard for the first time.
  body: 'derived tokens, whose one fixed component is the black in a self-darkening mix',
}
/** `.avatar.green` counts as `.avatar`: the coloured variants are the same idea. */
const isFixedColourSelector = (selector) => {
  const parts = selector.split(',').map((part) => part.trim())
  return parts.every((part) => Object.keys(FIXED_COLORS).some((allowed) => part === allowed || part.startsWith(`${allowed} `) || part.startsWith(`${allowed}.`) || part.startsWith(`${allowed}:`)))
}

test('every colour resolves to a token, or is a documented fixed colour', () => {
  // Raw colours outside :root and the three theme blocks are how a theme swap
  // misses: the rule renders identically in every theme because nothing in it
  // consults a token.
  const themeBlock = /^body\[data-theme="(light|paper|night)"\]\s*$/
  const isThemeBlock = (selector) => selector.split(',').every((part) => themeBlock.test(part.trim()))
  let blocks = 0
  for (const raw of css.split('}')) {
    const open = raw.indexOf('{')
    if (open < 0) continue
    const selector = raw.slice(0, open).trim()
    const body = raw.slice(open + 1)
    blocks += 1
    if (!selector || selector.startsWith('@') || isThemeBlock(selector)) continue
    // A declaration block defines tokens, so its hex values are the palette.
    if (/^\s*--[\w-]+\s*:/.test(body)) continue
    if (isFixedColourSelector(selector)) continue
    const offenders = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
      .filter((hit) => !/--[\w-]+:\s*$/.test(body.slice(0, hit.index)))
    assert.deepEqual(
      offenders.map((hit) => body.slice(Math.max(0, hit.index - 30), hit.index + 12).trim()),
      [],
      `hardcoded colour in "${selector}" -- use a token, or add it to FIXED_COLORS`,
    )
  }
  assert.ok(blocks > 100, `the stylesheet should have been fully scanned, saw ${blocks} blocks`)
})

test('every filled control takes its label colour from a token', () => {
  for (const selector of ['.soft-button.primary', '.send-button', '.publish-button', '.save-state.paused']) {
    const color = valueOf(selector, 'color')
    assert.ok(color?.startsWith('var('), `${selector} must use a token, got ${color}`)
  }
})

test('a decorative effect can never blank the window', () => {
  // The real WebKitGTK webview reported "WebGL2 not supported" and metal-fx
  // threw during render, which reached the top-level boundary and unmounted the
  // whole editor. Two independent guards now prevent that.
  const boundarySource = readFileSync(join(root, 'src', 'ErrorBoundary.jsx'), 'utf8')
  assert.match(boundarySource, /fallback/, 'EffectBoundary must expose a fallback')

  const capabilities = readFileSync(join(root, 'src', 'platform', 'capabilities.js'), 'utf8')
  assert.match(capabilities, /getContext\('webgl2'\)/, 'WebGL2 must be probed, not assumed')
  assert.match(jsx, /const canUseMetal = hasWebGL2\(\)/, 'metal-fx must be gated on the probe')

  // Every effect is either capability-gated or wrapped in a local boundary.
  for (const component of ['ThinkingOrb', 'BotAvatar', 'BorderBeam', 'MetalFx', 'Liquid']) {
    const wrapped = new RegExp(`<EffectBoundary[^>]*>[\\s\\S]{0,400}?<${component}[\\s/>]`).test(jsx)
    const gated = new RegExp(`canUseMetal[^\\n]*\\?[\\s\\S]{0,200}?<${component}[\\s/>]`).test(jsx)
    assert.ok(wrapped || gated, `${component} must be wrapped in an EffectBoundary or capability-gated`)
  }
})

test('the assistant head controls keep their shared layout rule', () => {
  // `.model-trigger`, `.assistant-head-action` and the removed
  // `.assistant-icon-action` once shared a single declaration line. Deleting
  // that line to drop the icon actions also stripped the layout and transparent
  // background from the two survivors, and their labels began wrapping onto two
  // lines with default grey button styling. The rule now stands on its own.
  const actions = rulesFor('.assistant-head-action').join(';')
  assert.match(actions, /inline-flex/, 'the head controls must stay inline-flex')
  assert.match(actions, /white-space:\s*nowrap/, 'head labels must never wrap')
  assert.match(actions, /background:\s*transparent/, 'head controls must not fall back to the UA button background')
  assert.match(actions, /flex:\s*none/, 'actions must not be squeezed by the row')

  // The picker hugs its content: a short id reads as a snug pill rather than a
  // half-empty bar, and the trigger inside never wraps -- a second line would
  // shove the head's buttons around.
  const picker = rulesFor('.model-picker').join(';')
  assert.match(picker, /width:\s*max-content/, 'the picker fits its own text instead of stretching')
  const trigger = rulesFor('.model-trigger').join(';')
  assert.match(trigger, /white-space:\s*nowrap/, 'a model name must never wrap onto a second line')
  assert.match(trigger, /text-overflow:\s*ellipsis/, 'a long model name must ellipsize in the control')
  assert.match(trigger, /flex:\s*none/, 'the trigger must not be squeezed by the row')
  assert.match(jsx, /className="model-trigger"/, 'the head renders the listbox trigger')
  assert.match(jsx, /role="listbox"/, 'and the listbox it opens')
})

test('the panel uses one horizontal inset for messages and composer', () => {
  // `.chat-scroll` had 18px of side padding and `.chat-footer` had 14px, so the
  // composer, the suggestion chips and the message list never lined up.
  const inset = valueOf('.assistant-panel', '--chat-inset')
  assert.ok(inset, 'the inset must be defined once on the panel')
  assert.equal(inset, '18px')

  for (const selector of ['.chat-scroll', '.chat-footer']) {
    const padding = valueOf(selector, 'padding')
    assert.ok(
      padding.includes('var(--chat-inset)'),
      `${selector} must use the shared inset, got "${padding}"`,
    )
  }
  // The earlier hardcoded values must be gone, or a later rule would win.
  assert.ok(!/padding:\s*28px\s+18px/.test(css), 'no hardcoded 18px scroll padding')
  assert.ok(!/padding:\s*12px\s+14px/.test(css), 'no hardcoded 14px footer padding')
})

test('the pending row does not inherit the avatar column', () => {
  // Assistant messages are a two-column grid so the body clears the avatar. The
  // pending row renders no avatar, but it still sat in the second column and
  // picked up a phantom 26px + 9px indent, which is what put "Thinking" out of
  // line with the composer.
  assert.match(jsx, /className="chat-message ai is-pending"/, 'the pending row must be marked')
  assert.match(
    valueOf('.chat-message.is-pending .message-content', 'grid-template-columns') || '',
    /minmax\(0, 1fr\)/,
    'the pending row must collapse to a single column',
  )
  assert.equal(
    valueOf('.chat-message.is-pending .message-status', 'grid-column'),
    '1',
    'the pending status must start at the first column',
  )
})

test('the orb is sized through the size prop, not by scaling a small canvas', () => {
  // thinking-orbs sizes the canvas backing store from `size`. CSS-scaling the
  // 20px preset up blurs it, so a larger orb has to use the 64 preset shown
  // smaller. The old rule also pinned the canvas to 20px with !important, which
  // would have overridden any inline size.
  assert.match(jsx, /<ThinkingOrb[\s\S]{0,400}?size=\{64\}/, 'the orb must use the 64 preset')
  assert.match(jsx, /<ThinkingOrb[\s\S]{0,600}?style=\{\{ width: 2\d, height: 2\d \}\}/,
    'the 64 preset must be shown at a smaller CSS box')
  assert.ok(!/width:\s*20px\s*!important/.test(css), 'the canvas must not be clamped with !important')
  assert.ok(!/height:\s*20px\s*!important/.test(css), 'the canvas must not be clamped with !important')

  // Adjacent text already announces the state, so the canvas is decorative.
  assert.match(jsx, /<ThinkingOrb[\s\S]{0,400}?aria-hidden="true"/)
  // The state derives from the newest step -- "Sleuthing: …" → searching,
  // "Writing a section" → composing -- so the orb matches the shimmering label
  // text, and `orbStateFor` falls back to the documented idle state
  // ("breathing") while there is no step yet.
  assert.match(jsx, /state=\{orbStateFor\(turnSteps\)\}/, 'the orb mirrors the current step')
  assert.match(jsx, /if \(!last\) return 'breathing'/, 'and idles on breathing without a step')
})

test('the metal-fx gate reports a usable reason', () => {
  const capabilities = readFileSync(join(root, 'src', 'platform', 'capabilities.js'), 'utf8')
  // Distinguishing "no GL at all" from "GL1 but not GL2" is the difference
  // between a missing driver and something the dev wrapper can fix.
  assert.match(capabilities, /getContext\('webgl'\)/, 'WebGL1 should be probed for diagnostics')
  assert.match(capabilities, /console\.warn/, 'an unsupported result must be explained')

  // The dev wrapper is where the WebKitGTK GPU process gets coaxed into
  // handing over a context.
  const wrapper = readFileSync(join(root, 'scripts', 'tauri.sh'), 'utf8')
  assert.match(wrapper, /LIBGL_ALWAYS_SOFTWARE/, 'software GL must be the default in dev')
  assert.match(wrapper, /WEBKIT_DISABLE_DMABUF_RENDERER/, 'the DMA-BUF path must be avoided in dev')
  // The defaults use :- so an explicit export from the caller still wins.
  assert.match(wrapper, /:-1/, 'the GL defaults must be overridable')
})
