/**
 * The Tailwind foundation: the shadcn variable bridge, and the three ways this
 * setup can quietly produce an app that looks fine in one theme and wrong in
 * another.
 *
 * `src/tailwind.css` translates Quill's palette into the fixed variable names
 * shadcn components read. It is pure CSS with no JavaScript behind it, which is
 * the point -- a second copy of the palette in JS would drift from
 * `styles.css` the way `SUITES` in `scripts/check-contrast.mjs` already did once.
 *
 * So the correctness argument lives entirely in *where* those declarations are
 * and *what* they reference, and both are invisible to a screenshot of a single
 * theme. The three ways it breaks:
 *
 *  1. A role variable declared on `:root` instead of `body`. `:root` substitutes
 *     `var()` against html's tokens, but a built-in theme redefines them on
 *     `body[data-theme="night"]`. `:root`'s `--background` would keep resolving
 *     to the light base, and only in built-in themes -- custom themes, written
 *     onto html, would be fine. Inverse of the usual bug, and easy to ship.
 *
 *  2. A role variable referencing a token no theme defines. It renders as
 *     nothing at all, so the surface silently loses its background rather than
 *     erroring.
 *
 *  3. `--accent` aliased to the hover fill. In Quill `--accent` is the action
 *     colour, read by every button and link in the app; redefining it on body
 *     repaints all of them. This is the collision the bridge exists to avoid,
 *     so it gets its own guard rather than a comment.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tailwindCss = readFileSync(join(root, 'src', 'tailwind.css'), 'utf8')
const stylesCss = readFileSync(join(root, 'src', 'styles.css'), 'utf8')

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of one block, as a name -> value map. */
function declarations(block) {
  const out = new Map()
  for (const part of block.split(';')) {
    const match = part.match(/^\s*(--[\w-]+)\s*:\s*([^;]+)$/)
    if (match) out.set(match[1], match[2].trim())
  }
  return out
}

/**
 * The bridge, as `--role -> referenced token`.
 *
 * Only `body` counts. A declaration anywhere else is a different rule with
 * different substitution behaviour, which is failure mode 1 above -- so this
 * returns nothing rather than quietly searching the whole file for something
 * that looks plausible.
 */
function bridgeDeclarations() {
  const body = strip(tailwindCss).match(/(?:^|\})\s*body\s*\{([^}]*)\}/)
  assert.ok(body, 'no `body { … }` block in src/tailwind.css')

  // Keyed without the leading `--`, so a role is addressed as `background` here
  // and matches how shadcn's own components name it.
  const out = new Map()
  for (const [name, value] of declarations(body[1])) {
    const reference = value.match(/^var\((--[\w-]+)\)$/)
    if (reference) out.set(name.slice(2), reference[1])
  }
  return out
}

/** Each theme's effective tokens: `:root` with its own block merged over. */
function effectiveTokens() {
  const stylesheet = strip(stylesCss)
  const base = declarations((stylesheet.match(/:root\s*\{([^}]*)\}/) || [, ''])[1])
  const themes = new Map([['(base)', base]])

  const pattern = /body\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g
  let match
  while ((match = pattern.exec(stylesheet)) !== null) {
    themes.set(match[1], new Map([...base, ...declarations(match[2])]))
  }
  return themes
}

/**
 * A custom theme, as `main.jsx` paints one: `resolveTheme`'s merged token set
 * written inline onto `<html>`.
 *
 * Read from the theme module rather than hand-written, so a token dropped from
 * the built-ins shows up here instead of passing.
 */
function customThemeTokens(mode) {
  const themes = readFileSync(join(root, 'src', 'library', 'themes.js'), 'utf8')
  const baseId = mode === 'dark' ? 'night' : 'light'
  const block = themes.match(new RegExp(`\\b${baseId}:\\s*\\{([\\s\\S]*?)\\n  \\},`))
  assert.ok(block, `no "${baseId}" built-in block in themes.js`)

  const tokens = new Map()
  for (const part of block[1].split('\n')) {
    const match = part.match(/^\s*'(--[\w-]+)':\s*'([^']*)',?\s*$/)
    if (match) tokens.set(match[1], match[2])
  }
  assert.ok(tokens.size > 0, 'parsed no tokens out of the built-in theme')
  return tokens
}

/**
 * The roles shadcn components read. The list is what `components.json` and the
 * `@theme inline` block in `tailwind.css` are both derived from; a role missing
 * here means a component referencing it renders with an unset background.
 */
const ROLES = [
  'background', 'foreground',
  'card', 'card-foreground',
  'popover', 'popover-foreground',
  'primary', 'primary-foreground',
  'secondary', 'secondary-foreground',
  'muted', 'muted-foreground',
  'accent', 'accent-foreground',
  'destructive',
  'input', 'ring',
]

test('every shadcn role resolves to a token each theme actually defines', () => {
  const bridge = bridgeDeclarations()
  const missingRoles = ROLES.filter((role) => !bridge.has(role))
  assert.deepEqual(missingRoles, [], `roles with no mapping: ${missingRoles.join(', ')}`)

  for (const [theme, tokens] of effectiveTokens()) {
    for (const role of ROLES) {
      const referenced = bridge.get(role)
      assert.ok(
        tokens.has(referenced),
        `theme ${theme}: --${role} reads --${referenced}, which it does not define`,
      )
    }
  }
})

test('the bridge resolves for a custom dark theme, not just the built-ins', () => {
  // The other failure mode: `styles.css` has no `body[data-theme="sepia"]` block,
  // so a theme-aware test that only walks the built-in blocks cannot see this
  // case at all. A custom theme is painted by inline tokens on `<html>`, which
  // body inherits -- so the substitution has to work with a token set that
  // appears in no stylesheet rule.
  const bridge = bridgeDeclarations()
  const tokens = customThemeTokens('dark')

  for (const role of ROLES) {
    const referenced = bridge.get(role)
    assert.ok(
      tokens.has(referenced),
      `custom dark theme: --${role} reads --${referenced}, which resolveTheme does not supply`,
    )
  }
})

test('the bridge is declared on body, where every theme path reaches it', () => {
  const css = strip(tailwindCss)

  // Declaring it on `:root` would substitute against html's tokens, and a
  // built-in theme only redefines those on body.
  assert.equal(
    css.match(/:root\s*\{[^}]*--(background|primary|ring|muted)\s*:/g),
    null,
    'a role variable is declared on :root; it must be on body',
  )

  // ...and on html itself, for the same reason: `main.jsx` writes custom tokens
  // there, but a rule on html would shadow body's copy for the whole tree.
  assert.equal(
    css.match(/html\s*\{[^}]*--(background|primary|ring|muted)\s*:/g),
    null,
    'a role variable is declared on html; it must be on body',
  )
})

test("Quill's own --accent is not redefined", () => {
  // shadcn's `--accent` is a muted hover fill. Quill's is the action colour
  // that every button, link and focus ring reads, so the two cannot share a
  // name. The bridge gives shadcn's `--primary` Quill's `--accent` and points
  // shadcn's `--accent` at `--accent-soft` instead.
  const bridge = bridgeDeclarations()

  assert.notEqual(bridge.get('accent'), '--accent')
  assert.equal(bridge.get('primary'), '--accent')
  assert.equal(bridge.get('accent-foreground'), '--accent')

  // A literal would also be a bug, for the reason above: it would freeze one
  // theme's colour into a file that themes every other token.
  for (const role of ROLES) {
    assert.match(
      bridge.get(role),
      /^--[\w-]+$/,
      `--${role} is not a var() reference; a literal would not follow the theme`,
    )
  }
})

test('no role variable is aliased to itself', () => {
  // A self-reference is a dependency cycle, which CSS resolves to
  // guaranteed-invalid rather than to the original value. It would look like a
  // typo rather than like a mistake, and it would resolve to nothing at all.
  for (const [role, referenced] of bridgeDeclarations()) {
    assert.notEqual(role, referenced.slice(2), `--${role} is aliased to itself`)
  }
})

test('dark: keys off data-mode, which is what the applier sets', () => {
  // Tailwind defaults to a `.dark` class. Quill sets `data-mode` from the
  // *resolved* theme's mode, so a reader's own dark theme is `data-mode="dark"`
  // without being named "night".
  const variant = strip(tailwindCss).match(/@custom-variant\s+dark\s+([^;]+);/)

  assert.ok(variant, 'no `@custom-variant dark` in src/tailwind.css')
  assert.match(variant[1], /data-mode=['"]dark['"]/)
})

test('preflight is not imported', () => {
  const css = strip(tailwindCss)

  // The layer-by-layer import is what excludes preflight. `@import
  // "tailwindcss"` alone would pull it back in and reset every element's
  // margins, `list-style` and native `button` appearance -- which 1,750 lines of
  // reset-free CSS currently depend on.
  assert.equal(
    css.match(/@import\s+['"]tailwindcss['"]/),
    null,
    'bare `@import "tailwindcss"` re-enables preflight',
  )
  assert.match(css, /@import\s+['"]tailwindcss\/theme\.css['"]/)
  assert.match(css, /@import\s+['"]tailwindcss\/utilities\.css['"]/)
})

test('the exposed scales are inline, so they follow the theme', () => {
  // `prefix(tw)` sits between `inline` and the brace, so the params are matched
  // loosely rather than as a fixed string. Every `@theme` block in this file has
  // to carry the prefix: they are merged, and an unprefixed one would declare
  // `--color-*` while the utilities resolve `--tw-color-*`, so the roles would
  // stop resolving without anything visibly erroring.
  const themes = [...strip(tailwindCss).matchAll(/@theme\s+([^;{]+?)\s*\{/g)]

  assert.ok(themes.length > 0, 'no `@theme` block in src/tailwind.css')

  for (const [, params] of themes) {
    // Without `inline`, Tailwind resolves each `var()` at build time and bakes the
    // fallback into the utility. The role variable would change with the theme and
    // the colour would not -- which is the same class of bug as a literal, just
    // deferred to the build.
    assert.match(
      params,
      /\binline\b/,
      `@theme${params}{ is missing \`inline\`, so utilities will not follow the theme`,
    )
    assert.match(
      params,
      /\bprefix\(tw\)/,
      `@theme${params}{ is missing \`prefix(tw)\`; it must match the prefix on the ` +
        'theme import or the role variables will not resolve',
    )
  }
})

test('cn() resolves conflicting utilities in favour of the caller', async () => {
  const { cn } = await import('../src/platform/cn.js')

  assert.equal(cn('px-3 py-1.5', 'px-6'), 'py-1.5 px-6')
  assert.equal(cn('text-muted-foreground', true && 'text-destructive'), 'text-destructive')
  assert.equal(cn('p-2', false && 'p-4'), 'p-2')
  assert.equal(cn(['a', { b: true, c: false }]), 'a b')
})

// ---------------------------------------------------------------------------
// The layering invariant
// ---------------------------------------------------------------------------

test("Quill's rules are unlayered, so a utility cannot outrank them", () => {
  // The reason Phase 1 could add Tailwind and promise no visual change.
  //
  // Unlayered CSS beats layered CSS at any specificity, so while `styles.css`
  // sits outside `@layer`, a utility loses to the rule it collides with. Phase 2
  // wraps `styles.css` in `@layer components` to let utilities win, which is
  // correct for migrated components. The prefix is what makes that safe: with
  // `.tw\:outline` and `.outline` being different classes there is no collision
  // left for layer order to matter in. So this test is expected to fail when
  // Phase 2 lands, and should be deleted in the same commit that moves
  // `styles.css` into a layer.
  assert.equal(
    /@layer[^{]*\{/.test(strip(stylesCss)),
    false,
    'src/styles.css is layered; if this is Phase 2, confirm the tw prefix guards ' +
      'the collision audit below before changing layer order',
  )
})

/**
 * Class names that both Quill and Tailwind define.
 *
 * Empty, and that is now structural rather than accidental.
 *
 * It used to be empty because the scanner was off (`source(none)`, no
 * `@source`), which cost a real bug first: `<nav class="outline">` is the
 * document outline panel, Tailwind has an `outline` utility, and the two rules
 * set different properties -- Quill's sets layout, Tailwind's sets
 * `outline-width` -- so unlayered CSS could not outrank it. The sections panel
 * rendered with a 1px white box around it.
 *
 * The scanner is on now and the list is still empty, because utilities are
 * prefixed: Tailwind emits `.tw\:outline` and Quill keeps `.outline`, so no two
 * rules can ever describe the same element. Do not widen this list to make a
 * failure go away -- a name here means the two stylesheets disagree about what a
 * class means.
 */
const KNOWN_COLLISIONS = []

/**
 * Class names out of a generated utilities layer.
 *
 * The colon matters and used to break this. Tailwind escapes the prefix
 * separator, so the emitted selector is `.tw\:flex` -- backslash, colon. A
 * character class of `[\w.-]` silently rejects that, the function returned zero
 * utilities, and the audit below reported "no collisions" for a build that had
 * four utilities in it. A collision test that cannot see collisions is worse than
 * none, so the class includes the backslash and the colon and the layer is
 * required to be non-empty below.
 */
function utilitiesIn(css) {
  const start = css.indexOf('@layer utilities{')
  if (start === -1) return null

  // Brace-matched, not sliced to the end: Quill's own unlayered rules come after
  // this layer in the bundle, and slicing would read every class in the app as a
  // Tailwind utility.
  const open = css.indexOf('{', start) + 1
  let depth = 1
  let end = open
  while (depth > 0) {
    if (css[end] === '{') depth += 1
    else if (css[end] === '}') depth -= 1
    end += 1
  }

  const names = new Set()
  for (const group of css.slice(open, end - 1).matchAll(/(?:^|[},])([^{}]+)\{/g)) {
    for (const raw of group[1].split(',')) {
      // The class name runs up to the first `:` that is *not* escaped. In `.tw\:flex`
      // every colon is preceded by a backslash and belongs to the name; in
      // `.tw\:dark\:bg-black:where(...)` the last one is not, and starts the
      // pseudo-class. Backslash lookbehind is the only way to tell them apart.
      const name = raw
        .trim()
        .match(/^\.((?:[_a-zA-Z-]|\\:|[A-Za-z0-9_-])+?)(?=(?<!\\):|\{|$)/)
      if (name) names.add(name[1].replace(/\\/g, ''))
    }
  }
  return names
}

test('the utilities-layer parser sees escaped-colon selectors', () => {
  // The guard on the guard.
  //
  // `.tw\:flex` contains a backslash and a colon, and a character class written
  // as `[\w.-]` rejects both. That is not hypothetical: it is exactly how this
  // file's collision audit used to return zero utilities from a build that had
  // four in it, and report no collisions. A synthetic layer is checked here so a
  // broken parser fails loudly while the real layer is still legitimately empty.
  const names = utilitiesIn(
    '@layer utilities{.tw\\:flex{display:flex}.tw\\:dark\\:bg-black:where([data-mode=dark],[data-mode=dark] *){background-color:#000}.flex{display:flex}}',
  )

  assert.deepEqual([...names].sort(), ['flex', 'tw:dark:bg-black', 'tw:flex'])
})

test('no Quill class shares a name with a generated utility', (t) => {
  const built = readdirSync(join(root, 'dist', 'assets')).filter((name) => name.endsWith('.css'))
  const builtPath = join(root, 'dist', 'assets', built[0] ?? '')

  if (built.length === 0 || !existsSync(builtPath)) {
    // Not a silent pass: a skipped test is visible in the runner output, and the
    // prefix-compile test below still runs without a build.
    return t.skip('no dist/assets/*.css; run `npm run build` to audit collisions')
  }

  const utilities = utilitiesIn(readFileSync(builtPath, 'utf8'))

  // The layer is always emitted now. Its *emptiness* is fine -- no component has
  // migrated to `tw:` utilities yet -- but its absence would mean the import or
  // the scanner changed, and then this audit is covering nothing.
  assert.notEqual(
    utilities,
    null,
    'the built stylesheet has no `@layer utilities`; src/tailwind.css should be ' +
      'importing tailwindcss/utilities.css without source(none)',
  )

  const quillClasses = new Set(
    [...strip(stylesCss).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]),
  )

  const collisions = [...utilities].filter((name) => quillClasses.has(name)).sort()
  assert.deepEqual(collisions, KNOWN_COLLISIONS)
})

test('every generated utility carries the tw prefix', (t) => {
  const built = readdirSync(join(root, 'dist', 'assets')).filter((name) => name.endsWith('.css'))
  const builtPath = join(root, 'dist', 'assets', built[0] ?? '')

  if (built.length === 0 || !existsSync(builtPath)) {
    return t.skip('no dist/assets/*.css; run `npm run build` to check prefixes')
  }

  const utilities = utilitiesIn(readFileSync(builtPath, 'utf8'))
  if (utilities === null) return t.skip('no utilities layer in the built stylesheet')

  const unprefixed = [...utilities].filter((name) => !name.startsWith('tw:')).sort()
  assert.deepEqual(
    unprefixed,
    [],
    'unprefixed utilities are emitted, so they can collide with Quill class names ' +
      '(that is how the sections panel got a white box); check prefix(tw) on the ' +
      'theme import in src/tailwind.css',
  )
})

/**
 * The prefix syntax itself, checked without needing a build.
 *
 * `tw:` not `tw-flex`. This is the fact that made the prefix look broken for a
 * while: Tailwind prints candidates as `${prefix}:` and its parser rejects
 * anything whose first segment is not the prefix, so `tw-flex` is silently an
 * unknown utility. Every version from 4.1.18 to 4.3.3 behaves the same, and the
 * umbrella `@import 'tailwindcss' prefix(tw)` is not a workaround.
 *
 * Compiling here rather than reading `dist/` means the failure names the cause
 * instead of showing up as a mysteriously smaller stylesheet, and it cannot pass
 * just because a stale build happens to be lying around.
 */
test('the tw prefix uses a colon, and only tw: utilities compile', async () => {
  const { compile } = await import('tailwindcss')
  const twDir = join(root, 'node_modules', 'tailwindcss')

  const compiler = await compile(
    `@import 'tailwindcss/theme.css' layer(theme) prefix(tw);
@import 'tailwindcss/utilities.css' layer(utilities);`,
    {
      base: join(root, 'src'),
      loadStylesheet: async (id) => {
        const path = join(twDir, id.replace(/^tailwindcss\//, ''))
        return { path, base: twDir, content: readFileSync(path, 'utf8') }
      },
    },
  )

  const out = compiler.build(['tw:flex', 'tw:grid', 'tw:flex', 'tw-flex', 'flex', 'outline'])

  for (const expected of ['.tw\\:flex', '.tw\\:grid']) {
    assert.ok(out.includes(expected), `expected ${expected} in compiled CSS:\n${out}`)
  }

  // The controls. Each of these is what the prefix exists to prevent, and each
  // one failed silently before rather than erroring.
  for (const unwanted of ['.tw-flex', '.flex ', '.outline']) {
    assert.ok(
      !out.includes(unwanted),
      `${unwanted} should not compile under a tw prefix, got:\n${out}`,
    )
  }
})
test('a token that derives from a themed token is not declared on :root', () => {
  // The same substitution trap as the bridge above, one layer down and in the
  // other stylesheet. `--surface`, `--surface-sidebar` and `--surface-chat` are
  // `color-mix`es of `--main`, `--sidebar` and `--chat`. A custom property
  // resolves `var()` against the element it is declared on, so declaring them
  // on `:root` computed every panel from `:root`'s own light `--main`, and no
  // `body[data-theme="night"]` override could reach back up to the
  // substitution. Panels painted light in every theme while the text on them --
  // which references `--text-1` directly from `body` -- resolved correctly and
  // went dark. The reader saw light panels under light text.
  //
  // Nothing errors and nothing warns: the tokens are declared, the colours are
  // valid, and the bug is invisible to every check that reads a theme block in
  // isolation. It is only visible with all three themes on screen at once,
  // which is why it needs asserting rather than watching for.
  const css = strip(stylesCss)

  for (const token of ['--surface', '--surface-sidebar', '--surface-chat']) {
    assert.equal(
      css.match(new RegExp(`:root\\s*\\{[^}]*${token}\\s*:`, 'g')),
      null,
      `${token} derives from a themed token, so it must not be declared on :root`,
    )
  }

  // And it has to actually be declared on body, or the panels lose their
  // background entirely rather than merely mis-theming.
  const body = css.match(/(?:^|\})\s*body\s*\{([^}]*)\}/)
  assert.ok(body, 'no `body { … }` block in src/styles.css')
  for (const token of ['--surface', '--surface-sidebar', '--surface-chat']) {
    assert.match(
      body[1],
      new RegExp(`${token}\\s*:`),
      `${token} must be declared on body, where the theme blocks are`,
    )
  }

  // `--surface-alpha-pct` is the one that belongs on `:root`: it is
  // theme-independent and is inherited down unchanged.
  assert.match(
    css.match(/:root\s*\{([^}]*)\}/)[1],
    /--surface-alpha-pct\s*:/,
    '--surface-alpha-pct is theme-independent and should stay on :root',
  )
})

test('every token a themed rule paints with is reachable from that theme', () => {
  // The structural half of the `--surface` bug, generalised.
  //
  // The harness renders `theme: 'light'` and nothing else, so a mistake that
  // only manifests under a dark theme is invisible to every other suite. Rather
  // than teach JSDOM to compute `color-mix` (it cannot), this asserts the
  // property that makes such a mistake possible in the first place: a token whose
  // value derives from another token must be declared somewhere the themed value
  // can reach.
  //
  // The rule that bit us was a `color-mix` of three themed tokens, declared on
  // `:root`, consumed by rules on elements far below `body`. `body` is where the
  // theme blocks land, so a derived token consumed below `body` has to be
  // declared at `body` or deeper -- never on `:root` or `html`.
  const css = strip(stylesCss)

  // Every declaration block, with the selector it belongs to.
  //
  // At-rules are dropped first. An `@import` line before the first rule leaves
  // `:root` with no preceding `}` for a `([^{}]+)\{` pattern to anchor on, which
  // silently swallows the single most important block in the file.
  const blocks = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match
  const atRulesStripped = css.replace(/@[\w-]+[^{;]*;/g, '\n')
  while ((match = re.exec(atRulesStripped)) !== null) {
    blocks.push({ selector: match[1].trim(), body: match[2] })
  }
  assert.ok(
    blocks.some((b) => b.selector === ':root'),
    'the block scan found no `:root` block, so this guard would pass vacuously',
  )

  const derived = /var\(--[\w-]+/
  const offenders = []

  for (const { selector, body } of blocks) {
    if (/^(html|:root)\b/.test(selector)) {
      for (const name of body.match(/--[\w-]+\s*:/g) || []) {
        const token = name.replace(/\s*:$/, '')
        const value = declarations(body).get(token)
        // A token whose own value reads another token inherits the value that
        // token has *here*, which is `:root`'s -- not the theme's.
        if (value && derived.test(value)) {
          offenders.push(`${token} in \`${selector}\` derives from ${value}`)
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    [
      offenders.length
        ? 'these tokens derive from another token but are declared where a theme cannot reach them:'
        : 'every derived token is declared below the theme blocks',
      ...offenders.map((o) => `  ${o}`),
      '',
      'A custom property resolves var() against the element it is declared on.',
      'A theme sets its tokens on `body`, so a derived token consumed below body',
      'must be declared on body or deeper. On :root it resolves the unthemed base.',
    ].join('\n'),
  )
})
