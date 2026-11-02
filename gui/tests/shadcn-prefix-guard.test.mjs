/**
 * The `tw:` prefix guard for `src/library/ui/`.
 *
 * `src/tailwind.css` runs Tailwind v4 with `prefix(tw)`, and the prefix is a
 * colon. So `tw:flex` generates CSS and `tw-flex` does not -- not because it is
 * wrong, but because `printCandidate` emits `${prefix}:` and the candidate
 * parser rejects any candidate whose first segment is not `tw`. A dash-prefixed
 * class is an unknown utility, and an unknown utility generates nothing.
 *
 * That is the worst possible failure mode: no error, no warning, a component
 * that renders as unstyled text. Every other kind of mistake in this codebase
 * announces itself. This one does not, which is why it gets a test.
 *
 * There are three ways to get it wrong and all three are plausible:
 *
 *   1. Unprefixed   -- `className="flex"`. The copy-paste default, and the
 *      reason docs and shadcn's own examples are a hazard here.
 *   2. Dash         -- `className="tw-flex"`. This is the *v3* form. It looks
 *      right to anyone who has used shadcn on Tailwind 3.
 *   3. Double       -- `className="tw::flex"`. What you get from setting
 *      `tailwind.prefix: "tw:"` in `components.json`, because the CLI's
 *      `applyPrefix` appends the colon itself for v4 and the value must be the
 *      bare `"tw"`.
 *
 * The other half of the argument is that the prefix is *load-bearing*, so
 * "just drop the prefix" is not an available fix. Quill's own class names
 * collide with Tailwind utility names -- `outline`, `border`, `shadow`,
 * `container`, `ring`, `table`, `hidden` -- and unprefixed Tailwind shipped a
 * visible bug because of it (`<nav className="outline">` grew a 1px white
 * box). `KNOWN_COLLISIONS` in `tailwind-bridge.test.mjs` re-derives that set
 * from a real build. This test guards the other end: that the prefix is applied.
 *
 * The detector is checked against fixtures first. A guard that cannot fail is
 * worse than no guard, so `the detector rejects all three failure modes` is an
 * assertion here, not an assumption -- and the same predicates run against the
 * real directory afterwards.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const uiDir = join(root, 'src', 'library', 'ui')

/**
 * Class names that are shadcn's own rather than Tailwind's.
 *
 * Deliberately tiny. Anything in here is a name this project chose, so adding
 * to it is a decision; a name that *looks* custom but is really a utility gets
 * caught, which is the direction to err in.
 */
const CUSTOM = new Set([
  'scrollbar-thumb',
  'skeleton',
  'icon',
  'peer',
  'group',
])

/**
 * Utility roots, matched against the first segment of each variant part.
 *
 * A class is treated as a Tailwind utility if any of its segments starts with
 * one of these, followed by a `-`, a digit, or nothing at all. So `flex`,
 * `p-4`, `text-sm`, `bg-red-500` and `border-t` all match, while `flexibility`
 * and `container-ish` do not.
 *
 * This is a heuristic and it is allowed to be imperfect: a false positive
 * demands a prefix that should have been there, and a false negative is the
 * unstyled-component failure this test exists to prevent. The fixtures below
 * pin the behaviour that matters.
 */
const UTILITY_ROOTS = [
  // layout and display
  'flex', 'grid', 'table', 'block', 'inline', 'contents', 'hidden', 'flow-root',
  'static', 'fixed', 'absolute', 'relative', 'sticky', 'isolate',
  // positioning
  'inset', 'inset-x', 'inset-y', 'top', 'right', 'bottom', 'left', 'start', 'end',
  'z',
  // sizing
  'w', 'h', 'size', 'min-w', 'min-h', 'max-w', 'max-h', 'aspect',
  // spacing
  'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe',
  'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me',
  'gap', 'space', 'scroll-m', 'scroll-p',
  // flex and grid
  'grow', 'shrink', 'basis', 'order', 'items', 'justify', 'self', 'content',
  'grid-cols', 'grid-rows', 'col', 'row', 'auto-cols', 'auto-rows',
  // typography
  'font', 'leading', 'tracking', 'whitespace', 'break', 'truncate', 'indent',
  'underline', 'line-through', 'overline', 'uppercase', 'lowercase',
  'capitalize', 'italic', 'tabular', 'antialiased', 'subpixel', 'sr-only',
  'not-sr-only', 'placeholder', 'decoration',
  // colour
  'bg', 'text', 'border', 'fill', 'stroke', 'from', 'via', 'to',
  'outline', 'ring', 'shadow', 'accent', 'caret', 'divide', 'fill-opacity',
  // effects
  'opacity', 'mix-blend', 'bg-blend', 'blur', 'backdrop', 'filter',
  'transition', 'duration', 'ease', 'delay', 'animate',
  'scale', 'rotate', 'translate', 'skew', 'transform', 'origin',
  // interaction and overflow
  'overflow', 'overscroll', 'cursor', 'pointer-events', 'resize', 'appearance',
  'select', 'touch', 'scroll-smooth', 'will-change', 'user-select',
  // misc shapes shadcn leans on
  'rounded', 'border-collapse', 'table-layout', 'list', 'object',
  'float', 'clear', 'align', 'container', 'columns', 'object-fit',
]

const ROOTS = new Set(UTILITY_ROOTS)

/**
 * Whether one variant part is Tailwind-shaped.
 *
 * `part` is whatever sat between colons, with any `[...]` arbitrary value left
 * intact, so `data-[state=open]:bg-x` arrives as the two parts
 * `data-[state=open]` and `bg-x`.
 */
function isUtilityPart(part) {
  if (!part) return false
  const head = part.split(/[-[]/)[0]
  if (CUSTOM.has(head)) return false
  if (!ROOTS.has(head)) return false
  // `flex` and `p-4` are utilities; `flexibility` is not. A root that is the
  // whole segment, or is followed by a separator, is the utility shape.
  return head === part || /[-[]/.test(part.slice(head.length))
}

/**
 * Classifies one class token.
 *
 * `ok`      -- correctly prefixed, or not a Tailwind utility, or a known custom
 * `dash`    -- `tw-flex`, the v3 form, which generates nothing under v4
 * `double`  -- `tw::flex`, from a `tailwind.prefix` of `"tw:"`
 * `bare`    -- a Tailwind utility with no prefix at all
 */
function classify(token) {
  if (!token) return 'ok'

  // Split on colons that are not inside an arbitrary value, so `supports-[display:grid]`
  // stays in one piece instead of splitting mid-selector.
  const raw = token.split(/(?![^\[]*\]):/)

  // `tw::flex` splits to ['tw', '', 'flex']. Check for the empty segment before
  // discarding empties, because that empty segment is the whole signal.
  if (raw[0] === 'tw' && raw.length > 1 && raw[1] === '') return 'double'

  const parts = raw.filter(Boolean)
  if (parts.length === 0) return 'ok'

  if (parts[0] === 'tw') {
    // Tailwind v4 puts the prefix once, at the front: `tw:focus:ring-2`. A
    // second `tw:` mid-chain is a different malformation from either failure
    // mode above -- the chain parses, but the segment after the variant is the
    // literal string `tw`, which matches no utility, so the whole rule silently
    // generates nothing. It is also the easiest one to write by hand, because
    // shadcn's source reads `focus:ring-2` and the prefix looks like it belongs
    // on every segment.
    if (parts.slice(1).includes('tw')) return 'repeated'
    return 'ok'
  }

  // `tw-flex` never splits on a colon, so the whole token is the first segment.
  if (parts[0].startsWith('tw-')) return 'dash'

  return parts.some(isUtilityPart) ? 'bare' : 'ok'
}

/** Every class token in the file's `className` values and `cn(...)` arguments. */
function classTokens(source) {
  const tokens = []
  const push = (raw) => {
    for (const token of raw.split(/\s+/)) {
      if (token) tokens.push(token)
    }
  }

  // className="..." and className={'...'} and cn('a', 'b') and cn(base, x)
  const stringAttrs = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*[`'"]([^`'"]*)[`'"]\s*\})/g
  for (const match of source.matchAll(stringAttrs)) {
    push(match[1] ?? match[2] ?? match[3] ?? '')
  }

  const cnCalls = /\bcn\(\s*([^)]*)\)/g
  for (const match of source.matchAll(cnCalls)) {
    for (const quoted of match[1].matchAll(/[`'"]([^`'"]*)[`'"]/g)) {
      push(quoted[1])
    }
  }

  return tokens
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(jsx|tsx|js|ts)$/.test(entry.name))
    .map((entry) => join(dir, entry.name))
}

test('the detector rejects all three ways a prefixed class goes wrong', () => {
  // Unprefixed: the copy-paste default.
  assert.equal(classify('flex'), 'bare')
  assert.equal(classify('bg-red-500'), 'bare')
  assert.equal(classify('p-4'), 'bare')
  // Variant with no prefix.
  assert.equal(classify('hover:underline'), 'bare')
  assert.equal(classify('dark:bg-black'), 'bare')
  // Dash: the Tailwind v3 form.
  assert.equal(classify('tw-flex'), 'dash')
  assert.equal(classify('tw-hover:underline'), 'dash')
  // Double: `tailwind.prefix` set to "tw:".
  assert.equal(classify('tw::flex'), 'double')
  assert.equal(classify('tw::hover:bg-x'), 'double')
  // Repeated: the prefix belongs once, at the front. Writing it on every
  // segment is the natural mistake and produces nothing at all.
  assert.equal(classify('tw:focus:tw:ring-2'), 'repeated')
  assert.equal(classify('tw:hover:tw:bg-accent'), 'repeated')
  assert.equal(classify('tw:data-[side=left]:tw:-translate-x-1'), 'repeated')
})

test('the detector accepts correctly prefixed classes', () => {
  assert.equal(classify('tw:flex'), 'ok')
  assert.equal(classify('tw:bg-red-500'), 'ok')
  // Variants stack *after* the prefix, never before it -- and the prefix
  // appears exactly once, at the front.
  assert.equal(classify('tw:hover:underline'), 'ok')
  assert.equal(classify('tw:focus-visible:ring-2'), 'ok')
  assert.equal(classify('tw:dark:bg-black'), 'ok')
  // Radix state attributes -- the pattern shadcn is built on.
  assert.equal(classify('tw:data-[state=open]:bg-accent'), 'ok')
  assert.equal(classify('tw:data-[side=left]:-translate-x-1'), 'ok')
  // Arbitrary values, including ones containing a colon.
  assert.equal(classify('tw:w-[calc(100%-1rem)]'), 'ok')
  assert.equal(classify('tw:supports-[display:grid]:grid'), 'ok')
  // Non-utilities are not this test's business.
  assert.equal(classify('document-tile'), 'ok')
  assert.equal(classify('settings-nav'), 'ok')
  assert.equal(classify('scrollbar-thumb'), 'ok')
  assert.equal(classify(''), 'ok')
})

test('every Tailwind class in src/library/ui/ is tw:-prefixed', () => {
  const files = sourceFiles(uiDir)
  const offences = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const token of classTokens(source)) {
      const verdict = classify(token)
      if (verdict !== 'ok') {
        offences.push({ file: file.slice(root.length + 1), token, verdict })
      }
    }
  }

  assert.deepEqual(
    offences,
    [],
    [
      offences.length
        ? `${offences.length} Tailwind class(es) in src/library/ui/ would generate no CSS:`
        : 'prefix guard found no problems',
      ...offences.map((o) => `  ${o.file}: "${o.token}" (${o.verdict})`),
      '',
      'Quill runs Tailwind v4 with prefix(tw), so utilities are `tw:flex`, not',
      '`flex` and not `tw-flex`. See src/library/ui/README.md.',
    ].join('\n'),
  )
})

test('the prefix guard would notice a component installed without the prefix', () => {
  // Shaped like a component the CLI installed without the prefix: every
  // utility bare, passed as quoted `cn()` arguments the way shadcn writes them.
  const misInstalled = `className={cn("inline-flex items-center justify-center", "rounded-md px-3 text-sm")}`
  const flagged = classTokens(misInstalled)
    .filter((token) => classify(token) !== 'ok')
    .sort()

  assert.deepEqual(
    flagged,
    ['inline-flex', 'items-center', 'justify-center', 'px-3', 'rounded-md', 'text-sm'],
    'every utility in a mis-installed component should be flagged, and nothing else',
  )
  assert.ok(
    flagged.every((token) => classify(token) === 'bare'),
    'every offence in an unprefixed component should classify as bare',
  )
})

test('components.json carries the bare v4 prefix', () => {
  const config = JSON.parse(readFileSync(join(root, 'components.json'), 'utf8'))
  const prefix = config?.tailwind?.prefix

  assert.equal(
    prefix,
    'tw',
    [
      `components.json has tailwind.prefix: ${JSON.stringify(prefix)}, expected "tw".`,
      'The shadcn CLI appends the separator itself -- for Tailwind v4',
      '`applyPrefix` emits `${prefix}:${className}`, so the value must be bare.',
      'A trailing colon produces `tw::flex`, and a trailing dash is the v3 form.',
      'Both generate nothing.',
    ].join('\n'),
  )
})