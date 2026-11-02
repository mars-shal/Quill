import { BUNDLED_TEXTURES, textureUrl } from '../platform/store.js'

/**
 * Re-exported so the appearance modules have one import surface.
 *
 * `textureUrl` is a display concern, not a settings one; it lives in the store
 * beside the list it reads. Everything that asks "is this a bundled texture" is
 * appearance code, and three modules importing the store directly to ask the
 * same question is the point at which the list belongs in its own module.
 */
export { textureUrl }

/**
 * P4-2, P4-3, P4-4: the reader's own backgrounds.
 *
 * These are pure functions on purpose. Everything here decides what a string
 * looks like before it reaches the DOM, so each rule can be tested without a
 * browser, and `main.jsx` stays a place that applies values rather than
 * validates them.
 *
 * The validation mirrors `settings.rs::clamp_image_data` and `images.rs`. That is
 * duplication, and it is deliberate: the browser build has no Rust to ask, and
 * the Tauri build's settings row is a JSON blob that anything can write. Two
 * sides that both refuse a `file://` URL and an oversized payload is a
 * property, not a copy-paste mistake to be factored out later.
 */

/** The 4 MB cap from `settings.rs::MAX_IMAGE_DATA_BYTES`, as a data-URL length. */
export const MAX_IMAGE_DATA_BYTES = 4 * 1024 * 1024

/**
 * True for a `data:` URL holding an image and no larger than the cap.
 *
 * `data:image/` and a length check, not a real decode. Decoding a 4 MB image in
 * the render path to find out it is truncated would be work on every repaint,
 * and the failure it guards against is already handled: a broken image paints
 * nothing over the surface, so the reader sees the flat colour they started
 * from.
 */
export function isUsableImageData(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed.startsWith('data:image/')) return false
  return trimmed.length <= MAX_IMAGE_DATA_BYTES
}

/**
 * The veil each mode gets when the reader has not chosen one.
 *
 * The veil is the theme's own surface laid over the texture, and how much of it
 * is needed depends on which way the text runs. A dark theme keeps its contrast
 * over a mid-grey texture at 14%, because near-white text on 19-grey is still
 * 16:1. A light theme does not: its darkest text is 4.5:1 on white and about
 * 3.4:1 on the 225-grey a 14% veil leaves behind, so the same number would ship
 * a failure the reader did not cause and cannot see the cause of.
 *
 * Measured, not guessed -- these are the values at which the composited gate
 * comes back clean for a texture whose dark end is the 8th percentile a typical
 * photograph has.
 */
export const DEFAULT_WASH = { light: 0.05, dark: 0.14 }

/** The veil for a mode, from a stored value or the mode's default. */
export function resolveTextureWash(mode, stored) {
  const base = mode === 'dark' ? DEFAULT_WASH.dark : DEFAULT_WASH.light
  // `Number(null)` and `Number('')` are both 0, so a stored null -- which means
  // "follow the theme" -- would arrive here as a deliberate zero and every light
  // theme would get no veil at all. The empty cases are named before the number
  // is coerced.
  if (stored === null || stored === undefined || stored === '') return base
  const value = Number(stored)
  if (!Number.isFinite(value)) return base
  return Math.min(0.6, Math.max(0, value))
}

/** Clamps a percentage to 0-100, for the two sliders. */
export function clampPercent(value, fallback = 100) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(100, Math.max(0, Math.round(number)))
}

/**
 * The floor for panel opacity, and the only way a panel opacity should be read.
 *
 * 60% is not an aesthetic preference. The three `--surface-*` colours are what
 * the library, the editor and the assistant panel are painted with, and below
 * about 60% a *bright* photograph shows through strongly enough to turn a dark
 * theme's panels into pale grey. That is not a subtle wash: it is the app
 * appearing to render in the wrong theme, with the panels lighter than the text
 * on them and the composited contrast gate reporting failures the reader cannot
 * act on without understanding what a "panel opacity" is.
 *
 * It lives here rather than as a `min` on the slider, because the slider is only
 * one way a value arrives. A settings row written by an older build, or hand-
 * edited, arrives with whatever it arrives with -- and the failure is invisible
 * until someone opens the app on a bright wallpaper.
 *
 * The account chip is the tell: it paints `--main` rather than `--surface`, so it
 * stays opaque while the sidebar beside it goes pale. A sidebar and a chip in the
 * same panel at different brightnesses is what this floor exists to prevent.
 */
export const PANEL_ALPHA_FLOOR = 60

export function panelAlpha(value) {
  return Math.max(PANEL_ALPHA_FLOOR, clampPercent(value, 100))
}

/**
 * The value for `--editor-texture`, or null when there is no texture.
 *
 * A bundled id wins over a reader's own image, and the two are mutually
 * exclusive: setting a bundled texture clears the picked image rather than
 * layering them, because "Paper grain" in a row next to a photo is ambiguous
 * about which one the reader is looking at.
 */
export function editorTextureValue({ editorTexture = '', editorTextureData = '' } = {}) {
  const bundled = textureUrl(editorTexture)
  if (bundled) return `url("${bundled}")`
  if (isUsableImageData(editorTextureData)) return `url("${editorTextureData.trim()}")`
  return null
}

/**
 * Every custom property the backgrounds need, or null when none apply.
 *
 * Null rather than an object of defaults so the applier can write nothing at
 * all in the common case. Writing `--surface-alpha-pct: 100%` onto <html> for a
 * reader who never picked a wallpaper is harmless but not free: it pins a value
 * that the stylesheet is supposed to own, and the next person to change the
 * default has to find this file.
 */
export function backgroundProperties(settings = {}, { mode = 'light' } = {}) {
  const texture = editorTextureValue(settings)
  const wallpaper = isUsableImageData(settings.wallpaper) ? settings.wallpaper.trim() : null

  if (!texture && !wallpaper) return null

  const properties = {}
  if (texture) {
    properties['--editor-texture'] = texture
    // Written even when the reader has never touched the slider, because the
    // mode's default is a real value the stylesheet's 0.14 is not: a light
    // theme's 0.14 is a contrast failure waiting to happen.
    properties['--editor-texture-wash'] = String(resolveTextureWash(mode, settings.textureWash))
  }
  if (wallpaper) {
    // Translucency only means something with something behind it. Applying
    // --surface-alpha without a wallpaper would make the panels translucent
    // over <body>, whose background is the theme's --backdrop: a real change to
    // how the app looks, requested by a setting the reader cannot see the
    // effect of.
    const alpha = panelAlpha(settings.surfaceAlpha)

    // At 100% the wallpaper is painted and then completely covered: both
    // `.library-layout` and `.editor-shell` fill with `--surface`, which at 100%
    // is opaque `--main`. So a reader at full opacity was paying a viewport-sized
    // decode and paint of a multi-megabyte photograph for an image not one pixel
    // of which reaches the screen. It is only written when the panels are
    // actually translucent, which is the only case where it can be seen.
    //
    // The stored value is untouched -- this is purely about whether the pixels get
    // drawn -- so moving the slider back to 100% hides the wallpaper again, which
    // is what a reader who cannot see it would expect anyway.
    if (alpha < 100) {
      properties['--wallpaper'] = `url("${wallpaper}")`
      // A dim is a black overlay at this strength, so 0 leaves the image at full
      // brightness rather than painting `rgba(0,0,0,0)`, which composites to
      // nothing but still costs the compositor a layer.
      const scrim = clampPercent(settings.scrim, 0)
      if (scrim > 0) properties['--wallpaper-dim'] = String(scrim / 100)
      properties['--surface-alpha'] = String(alpha / 100)
      properties['--surface-alpha-pct'] = `${alpha}%`
    }
  }
  return properties
}
