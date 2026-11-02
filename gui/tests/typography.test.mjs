/**
 * Typography regression guard.
 *
 * Two bugs motivated this file:
 *
 *  1. `.editor-surface .ProseMirror p { margin: 0 }` sat at a higher
 *     specificity than `.document-prose p { margin: 0 0 18px }`, so the
 *     intended paragraph spacing never applied. The prose rules must now live
 *     in exactly one place.
 *  2. ProseMirror ships `white-space: pre-wrap`, which is never reset by the
 *     library and visibly distorts line height in the editable region.
 *
 * These read the stylesheet as text rather than rendering, because the failure
 * mode is a cascade conflict — a rendered screenshot would not explain it.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { resolveTheme, missingTokens } from '../src/library/themes.js'
import { slugify } from '../src/platform/store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'src', 'styles.css'), 'utf8')

// Comments carry semicolons and braces, so they must go before any rule is
// parsed. The prose rules document *why* they are shaped this way, and reading
// that reasoning is the point of the reset this file checks for.
const css = source.replace(/\/\*[\s\S]*?\*\//g, '')

/** The built-in ids, from the module the applier resolves against. */
const BUILT_IN_THEMES = ['light', 'paper', 'night']

/**
 * The curated presets, read out of the migration.
 *
 * The stylesheet and the migration have to agree about which ids are built-in
 * and which are rows, and the only place that agreement can be checked is with
 * both in the same test. Parsed rather than counted, so a preset that stopped
 * being parseable is a failure here instead of an empty list that passes.
 */
const presetsFromMigration = () => {
  const migration = readFileSync(join(root, 'src-tauri', 'migrations', '0004_curated_themes.sql'), 'utf8')
  const body = migration.slice(migration.indexOf('INSERT INTO custom_themes'))
  const rows = []
  const pattern = /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'(light|dark)'\s*\)/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    rows.push({ theme_id: match[1], name: match[2], tokens: JSON.parse(match[3]), mode: match[4] })
  }
  return rows
}

/** Matches a rule set for `selector`, ignoring whitespace and comments. */
const rulesFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = []
  const re = new RegExp(`(^|[,}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g')
  let match
  while ((match = re.exec(css)) !== null) out.push(match[2])
  return out
}

const declarations = (selector) =>
  rulesFor(selector)
    .join(' ')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf(':')
      return { prop: part.slice(0, index).trim(), value: part.slice(index + 1).trim() }
    })

const valueOf = (selector, prop) => {
  const found = declarations(selector).find((d) => d.prop === prop)
  return found ? found.value : undefined
}

test('document prose owns its own spacing, with no competing rule', () => {
  // The reset is the only margin rule; vertical rhythm comes from one scale.
  assert.equal(valueOf('.document-prose p', 'margin'), '0', 'paragraph margin must reset')
  assert.ok(
    valueOf('.document-prose > * + *', 'margin-top')?.includes('--prose-gap'),
    'inter-block spacing must use the --prose-gap scale',
  )

  // Any other selector targeting `p` inside the editor is a conflict risk.
  const conflicting = [...css.matchAll(/(\.ProseMirror\s+p|\.editor-surface[^{]*\bp\b[^{]*)\s*\{([^}]*)\}/g)]
    .filter(([, , body]) => /margin/.test(body))
    .map(([, selector]) => selector.trim())
  assert.deepEqual(
    conflicting.filter((sel) => !sel.includes('is-editor-empty')),
    [],
    'no selector may set margins on editor paragraphs outside .document-prose',
  )
})

test('ProseMirror editable region resets its inherited whitespace handling', () => {
  assert.equal(
    valueOf('.editor-surface .ProseMirror', 'white-space'),
    'normal',
    'pre-wrap must be reset or line height renders wrong',
  )
  assert.equal(
    valueOf('.editor-surface .ProseMirror', 'outline'),
    'none',
    'the editable element must not draw its own focus ring',
  )
  // Focus is still shown, on the wrapper, for keyboard users.
  assert.ok(css.includes(':focus-visible'), 'a focus-visible style must exist')
})

test('body text size and leading are defined once and stay in a readable range', () => {
  const size = valueOf('.editor-page', '--prose-size')
  const leading = valueOf('.editor-page', '--prose-leading')
  assert.ok(size, '--prose-size must be declared on .editor-page')
  assert.ok(leading, '--prose-leading must be declared on .editor-page')

  const px = Number.parseFloat(size)
  const ratio = Number.parseFloat(leading)
  assert.ok(px >= 16 && px <= 18, `body size ${px}px should be 16-18px`)
  assert.ok(ratio >= 1.5 && ratio <= 1.8, `leading ${ratio} should be 1.5-1.8`)

  // A comfortable long-form measure. The band was 58-78 characters at a 700px
  // page; the page is now an A4 sheet (`min(210mm, 100%)`, ~794px at the CSS
  // 96dpi reference) because the writing surface should be the page the
  // document prints on. The guard is unchanged in kind -- one declared width,
  // gutters subtracted, and a line that stays readable in both directions --
  // so it reads px or mm rather than the assertion going away.
  const width = valueOf('.editor-page', 'width')
  const match = width?.match(/min\((\d+(?:\.\d+)?)(px|mm)/)
  assert.ok(match, `expected a px or mm max width, got ${width}`)
  const toPx = (n, unit) => (unit === 'mm' ? (n * 96) / 25.4 : n)
  const widthPx = toPx(Number(match[1]), match[2])
  const padding = valueOf('.editor-page', 'padding') ?? ''
  const gutter = padding.split(' ')[1]?.match(/^([\d.]+)(mm|px)?$/)
  const horizontal = gutter ? toPx(Number(gutter[1]), gutter[2] || 'px') : 0
  const column = widthPx - horizontal * 2
  // Inter averages ~0.5em per character at these sizes.
  const chars = column / (px * 0.5)
  assert.ok(
    chars >= 58 && chars <= 92,
    `line holds ~${chars.toFixed(0)} characters; want 58-92`,
  )
})

test('every theme declares colour-scheme and the surfaces it paints', () => {
  for (const theme of ['light', 'paper', 'night']) {
    const rules = rulesFor(`body[data-theme="${theme}"]`)
    assert.ok(rules.length > 0, `${theme} theme must exist`)
    const body = rules.join(';')
    assert.match(body, /color-scheme:/, `${theme} must set color-scheme for native widgets`)
    for (const token of ['--main', '--sidebar', '--text-1', '--text-2', '--prose', '--border']) {
      assert.ok(body.includes(token), `${theme} must define ${token}`)
    }
  }
})

test('every built-in id has a stylesheet block, and nothing else claims to', () => {
  // The applier splits on exactly this line. A built-in is painted by its
  // `body[data-theme]` block, and a custom theme -- which matches no block -- is
  // painted by an inline token set. If a fourth block appeared for a theme that
  // the app treats as custom, the two would fight: the inline set wins on
  // <html> and the block wins on <body>, so the shell and the page would render
  // from different palettes.
  const blocks = [...css.matchAll(/body\[data-theme="([^"]+)"\]/g)].map((match) => match[1])
  const unique = [...new Set(blocks)]
  assert.deepEqual(unique.sort(), [...BUILT_IN_THEMES].sort(), `stylesheet blocks: ${unique.join(', ')}`)

  // And the seeded presets must not shadow a block, which is the same fight
  // arrived at by another route.
  const presets = presetsFromMigration()
  for (const preset of presets) {
    assert.ok(!unique.includes(preset.theme_id), `the ${preset.theme_id} preset would match a stylesheet block`)
    assert.equal(preset.theme_id, slugify(preset.name), `${preset.theme_id} is not the slug of its name`)
  }

  // A custom theme's own tokens have to be a superset of what the block would
  // have provided for the tokens the contrast pairs measure, or the inline
  // applier would render a surface the block was providing.
  for (const preset of presets) {
    const resolved = resolveTheme(preset.theme_id, [preset])
    assert.deepEqual(missingTokens(resolved.tokens), [], `${preset.theme_id} is incomplete once merged`)
  }
})

test('no control hardcodes a foreground that its theme background breaks', () => {
  // Filled controls must take their label colour from a token, because the
  // night theme lightens those backgrounds.
  for (const selector of ['.soft-button.primary', '.send-button', '.publish-button']) {
    const color = valueOf(selector, 'color')
    assert.ok(color?.startsWith('var('), `${selector} must use a token for color, got ${color}`)
  }
  assert.ok(valueOf(':root', '--on-accent'), '--on-accent must exist')
  assert.ok(valueOf(':root', '--on-publish'), '--on-publish must exist')
})

test('the fake window traffic lights are gone', () => {
  assert.ok(!css.includes('traffic-dots'), 'traffic-dots styling must be removed')
})
