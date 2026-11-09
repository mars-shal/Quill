/**
 * WCAG contrast, and the pairs a theme has to satisfy.
 *
 * This was a copy of `scripts/check-contrast.mjs` before Phase 3's picker needed
 * to check a theme the reader has just authored, and a second implementation
 * would have been the exact drift the script's own header complains about: the
 * palette it checks would be the palette it enforces, and neither would be the
 * one that renders. The script imports these functions instead, so there is one
 * set of arithmetic and one table of thresholds.
 *
 * The important property is that an unmeasurable value is `null`, never a
 * number. `checkTokens` treats `null` as a failure, and it has to: a check that
 * silently drops a pair it could not measure is a check that reports a theme as
 * accessible when part of it was never looked at. The forms this module cannot
 * measure -- `color-mix()`, a bare keyword, an unparseable string -- are exactly
 * the ones that would otherwise slip through.
 */

/**
 * Parses a colour into `[r, g, b]`, or returns null when it is not a colour
 * this module can measure.
 */
export function parseColor(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (!text) return null

  const hex = text.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    const digits = hex[1]
    const expand = (part) => (part.length === 1 ? part + part : part)
    if (digits.length === 3) return [expand(digits[0]), expand(digits[1]), expand(digits[2])].map((pair) => parseInt(pair, 16))
    if (digits.length === 4) return [expand(digits[0]), expand(digits[1]), expand(digits[2])].map((pair) => parseInt(pair, 16))
    if (digits.length === 6) return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16))
    if (digits.length === 8) return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16))
    return null
  }

  // rgb()/rgba(), comma or space separated, with an optional alpha we ignore.
  const rgb = text.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const channels = parts.slice(0, 3).map((part) => (part.endsWith('%') ? Math.round((parseFloat(part) / 100) * 255) : parseFloat(part)))
    if (channels.some((channel) => !Number.isFinite(channel))) return null
    return channels.map((channel) => Math.max(0, Math.min(255, channel)))
  }

  // hsl()/hsla(), which the tag palette uses.
  const hsl = text.match(/^hsla?\(([^)]+)\)$/)
  if (hsl) {
    const parts = hsl[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const h = parseFloat(parts[0])
    const s = parseFloat(parts[1]) / 100
    const l = parseFloat(parts[2]) / 100
    if (![h, s, l].every(Number.isFinite)) return null
    return hslToRgb(h, s, l)
  }

  return null
}

const hslToRgb = (h, s, l) => {
  const sat = (1 - Math.abs(2 * l - 1)) * s
  const hue = (((h % 360) + 360) % 360) / 60
  const x = sat * (1 - Math.abs((hue % 2) - 1))
  const [r, g, b] = hue < 1 ? [sat, x, 0]
    : hue < 2 ? [x, sat, 0]
      : hue < 3 ? [0, sat, x]
        : hue < 4 ? [0, x, sat]
          : hue < 5 ? [x, 0, sat]
            : [sat, 0, x]
  const offset = l - sat / 2
  return [r, g, b].map((channel) => Math.round((channel + offset) * 255))
}

const srgbToLinear = (channel) => {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * Relative luminance of a colour, or null if the value cannot be parsed.
 */
export function luminance(value) {
  const channels = parseColor(value)
  if (!channels) return null
  const [r, g, b] = channels.map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The WCAG contrast ratio between two colours, or null when either cannot be
 * parsed. An alpha-composited value has to be flattened first, which is why
 * `rgba(0, 0, 0, 0.16)` alone is not a background you can measure.
 */
export function contrast(foreground, background) {
  const l1 = luminance(foreground)
  const l2 = luminance(background)
  if (l1 === null || l2 === null) return null
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The more legible of two inks on a filled surface.
 *
 * Filled controls used to assume `--on-accent` was correct for every theme.
 * When a custom theme changed `--accent` but inherited the light theme's ink,
 * the label could become black on a dark accent -- or vanish into the surface
 * the button was drawn on. This chooses by measured contrast, so the label
 * follows the fill rather than the theme's mode.
 *
 * Returns null when the fill cannot be measured (a `color-mix()`, a bare
 * keyword), which lets the caller keep the theme's own token.
 */
export function readableInk(background, dark = '#0F0F0F', light = '#F9F9F9') {
  const darkRatio = contrast(dark, background)
  const lightRatio = contrast(light, background)
  if (darkRatio === null || lightRatio === null) return null
  return darkRatio >= lightRatio ? dark : light
}

/**
 * Flattens a translucent colour over an opaque one.
 *
 * The palette uses translucent tokens heavily (`--border`, `--hover`,
 * `--selection`), so a real background has to be resolved before it can serve
 * as a measurement surface.
 */
export function composite(color, backdrop) {
  const base = parseColor(backdrop)
  if (!base) return null
  const text = String(color).trim().toLowerCase()
  const alpha = text.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[\s,/]+/).filter(Boolean)[3]
  const source = parseColor(text)
  if (!source) return null
  const opacity = alpha === undefined ? 1 : parseFloat(alpha.endsWith('%') ? alpha : alpha)
  if (!Number.isFinite(opacity)) return null
  const a = Math.max(0, Math.min(1, opacity))
  return source.map((channel, i) => Math.round(channel * a + base[i] * (1 - a)))
}

/**
 * Mixes two opaque colours by an explicit weight.
 *
 * `composite` above cannot do this job. It reads the alpha out of the colour
 * string, which is right for `rgba(--border-like, 0.08)` and useless here: a
 * surface token that has already been flattened to an opaque `rgb()` carries no
 * alpha, and `--surface-alpha` is a separate value that the colour knows
 * nothing about. Two functions rather than one with a nullable third argument,
 * because the two callers have genuinely different inputs and merging them
 * would put a `null` alpha in the signature of the function the whole theme
 * system already depends on.
 *
 * Channels are mixed in sRGB, matching `color-mix(in srgb, ...)` in the
 * stylesheet. Linear-light mixing would be more physically correct and would not
 * match what the browser paints, and a contrast gate that measures a colour the
 * reader cannot see is worse than one that is a rounding step conservative.
 */
export function mix(top, bottom, alpha) {
  const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1))
  const parsedTop = Array.isArray(top) ? top : parseColor(top)
  const parsedBottom = Array.isArray(bottom) ? bottom : parseColor(bottom)
  if (!parsedTop || !parsedBottom) return null
  return parsedTop.map((channel, i) => Math.round(channel * a + parsedBottom[i] * (1 - a)))
}

/** Reads a token from either a plain object or a `Map`, as the two callers differ. */
function lookup(tokens, name) {
  if (!tokens) return undefined
  if (typeof tokens.get === 'function') return tokens.get(name)
  return tokens[name]
}

/** A theme's token, flattened over the surface it is measured against. */
export function flattenToken(tokens, name, surface) {
  const value = lookup(tokens, name)
  if (value === undefined || value === null) return null
  if (String(value).startsWith('var(')) {
    // A `var()` that points at a token the theme does not define is exactly the
    // undefined-token state this check exists to catch, so it must not resolve.
    const referenced = String(value).slice(4, value.indexOf(')')).trim()
    if (referenced === name) return null
    return flattenToken(tokens, referenced, surface)
  }
  const flat = composite(value, surface)
  return flat ? `rgb(${flat.join(', ')})` : null
}

/**
 * The pairs a theme has to satisfy, as `[label, foregroundToken, minimum, backgroundToken?]`.
 *
 * This is the union of every per-theme suite in `check-contrast.mjs`, so a
 * reader-authored theme is held to the strongest set the built-in themes are
 * held to. The background defaults to the theme's `--main`.
 *
 * 4.5:1 for anything that carries text; 3:1 for the focus ring, which is a
 * non-text indicator. The focus ring is deliberately 3 rather than 4.5: a ring
 * at 4.5 reads as a second border, and a bright ring on a dark surface can
 * exceed 4.5 while being useless on a light one.
 */
export const REQUIRED_PAIRS = [
  ['text-1', '--text-1', 4.5],
  ['text-2', '--text-2', 4.5],
  ['text-3', '--text-3', 4.5],
  ['text-3 on sidebar', '--text-3', 4.5, '--sidebar'],
  ['text-2 on sidebar', '--text-2', 4.5, '--sidebar'],
  ['text-3 on chat', '--text-3', 4.5, '--chat'],
  ['prose', '--prose', 4.5],
  ['accent (links)', '--accent', 4.5],
  ['accent on sidebar', '--accent', 4.5, '--sidebar'],
  ['on-accent on accent', '--on-accent', 4.5, '--accent'],
  ['on-publish on publish', '--on-publish', 4.5, '--publish'],
  ['danger', '--danger', 4.5],
  ['danger on sidebar', '--danger', 4.5, '--sidebar'],
  ['highlight ink', '--highlight-ink', 4.5, '--highlight-bg'],
  ['accent focus ring', '--focus-ring', 3, '--main'],
]

/**
 * One translucent layer between a surface and whatever is behind it.
 *
 * P4-4 makes three of these possible: the three panel surfaces at
 * `--surface-alpha` over a wallpaper, and the editor page's veil at
 * `--editor-texture-wash` over a texture. A reader with both a wallpaper and a
 * texture gets two layers on `--main` at once, so a layer is one entry in a
 * stack rather than a single value.
 *
 * `alpha` is the layer's own opacity, not the alpha of its colour: 1 means the
 * layer hides what is behind it. `backdrops` is every colour that can show
 * through it, or null when that is not known -- which is a real state, because
 * the textures that ship with the build are 5%-black SVGs with no image to
 * sample, and a gate that assumed white for them would be measuring a surface
 * the reader never sees.
 *
 * `base` is the layer's own opaque colour. It defaults to the surface token,
 * which is right when the veil is the theme's `--main` over a texture and wrong
 * the moment a layer is a different colour, so it is settable.
 */
export function surfaceOverlay(token, alpha, backdrops, base) {
  const safeAlpha = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1
  return {
    token,
    alpha: safeAlpha,
    backdrops: Array.isArray(backdrops) ? backdrops.filter(Boolean) : null,
    base: base || token,
    name: token,
  }
}

/**
 * Paints a stack of layers over a backdrop, bottom-most first.
 *
 * `layers` is ordered as the reader's stack is: index 0 is nearest the reader.
 * The order matters and getting it wrong is silent -- a veil composited under
 * the surface it covers is invisible, and a translucent panel composited over
 * its own veil hides the veil. So this walks from the end, which is the layer
 * closest to the backdrop, up to the front.
 *
 * Returns null when any layer has no measurable colour, because a partial stack
 * is not a colour the reader would see.
 */
export function paintStack(layers, backdrop) {
  let colour = typeof backdrop === 'string' ? parseColor(backdrop) : backdrop
  if (!colour) return null
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i]
    if (!layer) return null
    const base = typeof layer.base === 'string' ? parseColor(layer.base) : layer.base
    if (!base) return null
    colour = mix(base, colour, layer.alpha)
  }
  return `rgb(${colour.join(', ')})`
}

/**
 * The backdrops a stack can actually show.
 *
 * The topmost translucent layer with known backdrops decides the range, and
 * everything below it only matters to the extent the layer above is not opaque.
 * An opaque top layer short-circuits, which is what makes a wallpaper invisible
 * to a text colour drawn on an opaque chip: the chip is opaque, so the chip's
 * own colour is the whole answer.
 */
export function stackBackdrops(layers) {
  for (const layer of layers) {
    if (layer.alpha >= 1) continue
    if (layer.backdrops && layer.backdrops.length) return layer.backdrops
  }
  return null
}

export function checkTokens(tokens, pairs = REQUIRED_PAIRS, overlays = []) {
  const failures = []
  const main = lookup(tokens, '--main')
  const surface = flattenToken(tokens, '--main', '#ffffff')
  if (!surface) {
    return [{ label: 'surface', need: 0, fg: '--main', bg: '--main', ratio: null, why: 'no measurable --main surface' }]
  }
  // Layers are grouped per token and kept in the order they were given, because
  // a pair naming `--main` has to see the page veil above the panel even when a
  // wallpaper set the panel up first.
  const stacks = new Map()
  for (const overlay of overlays || []) {
    if (!overlay) continue
    const layer = { ...overlay, base: typeof overlay.base === 'string' && overlay.base.startsWith('--') ? flattenToken(tokens, overlay.base, '#ffffff') : overlay.base }
    if (!stacks.has(overlay.token)) stacks.set(overlay.token, [])
    stacks.get(overlay.token).push(layer)
  }
  for (const [label, fgToken, need, bgToken = '--main'] of pairs) {
    const baseBackground = flattenToken(tokens, bgToken, lookup(tokens, '--main') || '#ffffff')
    const foreground = flattenToken(tokens, fgToken, lookup(tokens, '--main') || '#ffffff')
    const backdrops = stackBackdrops(stacks.get(bgToken) || [])
    if (!backdrops) {
      const ratio = foreground === null || baseBackground === null ? null : contrast(foreground, baseBackground)
      if (ratio === null || ratio < need) {
        failures.push({ label, need, fg: fgToken, bg: bgToken, ratio, surface: main })
      }
      continue
    }
    // The worst backdrop wins, and the failure names which end of the image it
    // was. "prose is 3.1:1" is not actionable when the reader can see the
    // problem is only in one corner of the photo they chose.
    let worst = null
    for (const backdrop of backdrops) {
      const painted = paintStack(stacks.get(bgToken), backdrop)
      if (painted === null || foreground === null) {
        worst = { ratio: null, backdrop: null, painted: null }
        break
      }
      const ratio = contrast(foreground, painted)
      if (worst === null || (ratio !== null && (worst.ratio === null || ratio < worst.ratio))) {
        worst = { ratio, backdrop, painted }
      }
    }
    if (worst === null || worst.ratio === null || worst.ratio < need) {
      failures.push({
        label,
        need,
        fg: fgToken,
        bg: bgToken,
        ratio: worst ? worst.ratio : null,
        surface: main,
        backdrop: worst ? worst.backdrop : null,
        painted: worst ? worst.painted : null,
        why: worst && worst.backdrop ? 'over part of the reader\'s image' : undefined,
      })
    }
  }
  return failures
}

/**
 * Names which end of a backdrop range a failure is at.
 *
 * A hex string is what the settings dialog shows, because a reader who can see
 * the swatch next to the sentence does not have to guess which part of their
 * photo the sentence means. "Light" and "dark" are the reader-facing words; the
 * value is kept for the tooltip.
 */
function describeBackdrop(backdrop) {
  const rgb = Array.isArray(backdrop) ? backdrop : parseColor(backdrop)
  if (!rgb) return 'edge'
  const hex = `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  return luminance(hex) >= 0.18 ? 'light' : 'dark'
}

/** The failures as the sentences the settings dialog shows next to a knob. */
export function describeFailure(failure) {
  if (failure.ratio === null) {
    return `${failure.fg} on ${failure.bg} could not be measured`
  }
  const over = failure.backdrop ? ` over the ${describeBackdrop(failure.backdrop)} of your image` : ''
  return `${failure.fg} on ${failure.bg}${over} is ${failure.ratio.toFixed(2)}:1, needs ${failure.need}:1`
}
