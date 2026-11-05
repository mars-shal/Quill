/**
 * One-off generator for the 0004 preset migration.
 *
 * Not part of the test suite. It exists because a preset shipped as SQL has to
 * pass the same contrast check the picker enforces on a reader's own theme, and
 * hand-writing six palettes in SQL and then finding out they fail is the slow way
 * to do that. Run it, read the output, and only commit a migration whose presets
 * all pass.
 *
 * The shelf grew in 0006, and that file is frozen too: `tests/themes.test.mjs`
 * now reads every preset migration, which is the gate a new palette has to pass.
 * Running this generator with `--write` would rewrite 0004 and must not be used
 * for new themes.
 *
 * Usage: node scripts/author-presets.mjs [--write]
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { resolveTheme, BUILT_IN_THEMES, REQUIRED_TOKENS } from '../src/library/themes.js'
import { checkTokens, describeFailure } from '../src/library/contrast.js'

/**
 * The presets, each as the tokens it changes rather than the whole palette.
 *
 * A partial row is the right shape for a seed: `resolveTheme` merges a custom
 * theme over the base for its mode, so a preset that sets twelve tokens is a
 * complete theme at runtime, and it stays coherent when the light or night base
 * is retuned. Spelling out all eighteen per theme would mean six copies of the
 * base drifting apart from the stylesheet.
 */
const PRESETS = [
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    tokens: {
      '--main': '#0b1020',
      '--backdrop': '#060912',
      '--sidebar': '#0f1629',
      '--chat': '#131c33',
      '--border': 'rgba(148, 178, 255, 0.16)',
      '--border-strong': 'rgba(148, 178, 255, 0.34)',
      '--text-1': '#e6ecff',
      '--text-2': '#b6c2e0',
      '--text-3': '#9aa8c9',
      '--prose': '#d5ddf2',
      '--accent': '#8fb0ff',
      '--on-accent': '#0b1020',
      '--publish': '#7ee0a8',
      '--on-publish': '#06231a',
      '--danger': '#ff9d9d',
      '--highlight-bg': '#3a4a7a',
      '--highlight-ink': '#f0f4ff',
      '--focus-ring': 'rgba(143, 176, 255, 0.9)',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    tokens: {
      '--main': '#2e3440',
      '--backdrop': '#242933',
      '--sidebar': '#3b4252',
      '--chat': '#353c4a',
      '--border': 'rgba(216, 222, 233, 0.14)',
      '--border-strong': 'rgba(216, 222, 233, 0.3)',
      '--text-1': '#eceff4',
      '--text-2': '#d8dee9',
      '--text-3': '#bcc6da',
      '--prose': '#e5e9f0',
      '--accent': '#88c0d0',
      '--on-accent': '#1b222c',
      '--publish': '#a3be8c',
      '--on-publish': '#1d2418',
      '--danger': '#f0a8af',
      '--highlight-bg': '#4c566a',
      '--highlight-ink': '#eceff4',
      '--focus-ring': 'rgba(136, 192, 208, 0.85)',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    tokens: {
      '--main': '#282a36',
      '--backdrop': '#1e1f29',
      '--sidebar': '#343746',
      '--chat': '#2f3140',
      '--border': 'rgba(248, 248, 242, 0.12)',
      '--border-strong': 'rgba(248, 248, 242, 0.28)',
      '--text-1': '#f8f8f2',
      '--text-2': '#d6d6de',
      '--text-3': '#b9bbc9',
      '--prose': '#ececf2',
      '--accent': '#bd93f9',
      '--on-accent': '#1e1f29',
      '--publish': '#50fa7b',
      '--on-publish': '#10240f',
      '--danger': '#ff7b7b',
      '--highlight-bg': '#4f5d8a',
      '--highlight-ink': '#f8f8f2',
      '--focus-ring': 'rgba(189, 147, 249, 0.85)',
    },
  },
  {
    id: 'rose-pine',
    name: 'Rose Pine',
    mode: 'dark',
    tokens: {
      '--main': '#191724',
      '--backdrop': '#12101c',
      '--sidebar': '#1f1d2e',
      '--chat': '#21202e',
      '--border': 'rgba(224, 222, 244, 0.12)',
      '--border-strong': 'rgba(224, 222, 244, 0.28)',
      '--text-1': '#e0def4',
      '--text-2': '#cfc6dd',
      '--text-3': '#ada3c0',
      '--prose': '#d9d5ec',
      '--accent': '#c4a7e7',
      '--on-accent': '#191724',
      '--publish': '#9ccfd8',
      '--on-publish': '#0f2422',
      '--danger': '#eb6f92',
      '--highlight-bg': '#403d52',
      '--highlight-ink': '#e0def4',
      '--focus-ring': 'rgba(196, 167, 231, 0.85)',
    },
  },
  {
    id: 'sepia',
    name: 'Sepia',
    mode: 'light',
    tokens: {
      '--main': '#fbf3e4',
      '--backdrop': '#efe3cd',
      '--sidebar': '#f6ecdb',
      '--chat': '#fdf6ea',
      '--border': 'rgba(46, 36, 24, 0.16)',
      '--border-strong': 'rgba(46, 36, 24, 0.32)',
      '--text-1': '#2e2418',
      '--text-2': '#574734',
      '--text-3': '#6f5e48',
      '--prose': '#3a2e1f',
      '--accent': '#8a5a1f',
      '--on-accent': '#fdf6ea',
      '--publish': '#3f6b2f',
      '--on-publish': '#f4fbec',
      '--danger': '#9c2f1f',
      '--highlight-bg': '#e8c98a',
      '--highlight-ink': '#33240a',
      '--focus-ring': 'rgba(138, 90, 31, 0.75)',
    },
  },
  {
    id: 'solar',
    name: 'Solar',
    mode: 'light',
    tokens: {
      '--main': '#fffdf7',
      '--backdrop': '#f4efe3',
      '--sidebar': '#f8f3e9',
      '--chat': '#fdf8ee',
      '--border': 'rgba(30, 26, 18, 0.14)',
      '--border-strong': 'rgba(30, 26, 18, 0.3)',
      '--text-1': '#1e1a12',
      '--text-2': '#4a4232',
      '--text-3': '#655b48',
      '--prose': '#2b2519',
      '--accent': '#9a4b16',
      '--on-accent': '#fffdf7',
      '--publish': '#1f6b3a',
      '--on-publish': '#f2fff6',
      '--danger': '#a01b1b',
      '--highlight-bg': '#ffe08a',
      '--highlight-ink': '#3a2c00',
      '--focus-ring': 'rgba(154, 75, 22, 0.75)',
    },
  },
]

let failed = false
for (const preset of PRESETS) {
  // Stored as the row shape, not the authoring shape. Passing `preset` itself
  // looks equivalent and is not: `resolveTheme` matches on `theme_id`, the
  // authoring objects use `id`, so every lookup missed and fell back to light --
  // and the check then passed six light themes it had never looked at.
  const stored = {
    theme_id: preset.id,
    name: preset.name,
    mode: preset.mode,
    tokens: preset.tokens,
  }
  const resolved = resolveTheme(preset.id, [stored])
  // Loud rather than silent, because the fallback is indistinguishable from a
  // pass on the happy path.
  if (resolved.id !== preset.id || !resolved.custom) {
    console.log(`FAIL ${preset.id.padEnd(10)} did not resolve to itself: got ${resolved.id} (custom=${resolved.custom})`)
    failed = true
    continue
  }
  const missing = REQUIRED_TOKENS.filter((name) => {
    const value = resolved.tokens[name]
    return typeof value !== 'string' || !value.trim()
  })
  const failures = checkTokens(resolved.tokens)
  const unknown = Object.keys(preset.tokens).filter((name) => !REQUIRED_TOKENS.includes(name))
  const bad = missing.length || failures.length
  if (bad) failed = true
  console.log(
    `${bad ? 'FAIL' : 'ok  '} ${preset.id.padEnd(10)} ${preset.mode.padEnd(5)} ` +
    `${Object.keys(preset.tokens).length} overrides` +
    (unknown.length ? ` | unknown token names: ${unknown.join(', ')}` : ''),
  )
  for (const name of missing) console.log(`       missing ${name}`)
  for (const failure of failures) console.log(`       ${describeFailure(failure)}`)
}

if (failed) {
  console.log('\nNot writing a migration: a preset does not pass the check the picker runs.')
  process.exit(1)
}

// The SQL string literal cannot contain a single quote, and a preset with one
// would produce a migration that fails at run time rather than at build time.
for (const preset of PRESETS) {
  for (const [name, value] of Object.entries(preset.tokens)) {
    if (String(value).includes("'")) {
      console.error(`${preset.id} ${name} contains a single quote`)
      process.exit(1)
    }
  }
}

if (!process.argv.includes('--write')) {
  console.log('\nAll presets pass. Re-run with --write to emit the migration.')
  process.exit(0)
}

const rows = PRESETS.map((preset) => {
  const json = JSON.stringify(preset.tokens)
  return `    ('${preset.id}', '${preset.name}', '${json}', '${preset.mode}')`
}).join(',\n')

const migration = `-- Curated themes.
--
-- Six palettes a reader can pick without authoring one. They are ordinary
-- \`custom_themes\` rows rather than a new concept: the picker lists them the same
-- way it lists a reader's own, and "Save as..." on any of them produces a copy
-- the reader can then edit. That is deliberate -- a preset behind its own code
-- path would be the first thing to drift from the one the app validates.
--
-- The token sets are partial. \`resolveTheme\` merges a custom theme over the base
-- for its \`mode\`, so a preset that sets the eighteen tokens the contrast pairs
-- measure is a complete theme at runtime and stays coherent when the light or
-- night base is retuned.
--
-- Every row passes \`checkTokens\` from \`src/library/contrast.js\`, which is the
-- same check the picker runs before it will save a reader's theme. \`authored by
-- scripts/author-presets.mjs\`; \`tests/themes.test.mjs\` re-checks them against
-- this file, so a hand edit that breaks one fails the JavaScript suite.
--
-- mode is 'dark' for the four dark palettes and 'light' for the two light ones.
-- It decides the base a custom theme inherits from and the ink the editor's
-- canvas effects are given, so getting it wrong shows a dark theme with light
-- effects.

INSERT INTO custom_themes (theme_id, name, tokens_json, mode) VALUES
${rows};
`

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'migrations', '0004_curated_themes.sql')
writeFileSync(target, migration)
console.log(`\nWrote ${target}`)
