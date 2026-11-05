/**
 * Contrast checker for the Quill palette.
 *
 * Reads `src/styles.css` and derives every theme from the token blocks that are
 * actually in the stylesheet, so the check cannot drift away from what renders.
 * It used to hold a hand-maintained copy of the palette in `SUITES`, which had
 * already gone stale: paper's `--text-3` was `#77736b` in the script and
 * `#a09b91` in the stylesheet, and the light suite never covered `--sidebar` at
 * all.
 *
 * The arithmetic and the threshold table live in `src/library/contrast.js`, not
 * here, because Phase 3's theme picker has to run the same check on a theme the
 * reader has just written before it is allowed to save. A second copy of the
 * contrast maths would be the same drift again, one level up: the palette the
 * gate enforces and the palette the app enforces would be two different things.
 *
 * Body text must reach 4.5:1; non-text indicators (focus rings, borders used as
 * the only cue) need 3:1.
 *
 * Run: node scripts/check-contrast.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { luminance, contrast, composite, flattenToken, mix } from '../src/library/contrast.js'
import { COVER_PIGMENTS, COVER_PIGMENT_TINT, COVER_TONES } from '../src/library/cover.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stylesheet = readFileSync(join(root, 'src', 'styles.css'), 'utf8')

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/** Every `--token: value` declaration in a declaration block, last match wins. */
function tokensIn(block) {
  const tokens = new Map()
  for (const part of block.split(';')) {
    const match = part.match(/^\s*(--[\w-]+)\s*:\s*([^;]+)$/)
    if (match) tokens.set(match[1], match[2].trim())
  }
  return tokens
}

/**
 * The token maps for each theme, read from the stylesheet.
 *
 * `:root` is the base layer, and each `body[data-theme="…"]` block overrides it,
 * so a theme's effective tokens are `:root` with that block merged over. This
 * mirrors what the cascade does, which is the point: a token the script reports
 * is a token that renders.
 */
export function readThemes() {
  const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
  const base = tokensIn((withoutComments.match(/:root\s*\{([^}]*)\}/) || [, ''])[1])

  const themes = new Map()
  const blockPattern = /body\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g
  let match
  while ((match = blockPattern.exec(withoutComments)) !== null) {
    themes.set(match[1], new Map(Object.entries({ ...Object.fromEntries(base), ...Object.fromEntries(tokensIn(match[2])) })))
  }
  return themes
}

/**
 * The pairs that must hold, expressed as token names rather than literal hex.
 *
 * A pair is `[label, foregroundToken, minimum, backgroundToken]`. The
 * background defaults to the theme's `--main`.
 */
const SUITES = [
  {
    theme: 'light',
    pairs: [
      ['text-1', '--text-1', 4.5],
      ['text-2', '--text-2', 4.5],
      ['text-3', '--text-3', 4.5],
      ['text-3 on sidebar', '--text-3', 4.5, '--sidebar'],
      ['text-2 on sidebar', '--text-2', 4.5, '--sidebar'],
      // `--backdrop` is not decorative. `.boot-screen` sets
      // `color: var(--text-2); background: var(--backdrop)`, so it is the one
      // plane text is painted on with no panel between. It was absent from
      // every suite here, which is how light's --text-2 sat at 4.30:1 behind a
      // green gate.
      ['text-2 on backdrop', '--text-2', 4.5, '--backdrop'],
      ['text-3 on backdrop', '--text-3', 4.5, '--backdrop'],
      ['prose', '--prose', 4.5],
      ['accent (links)', '--accent', 4.5],
      ['accent on sidebar', '--accent', 4.5, '--sidebar'],
      ['on-accent on accent', '--on-accent', 4.5, '--accent'],
      ['on-publish on publish', '--on-publish', 4.5, '--publish'],
      ['danger', '--danger', 4.5],
      ['danger on sidebar', '--danger', 4.5, '--sidebar'],
      ['highlight ink', '--highlight-ink', 4.5, '--highlight-bg'],
      ['accent focus ring', '--focus-ring', 3, '--main'],
    ],
  },
  {
    theme: 'paper',
    pairs: [
      ['text-1', '--text-1', 4.5],
      ['text-2', '--text-2', 4.5],
      ['text-3', '--text-3', 4.5],
      ['text-3 on sidebar', '--text-3', 4.5, '--sidebar'],
      ['text-2 on sidebar', '--text-2', 4.5, '--sidebar'],
      ['text-2 on backdrop', '--text-2', 4.5, '--backdrop'],
      ['text-3 on backdrop', '--text-3', 4.5, '--backdrop'],
      ['prose', '--prose', 4.5],
      ['accent (links)', '--accent', 4.5],
      ['on-accent on accent', '--on-accent', 4.5, '--accent'],
      ['on-publish on publish', '--on-publish', 4.5, '--publish'],
      ['danger', '--danger', 4.5],
      ['highlight ink', '--highlight-ink', 4.5, '--highlight-bg'],
      ['accent focus ring', '--focus-ring', 3, '--main'],
    ],
  },
  {
    theme: 'night',
    pairs: [
      ['text-1', '--text-1', 4.5],
      ['text-2', '--text-2', 4.5],
      ['text-3', '--text-3', 4.5],
      ['text-3 on sidebar', '--text-3', 4.5, '--sidebar'],
      ['text-2 on sidebar', '--text-2', 4.5, '--sidebar'],
      ['text-3 on chat', '--text-3', 4.5, '--chat'],
      ['text-2 on backdrop', '--text-2', 4.5, '--backdrop'],
      ['text-3 on backdrop', '--text-3', 4.5, '--backdrop'],
      ['prose', '--prose', 4.5],
      ['accent (links)', '--accent', 4.5],
      ['accent on sidebar', '--accent', 4.5, '--sidebar'],
      ['on-accent on accent', '--on-accent', 4.5, '--accent'],
      ['on-publish on publish', '--on-publish', 4.5, '--publish'],
      ['danger', '--danger', 4.5],
      ['highlight ink', '--highlight-ink', 4.5, '--highlight-bg'],
      ['accent focus ring', '--focus-ring', 3, '--main'],
    ],
  },
]

/**
 * Plane separation, which WCAG does not cover and this project does.
 *
 * The night palette is four near-blacks roughly four L* apart, and the comment
 * at styles.css:215-236 argues the separation is carried by `--border` rather
 * than by the surface ratios, because WCAG says nothing about plane separation.
 * That is the right call, and it is also an invitation: nothing stopped a later
 * edit from darkening `--backdrop` until page and rail read as one flat mass,
 * which is the specific regression that comment was written to prevent.
 *
 * So the ratios are floored rather than left to judgement. The floor is
 * deliberately low -- night's backdrop sits at 1.06:1 against `--main` and
 * passes -- because the requirement is only that the planes stay
 * *distinguishable*, not that they contrast enough to read as separate on their
 * own. A theme that pushes below this has collapsed two planes into one.
 */
const SEPARATION_FLOOR = 1.02

function runSeparation(themes) {
  const failures = []
  // Only the backdrop junction. Every panel-to-panel seam already carries a
  // 1px `--border` -- `.library-sidebar`, `.left-panel` and `.right-panel` each
  // declare one -- and night's own comment at styles.css:215-236 argues that
  // the borders are what separate the planes, with the surface ratios
  // deliberately near 1.1:1. Night's `--main` and `--sidebar` sit at 1.001:1
  // by that design, so asserting a floor between them would be asserting
  // against the palette instead of checking it. The backdrop is the one seam
  // with nothing between it and the outermost plane.
  const pairs = [
    ['--backdrop', '--main'],
    ['--backdrop', '--sidebar'],
  ]
  for (const [name, tokens] of themes) {
    for (const [a, b] of pairs) {
      const left = flattenToken(tokens, a, '#ffffff')
      const right = flattenToken(tokens, b, '#ffffff')
      const ratio = left === null || right === null ? null : contrast(left, right)
      if (ratio === null) {
        failures.push({ theme: name, label: `${a} vs ${b}`, detail: 'unparseable' })
      } else if (ratio < SEPARATION_FLOOR) {
        failures.push({
          theme: name,
          label: `${a} vs ${b}`,
          detail: `${ratio.toFixed(3)}:1, floor ${SEPARATION_FLOOR}`,
        })
      }
    }
  }
  console.log(
    `\n--- Plane separation (surface vs surface, floor ${SEPARATION_FLOOR}:1) ---`,
  )
  for (const failure of failures) {
    console.log(
      `  FAIL  ${failure.theme.padEnd(7)} ${failure.label.padEnd(24)} ${failure.detail}`,
    )
  }
  if (!failures.length) {
    console.log('  PASS  every theme keeps its planes distinguishable')
  }
  return failures.length
}

/**
 * The covers, which are the one surface a `color-mix` builds at paint time.
 *
 * Every other suite above names two tokens and measures them. A cover cannot be
 * measured that way: it is the theme's sidebar, dyed with one of three pigments
 * and lifted by one of five strengths, and `flattenToken` cannot resolve a
 * `color-mix` -- `parseColor` returns null for it, deliberately, because a check
 * that silently skipped what it could not measure is a check that reports a
 * theme as accessible when part of it was never looked at. So this pass builds
 * the same two mixes the stylesheet builds, with `mix()`, out of the same
 * `COVER_PIGMENTS` / `COVER_PIGMENT_TINT` / `COVER_TONES` the grid renders from,
 * and measures the title that sits on top of it.
 *
 * Both ends of the ladder are checked for every pigment in every theme rather
 * than a sample. Fifteen covers in a library is a small number, but the ladder
 * is fifteen long across three pigments and a reader's library is not bounded,
 * so the whole cross product is 45 colours per theme and it costs nothing.
 *
 * The pair is the cover title against the cover, at 4.5. It is body text at
 * 12px, the same threshold `--text-1` on `--main` is held to.
 */
function runCovers(themes) {
  const failures = []
  const checks = []
  for (const [name, tokens] of themes) {
    const face = flattenToken(tokens, '--main', '#ffffff')
    const cloth = flattenToken(tokens, '--sidebar', face || '#ffffff')
    if (!face || !cloth) {
      failures.push({ theme: name, label: 'cover tokens', detail: 'a cover token is not measurable' })
      continue
    }
    for (const pigment of COVER_PIGMENTS) {
      const dye = flattenToken(tokens, pigment, cloth)
      if (!dye) {
        failures.push({ theme: name, label: `${pigment} as cover pigment`, detail: 'not measurable' })
        continue
      }
      const dyedCloth = mix(dye, cloth, COVER_PIGMENT_TINT / 100)
      if (!dyedCloth) {
        failures.push({ theme: name, label: `${pigment} cloth`, detail: 'mix produced no colour' })
        continue
      }
      for (const tone of COVER_TONES) {
        const cover = mix(face, dyedCloth, tone / 100)
        if (!cover) {
          failures.push({ theme: name, label: `${pigment} ${tone}%`, detail: 'mix produced no colour' })
          continue
        }
        // The title is `--text-1` over the mixed cover. It has to be flattened
        // over that surface rather than over white, because the cover is a
        // theme surface with a pigment in it and can be light or dark.
        // `mix()` returns channels, and `parseColor` only accepts strings, so
        // the computed cover is rendered back to `rgb()`.
        const coverCss = `rgb(${cover.join(', ')})`
        const printedTitle = flattenToken(tokens, '--text-1', coverCss)
        const titleRatio = printedTitle ? contrast(printedTitle, coverCss) : null
        checks.push({ theme: name, label: `${pigment} ${tone}%` })
        if (titleRatio === null || titleRatio < 4.5) {
          failures.push({ theme: name, label: `title on ${pigment} ${tone}%`, detail: `${titleRatio === null ? 'unmeasurable' : `${titleRatio.toFixed(2)}:1`}, needs 4.5` })
        }
      }
    }
  }
  console.log(`\n--- Document covers (${COVER_PIGMENTS.length} pigments x ${COVER_TONES.length} tones x ${checks.length / (COVER_PIGMENTS.length * COVER_TONES.length)} themes, title 4.5) ---`)
  // Only the worst case per theme is printed; 45 passing rows per theme is noise.
  for (const [name] of themes) {
    const mine = failures.filter((failure) => failure.theme === name)
    if (mine.length === 0) {
      console.log(`  PASS  ${name.padEnd(7)} the title holds on every binding`)
    } else {
      for (const failure of mine) {
        console.log(`  FAIL  ${failure.theme.padEnd(7)} ${failure.label.padEnd(30)} ${failure.detail}`)
      }
    }
  }
  return failures.length
}

/**
 * Every `var(--token)` a theme block references must exist in `:root`.
 *
 * `:root` is a complete, light token set that the three `body[data-theme="…"]`
 * blocks override. That is deliberate: it is the fallback for anything painted
 * before `data-theme` lands, and the base a reader-authored theme inherits from.
 *
 * The hazard is directional. A theme block may freely *define* new tokens, and
 * several do (night adds `--shadow-1`, `--scrollbar-thumb`). But a block that
 * *references* a token `:root` never defines resolves to nothing at computed-
 * value time, so the declaration is dropped and the surface silently loses that
 * property -- no error, no warning, one theme subtly wrong. This is failure
 * mode 2 in `tailwind-bridge.test.mjs`, applied to the palette blocks rather
 * than to the shadcn role variables, which that file covers.
 *
 * Asserted against the stylesheet rather than against a frozen list, so a token
 * added to a theme without being added to `:root` fails here.
 */
function runTokenClosure(themes) {
  const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
  // `Object.fromEntries`, not `Object.keys`: `tokensIn` returns a Map, and
  // `Object.keys` on a Map is always empty -- a Map's token names live on no
  // own enumerable property, so the set built here was empty no matter what
  // `:root` declared, and this check could only ever report one outcome:
  // every theme passes. It stayed green because no theme block referenced a
  // token through `var()`, which is a thing the palette had never needed to
  // do; night's `--sheet-shadow` mixes its ink from `--sheet-shade`, so the
  // guard was finally given something to look at and reported a token that
  // `:root` declares six lines into the sheet family.
  //
  // `readThemes` above already got this right, which is what made the two
  // disagree: the suites read tokens the app paints, the closure check read
  // nothing.
  const baseTokens = new Set(
    Object.keys(Object.fromEntries(tokensIn((withoutComments.match(/:root\s*\{([^}]*)\}/) || [, ''])[1]))),
  )
  const failures = []
  const blockPattern = /body\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g
  let match
  while ((match = blockPattern.exec(withoutComments)) !== null) {
    const [, theme, body] = match
    for (const reference of body.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = reference[1]
      if (!baseTokens.has(name)) {
        failures.push({ theme, name })
      }
    }
  }
  console.log('\n--- Theme token closure (every var(--x) a theme uses is defined in :root) ---')
  for (const failure of failures) {
    console.log(
      `  FAIL  ${failure.theme.padEnd(7)} references ${failure.name}, which :root never defines -- it resolves to nothing and the declaration is dropped`,
    )
  }
  if (!failures.length) {
    console.log('  PASS  every token a theme references resolves in :root')
  }
  return failures.length
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * The checker has to be able to fail.
 *
 * The previous version parsed colours with `parseInt(hex.slice(...), 16)`, so
 * anything that was not a 6-digit hex produced `NaN`, and every `NaN >= need`
 * is false. A pair using an unmeasurable colour therefore reported as a
 * failure -- but the deeper problem was that `SUITES` held literal hex, so the
 * one thing that could drift (the stylesheet) was never consulted. These cases
 * pin the failure modes rather than the palette, which P0-7's own note called
 * out as the reason to rewrite this.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  // [value, expected luminance, note]
  const selfTest = [
    ['#ffffff', 1, 'white'],
    ['#000000', 0, 'black'],
    ['#fff', 1, 'three-digit hex expands'],
    ['rgb(255, 255, 255)', 1, 'comma-separated rgb'],
    ['rgb(0 0 0)', 0, 'space-separated rgb'],
    ['hsl(0, 100%, 50%)', 0.2126, 'hsl is a colour, not unmeasurable'],
    ['rgba(255, 0, 0, 0.5)', 0.2126, 'alpha is ignored for luminance'],
    ['color-mix(in srgb, #fff 50%, #000)', null, 'color-mix is not resolvable here'],
    ['not-a-colour', null, 'garbage in, null out'],
    ['', null, 'empty string'],
    [null, null, 'null'],
    [undefined, null, 'undefined'],
  ]
  for (const [value, expected, note] of selfTest) {
    const actual = luminance(value)
    if (expected === null) {
      if (actual !== null) throw new Error(`luminance(${JSON.stringify(value)}) should be unmeasurable (${note}), got ${actual}`)
    } else if (actual === null || Math.abs(actual - expected) > 0.001) {
      throw new Error(`luminance(${JSON.stringify(value)}) expected ~${expected} (${note}), got ${actual}`)
    }
  }

  // An unmeasurable pair must be null, never a number a caller could compare.
  if (contrast('color-mix(in srgb, #fff 50%, #000)', '#000000') !== null) {
    throw new Error('an unmeasurable foreground must yield a null ratio, not a number')
  }
  // Compositing is what makes a translucent token usable as a surface.
  const transparent = composite('rgba(0, 0, 0, 0)', '#ffffff')
  if (!transparent || transparent.some((channel) => channel !== 255)) {
    throw new Error(`a fully transparent overlay must composite to its backdrop, got ${transparent}`)
  }
  // The suite must read the stylesheet, not a frozen copy: a token that exists
  // only in CSS has to be visible here.
  const themes = readThemes()
  for (const name of ['light', 'paper', 'night']) {
    if (!themes.get(name)?.has('--text-3')) throw new Error(`theme ${name} has no --text-3 in the stylesheet`)
  }
  console.log('==> checker self-test passed')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const themes = readThemes()
  let failed = 0

  for (const suite of SUITES) {
    const tokens = themes.get(suite.theme)
    if (!tokens) {
      console.log(`\n--- ${suite.theme} ---`)
      console.log(`  FAIL  the stylesheet has no body[data-theme="${suite.theme}"] block`)
      failed += 1
      continue
    }
    const surface = flattenToken(tokens, '--main', '#ffffff')
    console.log(`\n--- ${suite.theme} (surface ${tokens.get('--main')}) ---`)
    for (const [label, fgToken, need, bgToken = '--main'] of suite.pairs) {
      const background = flattenToken(tokens, bgToken, tokens.get('--main') || '#ffffff')
      const foreground = flattenToken(tokens, fgToken, tokens.get('--main') || '#ffffff')
      const ratio = foreground === null || background === null ? null : contrast(foreground, background)
      // A pair that cannot be measured is a failure. Treating it as a pass is
      // how the old NaN behaviour let unmeasurable colours through.
      const ok = ratio !== null && ratio >= need
      if (!ok) failed += 1
      const kind = need === 3 ? 'non-text' : 'text'
      const shown = ratio === null ? '  n/a' : ratio.toFixed(2).padStart(6)
      const why = ok ? '' : ratio === null ? ' -- value not measurable' : ''
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(24)} ${shown}  (${kind} needs ${need}${why})`)
    }
    // Guard against a token the suite forgot entirely.
    if (!surface) {
      console.log(`  FAIL  ${suite.theme} has no measurable --main surface`)
      failed += 1
    }
  }

  failed += runCovers(themes)
  failed += runSeparation(themes)
  failed += runTokenClosure(themes)

  console.log(failed ? `\n${failed} check(s) below target` : '\nAll checks meet target')
  process.exit(failed ? 1 : 0)
}
