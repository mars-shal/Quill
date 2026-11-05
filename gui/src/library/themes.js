/**
 * Theme resolution.
 *
 * `settings.theme` holds either a built-in id or a custom one from
 * `custom_themes`, and nothing in the frontend used to care: the app wrote
 * `data-theme` and hoped a CSS block matched. An unknown id therefore produced
 * a half-broken state -- `--border-strong` and `--prose-surface` undefined,
 * `color-scheme` still `light`, and the canvas effects on their light palette.
 *
 * The token objects below are the reason this file exists. The three CSS blocks
 * are not uniform -- `light` overrides 26 declarations, `paper` 25, `night` 31
 * -- so a custom theme that inherited from `:root` would pick up the light
 * `--accent` and the light shadows even when its own `mode` is `dark`. Each
 * built-in here is therefore its *effective* set, `:root` merged with its block,
 * which is what the cascade produces. `themes.test.mjs` asserts that against
 * the stylesheet, so a token edited in one place and not the other fails.
 *
 * Values are kept as written, never pre-flattened. `--accent-hover` is a
 * `color-mix()` over `var(--accent)`, and a custom property resolves its
 * `var()` at use time, so writing the expression inline is what lets a custom
 * `--accent` flow into the hover shade. Flattening it here would freeze the
 * light theme's blue into every custom dark theme.
 */

import { REQUIRED_PAIRS } from './contrast.js'

/**
 * Tokens that are not part of a theme's colour scheme.
 *
 * `--reading-font` is written inline by the reading-font setting, so a token
 * applier that also wrote it would fight that effect on every settings change;
 * the other two are identical in every theme. `:root` declares all three, so a
 * custom theme that skips them still resolves them.
 */
export const NON_COLOUR_TOKENS = ['--ease', '--mono', '--reading-font']

/** The three themes that ship with the app. */
export const BUILT_IN_THEMES = {
  light: {
    name: 'Light',
    mode: 'light',
    tokens: {
      '--main': '#F9F9F9',
      '--sidebar': '#F1F1F1',
      '--chat': '#FCFCFC',
      '--backdrop': '#E9E9E9',
      '--text-1': '#0F0F0F',
      '--text-2': '#4B5563',
      '--text-3': '#5F6672',
      '--prose': '#0F0F0F',
      '--accent': '#1A1A1A',
      '--accent-soft': 'rgba(26, 26, 26, 0.10)',
      '--border': 'rgba(26, 26, 26, 0.10)',
      '--border-strong': 'rgba(26, 26, 26, 0.24)',
      '--hover': 'rgba(26, 26, 26, 0.05)',
      '--active': 'rgba(26, 26, 26, 0.09)',
      '--selection': 'rgba(26, 26, 26, 0.18)',
      '--publish': '#2B7D4F',
      '--publish-hover': '#266E46',
      '--scrollbar-thumb': 'rgba(0, 0, 0, 0.16)',
      '--backdrop-gradient': 'radial-gradient(ellipse 55% 34% at 50% 8%, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0) 72%), linear-gradient(180deg, #efefef, #e9e9e9 53%, #e2e2e2)',
      '--scrim': 'rgba(16, 22, 38, 0.46)',
      '--brand-filter': 'none',
      '--accent-hover': 'color-mix(in srgb, var(--accent) 88%, #000)',
      '--highlight-bg': '#E5E7EB',
      '--highlight-ink': '#0F0F0F',
      '--focus-ring': 'rgba(26, 26, 26, 0.62)',
      '--danger': '#B3261E',
      '--on-accent': '#F9F9F9',
      '--on-publish': '#FFFFFF',
      '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.06), 0 3px 8px -3px rgba(0, 0, 0, 0.08)',
      '--shadow-2': '0 8px 28px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08)',
      '--shadow-3': '0 40px 90px -25px rgba(20, 30, 50, 0.28)',
    },
  },
  paper: {
    name: 'Paper',
    mode: 'light',
    tokens: {
      '--main': '#fbfaf7',
      '--sidebar': '#f2f0eb',
      '--chat': '#f8f7f2',
      '--backdrop': '#e5e3dd',
      '--text-1': '#22201d',
      '--text-2': '#67635b',
      '--text-3': '#69625a',
      '--prose': '#36332e',
      '--accent': '#2b5fd4',
      '--accent-soft': 'rgba(43, 95, 212, 0.14)',
      '--border': 'rgba(35, 30, 22, 0.1)',
      '--border-strong': 'rgba(35, 30, 22, 0.24)',
      '--hover': 'rgba(35, 30, 22, 0.05)',
      '--active': 'rgba(35, 30, 22, 0.08)',
      '--selection': 'rgba(43, 95, 212, 0.22)',
      '--publish': '#2b7d4f',
      '--publish-hover': '#266e46',
      '--scrollbar-thumb': 'rgba(0, 0, 0, 0.16)',
      '--backdrop-gradient': 'radial-gradient(ellipse 55% 34% at 50% 8%, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0) 72%), linear-gradient(180deg, #ece9e2, #e5e1d9 53%, #dfdbd2)',
      '--scrim': 'rgba(16, 22, 38, 0.46)',
      '--brand-filter': 'none',
      '--accent-hover': 'color-mix(in srgb, var(--accent) 88%, #000)',
      '--highlight-bg': '#f6e9a8',
      '--highlight-ink': '#262320',
      '--focus-ring': 'rgba(43, 95, 212, 0.75)',
      '--danger': '#b3261e',
      '--on-accent': '#ffffff',
      '--on-publish': '#ffffff',
      '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.06), 0 3px 8px -3px rgba(0, 0, 0, 0.08)',
      '--shadow-2': '0 8px 28px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08)',
      '--shadow-3': '0 40px 90px -25px rgba(20, 30, 50, 0.28)',
    },
  },
  night: {
    name: 'Dark',
    mode: 'dark',
    tokens: {
      '--main': '#1A1A1A',
      '--sidebar': '#0F0F0F',
      '--chat': '#181818',
      '--backdrop': '#0A0A0A',
      '--text-1': '#F9F9F9',
      '--text-2': '#D1D5DB',
      '--text-3': '#9CA3AF',
      '--prose': '#F1F1F1',
      '--accent': '#F9F9F9',
      '--accent-soft': 'rgba(249, 249, 249, 0.12)',
      '--border': 'rgba(249, 249, 249, 0.14)',
      '--border-strong': 'rgba(249, 249, 249, 0.32)',
      '--hover': 'rgba(249, 249, 249, 0.07)',
      '--active': 'rgba(249, 249, 249, 0.12)',
      '--selection': 'rgba(249, 249, 249, 0.22)',
      '--publish': '#52B788',
      '--publish-hover': '#63C496',
      '--scrollbar-thumb': 'rgba(255, 255, 255, 0.18)',
      '--backdrop-gradient': 'radial-gradient(ellipse 55% 34% at 50% 8%, rgba(48, 48, 48, 0.6), rgba(10, 10, 10, 0) 72%), linear-gradient(180deg, #151515, #0A0A0A 56%, #060606)',
      '--scrim': 'rgba(16, 22, 38, 0.46)',
      '--brand-filter': 'invert(1)',
      '--accent-hover': 'color-mix(in srgb, var(--accent) 88%, #000)',
      '--highlight-bg': '#E5E7EB',
      '--highlight-ink': '#0F0F0F',
      '--focus-ring': 'rgba(249, 249, 249, 0.62)',
      '--danger': '#FF8A80',
      '--on-accent': '#1A1A1A',
      '--on-publish': '#0D1117',
      '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.35)',
      '--shadow-2': '0 8px 24px rgba(0, 0, 0, 0.45)',
      '--shadow-3': '0 40px 90px -25px rgba(0, 0, 0, 0.7)',
      '--brand-filter-opacity': '0.94',
    },
  },
}

/** The built-in ids, in the order the picker shows them. */
export const THEME_IDS = Object.keys(BUILT_IN_THEMES)

/**
 * Which built-in a custom theme of a given mode inherits from.
 *
 * Not `:root`, and not "light": `:root` is a light palette, so a custom dark
 * theme starting from it would carry light shadows, a light scrollbar thumb
 * and `none` for the wordmark inversion -- the failure the `data-mode` split in
 * the stylesheet was introduced to prevent.
 */
const BASE_FOR_MODE = { light: 'light', dark: 'night' }

/**
 * Tokens every resolved theme has to define.
 *
 * This is the set the CSS blocks are checked against, plus the two surfaces the
 * editor and the assistant panel paint. A custom theme that omitted one would
 * leave a `var()` unresolved, which renders as an inherited or initial value
 * rather than an error, so it has to be refused at save time.
 */
const CORE_TOKENS = [
  '--main',
  '--sidebar',
  '--chat',
  '--backdrop',
  '--text-1',
  '--text-2',
  '--text-3',
  '--prose',
  '--accent',
  '--border',
  '--border-strong',
]

/**
 * The tokens a theme has to define before it can be applied.
 *
 * The core list is the palette the stylesheet lays down for a surface, and it is
 * augmented with every token `contrast.js` measures. Deriving that second part
 * from the pairs instead of repeating it is the point: a token the contrast
 * check needs but this list omits would let `missingTokens` pass a theme that
 * the check then rejected, which is the two-sources-of-truth problem this file
 * exists to remove.
 *
 * `--backdrop`, `--border` and `--border-strong` are required but unmeasured.
 * They have to exist for a surface to look like a surface, and a 1px border is a
 * design judgement rather than a legibility floor.
 */
export const REQUIRED_TOKENS = [
  ...CORE_TOKENS,
  // A Set because a token can be both a foreground and a background -- `--danger`
  // is checked against `--main` and against `--sidebar` -- and a duplicate in the
  // required list would show up twice in every "missing tokens" message.
  ...[...new Set(REQUIRED_PAIRS.flatMap(([, fg, , bg]) => [fg, bg].filter(Boolean)))]
    .filter((name) => !CORE_TOKENS.includes(name))
    .sort(),
]

/** Every token name the applier is allowed to write. */
const WRITABLE = new Set([
  ...REQUIRED_TOKENS,
  '--accent-soft',
  '--selection',
  '--hover',
  '--active',
  '--publish',
  '--publish-hover',
  '--on-accent',
  '--on-publish',
  '--danger',
  '--focus-ring',
  '--highlight-bg',
  '--highlight-ink',
  '--scrollbar-thumb',
  '--backdrop-gradient',
  '--scrim',
  '--brand-filter',
  '--brand-filter-opacity',
  '--shadow-1',
  '--shadow-2',
  '--shadow-3',
  '--accent-hover',
])

/**
 * A theme as the app needs it: an id for `data-theme`, a mode for `data-mode`,
 * and the complete token set to paint.
 *
 * `custom` is what decides where the tokens come from. A built-in is painted by
 * its own CSS block, so the applier writes nothing for it. A custom theme has
 * no block -- `data-theme="midnight"` matches no rule -- so the applier writes
 * its resolved set inline, where it outranks both `:root` and any block.
 */
function theme(id, name, mode, tokens, custom) {
  return { id, name, mode, tokens, custom }
}

/**
 * Resolves `settings.theme` to something paintable.
 *
 * An id that is neither a built-in nor a stored custom theme falls back to
 * `light`, and says so. The alternative -- returning nothing and letting the
 * caller write a partial set -- is the undefined-token state this function
 * exists to remove.
 *
 * `customThemes` is the list from `listCustomThemes()`; it is an argument rather
 * than a store call so resolution stays pure and testable without IPC.
 */
export function resolveTheme(themeId, customThemes = []) {
  const id = typeof themeId === 'string' ? themeId : ''
  const builtIn = BUILT_IN_THEMES[id]
  if (builtIn) return theme(id, builtIn.name, builtIn.mode, builtIn.tokens, false)

  const custom = (Array.isArray(customThemes) ? customThemes : []).find(
    (entry) => entry?.theme_id === id,
  )
  if (custom) {
    const mode = custom.mode === 'dark' ? 'dark' : 'light'
    const base = BUILT_IN_THEMES[BASE_FOR_MODE[mode]]
    // The base first, the custom tokens over it. The result is a complete set,
    // so the applier never has to know which of the tokens were inherited.
    return theme(id, custom.name || id, mode, { ...base.tokens, ...tokenSubset(custom.tokens) }, true)
  }

  return theme('light', BUILT_IN_THEMES.light.name, 'light', BUILT_IN_THEMES.light.tokens, false)
}

/**
 * The tokens of a custom theme that the applier will write.
 *
 * Filtered to a known list on purpose: `tokens_json` is arbitrary JSON from
 * SQLite, and writing an unrecognised name onto `documentElement` would either
 * be dead weight or, for a name that happens to collide with one of the app's
 * own custom properties, a hole in the theme.
 */
function tokenSubset(tokens) {
  const out = {}
  if (!tokens || typeof tokens !== 'object') return out
  for (const [rawName, value] of Object.entries(tokens)) {
    const name = rawName.trim()
    // Both halves are trimmed. A stored key with a stray space is dropped
    // silently otherwise, and the reader sees a theme that saved and changed
    // nothing -- the one failure the picker cannot explain.
    if (WRITABLE.has(name) && typeof value === 'string' && value.trim()) out[name] = value.trim()
  }
  return out
}

/** The required tokens a theme is missing, as CSS names. */
export function missingTokens(tokens) {
  const present = tokens && typeof tokens === 'object' ? tokens : {}
  return REQUIRED_TOKENS.filter((name) => {
    const value = present[name]
    return typeof value !== 'string' || !value.trim()
  })
}
