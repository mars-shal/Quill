/**
 * Theme resolution and the contrast check the picker runs before a save.
 *
 * The two halves are tested together on purpose. `themes.js` decides which
 * palette the app paints, and `check-contrast.mjs` decides whether that palette
 * is allowed to ship; if they disagree about what a theme is, the gate is
 * checking one thing while the app renders another, and both suites still pass.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  BUILT_IN_THEMES,
  THEME_IDS,
  REQUIRED_TOKENS,
  NON_COLOUR_TOKENS,
  resolveTheme,
  missingTokens,
} from '../src/library/themes.js'
import {
  parseColor,
  luminance,
  contrast,
  composite,
  flattenToken,
  checkTokens,
  REQUIRED_PAIRS,
} from '../src/library/contrast.js'
import { slugify } from '../src/platform/store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stylesheet = readFileSync(join(root, 'src', 'styles.css'), 'utf8')

// ---------------------------------------------------------------------------
// themes.js
// ---------------------------------------------------------------------------

test('every built-in theme is a light or dark mode with a name', () => {
  assert.deepEqual(THEME_IDS, ['light', 'paper', 'night'])
  for (const id of THEME_IDS) {
    const theme = BUILT_IN_THEMES[id]
    assert.ok(theme.name, `${id} needs a display name`)
    assert.ok(['light', 'dark'].includes(theme.mode), `${id} mode must be light or dark`)
  }
  assert.equal(BUILT_IN_THEMES.night.mode, 'dark')
  assert.equal(BUILT_IN_THEMES.paper.mode, 'light')
})

test('every built-in theme carries the full required token set', () => {
  for (const id of THEME_IDS) {
    assert.deepEqual(missingTokens(BUILT_IN_THEMES[id].tokens), [], `${id} is missing tokens`)
  }
})

test('the literals match the stylesheet, which is what actually renders', () => {
  // The failure this guards is the one that already happened: a hand-maintained
  // copy of the palette in the contrast script, and a copy of it again in this
  // file, both drifting from the stylesheet that paints the app. If a token
  // changes in `styles.css` and not here, the picker previews something the app
  // does not show.
  const effective = effectiveTokens()
  for (const id of THEME_IDS) {
    const literal = BUILT_IN_THEMES[id].tokens
    for (const name of REQUIRED_TOKENS) {
      assert.equal(
        literal[name],
        effective[id][name],
        `${id} ${name} in themes.js (${literal[name]}) is not the stylesheet's (${effective[id][name]})`,
      )
    }
  }
})

test('a non-colour token is never part of a theme', () => {
  // `--ease`, `--mono` and `--reading-font` are not palette: the first two are
  // the app's motion and code typefaces, the third is a reading-typography
  // setting that a font choice overwrites. A theme that set them would either be
  // ignored or, worse, fight the settings.
  for (const id of THEME_IDS) {
    for (const name of NON_COLOUR_TOKENS) {
      assert.equal(BUILT_IN_THEMES[id].tokens[name], undefined, `${id} must not define ${name}`)
    }
    assert.ok(!BUILT_IN_THEMES[id].tokens['--ease'])
  }
})

test('an unknown theme id resolves to light rather than to nothing', () => {
  const resolved = resolveTheme('midnight-navy', [])
  assert.equal(resolved.id, 'light')
  assert.equal(resolved.mode, 'light')
  assert.equal(resolved.custom, false)
  assert.deepEqual(resolved.tokens, BUILT_IN_THEMES.light.tokens)
  // Also for the shapes a corrupted settings row can hold.
  for (const value of ['', undefined, null, 42, {}, 'night ', 'NIGHT']) {
    const fallback = resolveTheme(value, [])
    assert.ok(['light', 'paper', 'night'].includes(fallback.id), `${JSON.stringify(value)} should fall back`)
  }
})

test('a built-in id wins over a custom theme that shadows its name', () => {
  const shadow = [{ theme_id: 'night', name: 'Impostor', mode: 'light', tokens: { '--main': '#fff' } }]
  const resolved = resolveTheme('night', shadow)
  assert.equal(resolved.id, 'night')
  assert.equal(resolved.mode, 'dark')
  assert.equal(resolved.custom, false)
  assert.equal(resolved.tokens['--main'], BUILT_IN_THEMES.night.tokens['--main'])
})

test('a custom dark theme inherits from night and is marked custom', () => {
  const resolved = resolveTheme('sepia-night', [
    { theme_id: 'sepia-night', name: 'Sepia Night', mode: 'dark', tokens: { '--main': '#191410', '--text-1': '#f3e9d8' } },
  ])
  assert.equal(resolved.id, 'sepia-night')
  assert.equal(resolved.name, 'Sepia Night')
  assert.equal(resolved.mode, 'dark')
  assert.equal(resolved.custom, true)
  assert.equal(resolved.tokens['--main'], '#191410')
  // Everything the author did not set comes from the dark base, not from light.
  assert.equal(resolved.tokens['--sidebar'], BUILT_IN_THEMES.night.tokens['--sidebar'])
  assert.equal(resolved.tokens['--focus-ring'], BUILT_IN_THEMES.night.tokens['--focus-ring'])
  assert.deepEqual(missingTokens(resolved.tokens), [])
})

test('a custom light theme inherits from light', () => {
  const resolved = resolveTheme('sage', [
    { theme_id: 'sage', name: 'Sage', mode: 'light', tokens: { '--main': '#f4f7f2' } },
  ])
  assert.equal(resolved.mode, 'light')
  assert.equal(resolved.tokens['--sidebar'], BUILT_IN_THEMES.light.tokens['--sidebar'])
  assert.notEqual(resolved.tokens['--sidebar'], BUILT_IN_THEMES.night.tokens['--sidebar'])
})

test('an unrecognised token name in a stored theme is dropped, not written', () => {
  // `tokens_json` is arbitrary JSON out of SQLite. Writing a name the app does
  // not know onto documentElement is either dead weight or, for a name that
  // collides with one of the app's own custom properties, a hole in the theme.
  const resolved = resolveTheme('hostile', [
    {
      theme_id: 'hostile',
      name: 'Hostile',
      mode: 'light',
      tokens: {
        '--main': '#fff',
        '--not-a-token': 'red',
        '--reading-font': 'Comic Sans',
        '--ease': 'linear',
        '--text-1': { nested: true },
        '  --text-2  ': '  #333  ',
        '--text-3': '',
      },
    },
  ])
  assert.equal(resolved.tokens['--not-a-token'], undefined)
  assert.equal(resolved.tokens['--reading-font'], undefined, 'a theme must not set the reading font')
  assert.equal(resolved.tokens['--ease'], undefined)
  assert.equal(resolved.tokens['--text-1'], BUILT_IN_THEMES.light.tokens['--text-1'], 'a non-string is ignored')
  // A stored value is trimmed, so a stray space cannot break a declaration.
  assert.equal(resolved.tokens['--text-2'], '#333')
  assert.equal(resolved.tokens['--text-3'], BUILT_IN_THEMES.light.tokens['--text-3'], 'an empty value is ignored')
})

test('a stored theme with no mode is treated as light', () => {
  const resolved = resolveTheme('modes-less', [{ theme_id: 'modes-less', name: 'M', tokens: {} }])
  assert.equal(resolved.mode, 'light')
  assert.equal(resolved.tokens['--main'], BUILT_IN_THEMES.light.tokens['--main'])
})

test('missingTokens names what a partial theme lacks', () => {
  assert.deepEqual(missingTokens({}), REQUIRED_TOKENS)
  const complete = { ...BUILT_IN_THEMES.light.tokens }
  assert.deepEqual(missingTokens(complete), [])
  const oneShort = { ...complete }
  delete oneShort['--danger']
  assert.deepEqual(missingTokens(oneShort), ['--danger'])
  // A blank value counts as missing, and `undefined` counts too.
  assert.deepEqual(missingTokens({ ...complete, '--danger': '   ' }), ['--danger'])
  assert.deepEqual(missingTokens({ ...complete, '--danger': undefined }), ['--danger'])
  assert.deepEqual(missingTokens(null), REQUIRED_TOKENS)
})

// ---------------------------------------------------------------------------
// contrast.js
// ---------------------------------------------------------------------------

test('an unparseable colour is null, never a number that passes', () => {
  // The bug this file's header describes: parseInt on a hex slice made every
  // `rgb()` and `hsl()` value NaN, and `NaN >= 4.5` is false, so the check
  // passed because it could not fail.
  for (const value of ['color-mix(in srgb, #fff 50%, #000)', 'var(--x)', 'red', 'currentColor', '', '   ', null, undefined, 7, {}]) {
    assert.equal(parseColor(value), null, `${JSON.stringify(value)} must not parse`)
    assert.equal(luminance(value), null)
  }
  // A pair is unmeasurable if *either* side is, which is why the check has to
  // test the foreground and the background rather than only the ink.
  assert.equal(contrast('rgb(0,0,0)', 'color-mix(in srgb, #fff 50%, #000)'), null)
  assert.equal(contrast('red', '#ffffff'), null)
  // A var() chain is measurable only if the theme actually defines the token.
  assert.equal(flattenToken({ '--x': '#000' }, '--x', '#ffffff'), 'rgb(0, 0, 0)')
  assert.equal(flattenToken({}, '--x', '#ffffff'), null)
  assert.equal(flattenToken({ '--x': 'var(--x)' }, '--x', '#ffffff'), null, 'a self-reference must not recurse')
})

test('parseColor handles the forms the palette actually uses', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255])
  assert.deepEqual(parseColor('#FFFFFF'), [255, 255, 255])
  assert.deepEqual(parseColor('#00000080').slice(0, 3), [0, 0, 0], '8-digit hex ignores alpha')
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30])
  assert.deepEqual(parseColor('rgba(10 20 30 / 0.5)'), [10, 20, 30])
  assert.deepEqual(parseColor('rgb(100%, 0%, 0%)'), [255, 0, 0])
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), [255, 0, 0])
  assert.deepEqual(parseColor('hsl(120 100% 50%)'), [0, 255, 0])
  assert.deepEqual(parseColor('hsl(0, 0%, 100%)'), [255, 255, 255])
  // Out-of-range channels clamp rather than producing a nonsense luminance.
  assert.deepEqual(parseColor('rgb(300, -20, 0)'), [255, 0, 0])
})

test('contrast matches the WCAG reference values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00')
  assert.equal(contrast('#ffffff', '#000000').toFixed(2), '21.00', 'order does not matter')
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48')
  assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54', 'the classic 4.5 boundary')
  assert.equal(contrast('#ffffff', '#ffffff'), 1)
  // Relative luminance of a mid grey, for reference.
  assert.equal(luminance('#808080').toFixed(4), '0.2159')
})

test('a translucent token is measured over its surface, not on its own', () => {
  // `--border` and `--hover` are rgba() in every theme. Measuring their alpha
  // as if it were opaque is how a check ends up rejecting a token that is fine.
  assert.deepEqual(composite('rgba(0, 0, 0, 0)', '#ffffff'), [255, 255, 255], 'fully transparent shows the backdrop')
  assert.deepEqual(composite('rgba(0, 0, 0, 1)', '#ffffff'), [0, 0, 0], 'opaque rgba ignores the backdrop')
  assert.deepEqual(composite('rgba(255, 255, 255, 0.5)', '#000000'), [128, 128, 128])
  assert.equal(composite('rgb(1, 2, 3)', 'var(--main)'), null, 'an unparseable backdrop is null')
  // The app's own `--border` is 10% black, which is nowhere near 3:1 -- and that
  // is correct, because a 1px separator is not the only cue for anything. What
  // matters is that alpha is applied rather than ignored: the same hue at 60%
  // has to measure very differently, and a check that read the rgba channels
  // without the alpha would call these two the same colour.
  const faint = contrast(flattenToken({ '--border': 'rgba(0, 0, 0, 0.1)' }, '--border', '#ffffff'), '#ffffff')
  const firm = contrast(flattenToken({ '--border': 'rgba(0, 0, 0, 0.6)' }, '--border', '#ffffff'), '#ffffff')
  assert.ok(firm > 3, `a 60% border should clear 3:1, got ${firm}`)
  assert.ok(faint < 2, `a 10% border is a hairline, got ${faint}`)
  // The border pair is not in REQUIRED_PAIRS for the same reason: a hairline
  // separator has no legibility floor, only a design one.
  assert.ok(!REQUIRED_PAIRS.some(([, fg]) => fg === '--border'))
})

test('the required pairs cover the surfaces the old light suite skipped', () => {
  // The sidebar and chat are painted over `--main`, so a token that passes on
  // `--main` can still fail over one of them. The original script only checked
  // `--sidebar` for night, which is why paper shipped with a `--text-3` nobody
  // had measured.
  const labels = REQUIRED_PAIRS.map(([label]) => label)
  for (const required of ['text-3 on sidebar', 'text-2 on sidebar', 'text-3 on chat', 'accent on sidebar', 'danger on sidebar', 'highlight ink']) {
    assert.ok(labels.includes(required), `${required} must be checked`)
  }
  // Every pair that carries text needs 4.5, and the focus ring 3.
  for (const [label, , need] of REQUIRED_PAIRS) {
    assert.ok(need === 4.5 || need === 3, `${label} has a threshold of ${need}`)
  }
  const ring = REQUIRED_PAIRS.find(([label]) => label === 'accent focus ring')
  assert.equal(ring[2], 3, 'a focus ring is a non-text indicator')
})

test('every built-in theme passes the check the picker runs on a save', () => {
  for (const id of THEME_IDS) {
    const failures = checkTokens(BUILT_IN_THEMES[id].tokens)
    assert.deepEqual(failures, [], `${id} fails the app's own contrast check: ${failures.map((f) => f.label).join(', ')}`)
  }
})

test('a theme the picker is offered is held to the same pairs as a built-in', () => {
  // The seeded presets are saved through the same validation as a reader's own
  // theme, so if one of them could not be saved the picker would be lying.
  const good = { ...BUILT_IN_THEMES.light.tokens, '--main': '#ffffff' }
  assert.deepEqual(checkTokens(good), [])

  // One token below its floor, everything else untouched: the failure has to
  // name the token and the threshold, because that string is the message under
  // the knob.
  const lowBody = { ...good, '--text-1': '#bbbbbb' }
  const failures = checkTokens(lowBody)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].fg, '--text-1')
  assert.equal(failures[0].need, 4.5)
  assert.ok(failures[0].ratio < 4.5)
  assert.ok(failures[0].ratio > 1, 'a real measurement, not a null')
})

test('a theme that only fails over the sidebar is still a failure', () => {
  const good = BUILT_IN_THEMES.light.tokens
  // This is the case a main-surface-only check cannot see.
  // The surface the pair is measured over is the point: this `--text-3` clears
  // 4.5:1 on `--main` and fails over `--sidebar`, so a check that only looked at
  // the main surface would pass the theme.
  const main = contrast(flattenToken(good, '--text-3', '#ffffff'), flattenToken(good, '--main', '#ffffff'))
  const tokens = { ...good, '--sidebar': '#ffffff', '--text-3': '#8f8f8f' }
  const overSidebar = contrast(flattenToken(tokens, '--text-3', '#ffffff'), flattenToken(tokens, '--sidebar', '#ffffff'))
  assert.ok(main >= 4.5, `precondition: ${main} should clear 4.5 on --main`)
  assert.ok(overSidebar < 4.5, `precondition: ${overSidebar} should fail on --sidebar`)
  const failures = checkTokens(tokens)
  assert.ok(
    failures.some((f) => f.label === 'text-3 on sidebar'),
    `expected a sidebar failure, got ${JSON.stringify(failures.map((f) => f.label))}`,
  )
})

test('an unmeasurable token fails the check rather than passing it', () => {
  const tokens = { ...BUILT_IN_THEMES.light.tokens, '--text-1': 'var(--not-a-token)' }
  const failures = checkTokens(tokens)
  const one = failures.find((f) => f.fg === '--text-1')
  assert.ok(one, 'an unparseable value has to be reported')
  assert.equal(one.ratio, null, 'it is reported as unmeasurable, not as a number')
})

test('a theme with no measurable surface reports one failure, not thirty', () => {
  const failures = checkTokens({ '--text-1': '#000' })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].label, 'surface')
})

// ---------------------------------------------------------------------------
// helper: the effective tokens the stylesheet paints, parsed the same way the
// contrast gate parses them
// ---------------------------------------------------------------------------

function effectiveTokens() {
  const out = {}
  const rootTokens = block(':root')
  out.light = { ...rootTokens, ...block('body[data-theme="light"]') }
  out.paper = { ...rootTokens, ...block('body[data-theme="paper"]') }
  out.night = { ...rootTokens, ...block('body[data-theme="night"]') }
  return out
}

function block(selector) {
  const index = stylesheet.indexOf(selector)
  if (index === -1) throw new Error(`stylesheet has no ${selector}`)
  const open = stylesheet.indexOf('{', index)
  let depth = 1
  let cursor = open + 1
  while (depth > 0) {
    if (stylesheet[cursor] === '{') depth += 1
    if (stylesheet[cursor] === '}') depth -= 1
    cursor += 1
  }
  const body = stylesheet.slice(open + 1, cursor - 1)
  const tokens = {}
  for (const line of body.split('\n')) {
    const match = line.match(/(--[a-z0-9-]+)\s*:\s*([^;]+);/i)
    if (match) tokens[match[1]] = match[2].trim()
  }
  return tokens
}

// ---------------------------------------------------------------------------
// the seeded presets
// ---------------------------------------------------------------------------

test('every seeded preset passes the check the picker enforces on a save', () => {
  // Read out of the migration rather than a fixture, because the two drifting
  // apart is the failure: a preset row that the picker would refuse to save, or
  // a palette the app can never actually select. `scripts/author-presets.mjs`
  // writes the migration and is where the palettes are authored.
  const migration = readFileSync(join(root, 'src-tauri', 'migrations', '0004_curated_themes.sql'), 'utf8')
  const presets = parsePresetRows(migration)

  assert.equal(presets.length, 6, `expected six curated themes, found ${presets.map((p) => p.theme_id).join(', ')}`)
  assert.deepEqual(
    presets.map((p) => p.theme_id).sort(),
    ['dracula', 'midnight', 'nord', 'rose-pine', 'sepia', 'solar'],
  )
  // Four dark, two light: the two sides of the pair table, and the side decides
  // which base a custom theme inherits and which ink the effects are given.
  assert.deepEqual(presets.filter((p) => p.mode === 'dark').map((p) => p.theme_id).sort(), ['dracula', 'midnight', 'nord', 'rose-pine'])
  assert.deepEqual(presets.filter((p) => p.mode === 'light').map((p) => p.theme_id).sort(), ['sepia', 'solar'])

  for (const preset of presets) {
    const stored = { theme_id: preset.theme_id, name: preset.name, mode: preset.mode, tokens: preset.tokens }
    const resolved = resolveTheme(preset.theme_id, [stored])
    assert.equal(resolved.id, preset.theme_id, `${preset.theme_id} did not resolve to itself`)
    assert.equal(resolved.custom, true, `${preset.theme_id} must resolve as a custom theme`)
    assert.deepEqual(missingTokens(resolved.tokens), [], `${preset.theme_id} is missing tokens once merged`)
    const failures = checkTokens(resolved.tokens)
    assert.deepEqual(failures, [], `${preset.theme_id} fails the contrast check: ${failures.map((f) => `${f.label} ${f.ratio?.toFixed(2)}`).join(', ')}`)

    // The id has to be the slug of the name, or the picker would offer a theme
    // under one name and store it under another.
    assert.equal(slugify(preset.name), preset.theme_id, `${preset.theme_id} is not the slug of "${preset.name}"`)
  }
})

test('a seeded preset sets no token the app does not know', () => {
  // A typo in a token name in the migration is invisible at runtime: the
  // stylesheet falls back to the base and the preset quietly looks like a
  // recolour of light or night with one stubborn surface.
  const migration = readFileSync(join(root, 'src-tauri', 'migrations', '0004_curated_themes.sql'), 'utf8')
  for (const preset of parsePresetRows(migration)) {
    for (const name of Object.keys(preset.tokens)) {
      assert.ok(
        REQUIRED_TOKENS.includes(name),
        `${preset.theme_id} sets ${name}, which is not a theme token`,
      )
      assert.ok(
        !NON_COLOUR_TOKENS.includes(name),
        `${preset.theme_id} sets ${name}, which is not a colour token`,
      )
    }
    // Enough of a palette to be worth offering.
    assert.ok(Object.keys(preset.tokens).length >= 15, `${preset.theme_id} sets too few tokens`)
  }
})

test('no seeded token value would break a CSS declaration', () => {
  // A value with a semicolon or a brace would end the declaration early, and the
  // rest of the string would be parsed as a property name. This is the class of
  // thing that only shows up as a mysterious unstyled surface.
  const migration = readFileSync(join(root, 'src-tauri', 'migrations', '0004_curated_themes.sql'), 'utf8')
  for (const preset of parsePresetRows(migration)) {
    for (const [name, value] of Object.entries(preset.tokens)) {
      assert.equal(typeof value, 'string', `${preset.theme_id} ${name} is not a string`)
      assert.ok(!/[;{}]/.test(value), `${preset.theme_id} ${name} contains a CSS delimiter: ${value}`)
      assert.ok(!value.includes("'"), `${preset.theme_id} ${name} has a quote, which breaks the SQL literal`)
    }
  }
})

/**
 * The preset rows out of the migration.
 *
 * Parsed rather than regex-matched blindly: the id, name and mode are SQL string
 * literals and the tokens are a JSON object, so the row has to be cut on the
 * literal boundaries. A JSON parse failure is a test failure, not a skipped
 * row, because a row that stopped being parseable means the migration changed
 * shape and this extractor needs to know.
 */
function parsePresetRows(migration) {
  const body = migration.slice(migration.indexOf('INSERT INTO custom_themes'))
  const rows = []
  const pattern = /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'(light|dark)'\s*\)/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    rows.push({
      theme_id: match[1],
      name: match[2],
      tokens: JSON.parse(match[3]),
      mode: match[4],
    })
  }
  return rows
}
