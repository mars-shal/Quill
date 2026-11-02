import { luminance, mix, surfaceOverlay } from './contrast.js'
import { isUsableImageData, textureUrl } from './backgrounds.js'

/**
 * P4-4: what is actually behind the text once a reader's own image is in place.
 *
 * The gate needs a backdrop colour. A photograph does not have one -- it has a
 * distribution, and text only has to survive the worst part of it. So this
 * reduces an image to the two ends of that distribution: a representative light
 * colour and a representative dark one, from the pixels the reader will
 * actually see.
 *
 * Two, not a mean. A mean is the one number a real photograph never has: a
 * sunset with a black foreground and a white sky averages to mid-grey, and
 * mid-grey is exactly the colour that fails every contrast requirement, so an
 * average would report a problem the reader cannot see and miss two they can.
 */

/** The side length of the throwaway canvas. 48 is enough to find both ends. */
const SAMPLE_SIZE = 48

/**
 * The two representative colours from a flat array of `[r, g, b, a]` pixels.
 *
 * Pure, so it can be tested with synthetic pixels. Returns hex strings, or null
 * for an image with nothing to sample -- a fully transparent PNG, which the
 * caller treats as "no image" rather than as "black".
 *
 * `percentile` is 0.08 and 0.92 rather than 0 and 1: the very brightest pixel is
 * usually a specular highlight, and holding the whole palette to that one pixel
 * makes an ordinary photograph fail a gate that exists to catch unreadable
 * text, not to reject a bright sky.
 */
export function extremeBackdrops(pixels, percentile = 0.08) {
  const opaque = []
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    // A transparent pixel's stored RGB is whatever the encoder left there, not
    // what the reader sees, so it is excluded rather than mixed in.
    if (pixels[i + 3] < 128) continue
    opaque.push([pixels[i], pixels[i + 1], pixels[i + 2]])
  }
  if (!opaque.length) return null

  const sorted = [...opaque].sort((a, b) => luminance(`rgb(${a.join(',')})`) - luminance(`rgb(${b.join(',')})`))
  const at = (fraction) => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
    const [r, g, b] = sorted[index]
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
  const light = at(1 - percentile)
  const dark = at(percentile)
  return light === dark ? [light] : [light, dark]
}

/**
 * Samples a `data:` URL and returns its backdrops, or null.
 *
 * Null is returned for anything this cannot do: a URL the guard rejects, an image
 * the browser refuses to decode, or no canvas at all. Callers treat null as "no
 * backdrop known" and skip the composited check rather than inventing a colour,
 * because a gate that assumes white when it could not look is a gate that
 * passes.
 *
 * Browser-only, and the reason the pixel work is split out above: a Node test
 * has no `Image`, and a test that had to stub one would be testing the stub.
 */
export async function imageBackdrops(dataUrl) {
  if (!isUsableImageData(dataUrl)) return null
  if (typeof document === 'undefined') return null
  try {
    const image = await loadImage(dataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_SIZE
    canvas.height = SAMPLE_SIZE
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    // `cover` crop at a square, because that is how the wallpaper is painted.
    // Sampling a stretched image would report a colour the reader never sees.
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      SAMPLE_SIZE,
      SAMPLE_SIZE,
    )
    const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
    return extremeBackdrops(data)
  } catch {
    return null
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('the browser could not decode this image'))
    image.src = src
  })
}

/**
 * How much of --main the editor page lays over a texture.
 *
 * The inverse of `--editor-texture-wash`, and named as the layer's alpha because
 * that is what it is: a wash of 0.14 means 14% of the texture shows, so the veil
 * is the 0.86. Getting this backwards would make the default 14%-opaque --main
 * over the texture, which is a texture at 86% strength behind body text.
 */
export const DEFAULT_TEXTURE_WASH = 0.14

/**
 * The veil for a mode, for callers that have a theme and no reader override.
 * Re-exported so the picker and the applier cannot disagree about what the
 * default is; `backgrounds.js` is where it is decided.
 */
export { resolveTextureWash } from './backgrounds.js'

/**
 * The backdrops as they will actually be seen, once the dim is over them.
 *
 * The dim is a black overlay at `--scrim`, so a white region under a 60% dim
 * reaches the reader as 40% grey. Measuring the un-dimmed colour would have the
 * gate fail a wallpaper the reader has already made perfectly readable, and it
 * would be the worst kind of wrong: a failure with no way to clear it, because
 * the one control that fixes it is the one the gate is ignoring.
 *
 * A scrim of 0 returns the list unchanged, so the default path is identical to
 * having no dim at all.
 */
export function dimBackdrops(backdrops, scrim) {
  if (!Array.isArray(backdrops) || !backdrops.length) return backdrops
  const strength = Math.max(0, Math.min(1, Number.isFinite(scrim) ? scrim : 0))
  if (strength === 0) return backdrops
  return backdrops.map((colour) => {
    // `mix(top, bottom, alpha)` weights `top` by alpha, so the black overlay is
    // the bottom and the image is on top at `1 - strength`. The other order
    // gives 60% where 40% belongs, and the gate's verdicts invert with it.
    const mixed = mix(colour, '#000000', 1 - strength)
    return mixed ? `rgb(${mixed.join(', ')})` : colour
  })
}

/**
 * The translucent layers a reader's current background settings imply, in the
 * order the DOM stacks them: nearest the reader first.
 *
 * The single place that knows the correspondence between a setting and a
 * layer, so the save gate and any future preview cannot disagree about what is
 * on top of what.
 *
 * `wallpaperBackdrops` and `textureBackdrops` are what `imageBackdrops` returned,
 * or null when nothing could be sampled. A null means the layer is omitted
 * rather than checked against a guess.
 *
 * A bundled texture contributes no layer at all. It is drawn by us at about 5%
 * black over the surface, so its effect on contrast is a rounding step, and
 * inventing a backdrop for it would put a fake failure in front of the reader.
 */
export function backgroundOverlays(
  settings = {},
  { wallpaperBackdrops, textureBackdrops, alpha = 1, wash = DEFAULT_TEXTURE_WASH, scrim = 0 } = {},
) {
  const overlays = []
  // The dim is over the wallpaper, so the panels see the dimmed colour. The
  // texture is inside the page and the veil is over that, so the dim does not
  // reach it -- the texture is already behind a veil and is not the reader's
  // choice about legibility.
  // Order is the order the reader sees, nearest first, and it is the opposite of
  // the order these two things are configured in. The page's veil is painted on
  // `.editor-page`, which sits inside a panel, so the veil is in front of the
  // panel surface -- pushing it last would composite it underneath, where an
  // opaque panel hides it and the texture stops being measured at all.
  const picked = isUsableImageData(settings.editorTextureData)
  const bundled = Boolean(textureUrl(settings.editorTexture))
  const textured = picked && !bundled && Boolean(textureBackdrops && textureBackdrops.length)
  if (textured) {
    // The picked image is the only thing here that can be sampled, so it is also
    // the only thing that can contribute a texture backdrop -- and only while
    // nothing overrides it. A bundled id wins in `editorTextureValue` and in the
    // stylesheet, so measuring the picked image underneath it would describe a
    // surface the reader is not looking at.
    //
    // This layer takes `--main` to itself. The texture is the page's backdrop,
    // and the veil of `--main` goes over it. There is nothing further back to
    // composite with: a second `--main` layer in front of this one -- the panel
    // surface -- is opaque, so it would hide the veil and the texture would stop
    // being measured at all, which is the failure mode this comment exists to
    // prevent. The page and the panels are different surfaces; one of them owns
    // the token and the other two own theirs.
    overlays.push(surfaceOverlay('--main', 1 - wash, textureBackdrops))
  }
  const seen = dimBackdrops(wallpaperBackdrops, scrim)
  if (seen && seen.length) {
    for (const token of ['--main', '--sidebar', '--chat']) {
      // The page is either the veil or the panel, never both. When the texture
      // is in play the page is measuring itself and `--main` is already spoken
      // for; the wallpaper still reaches the reader through the two side panels.
      if (token === '--main' && textured) continue
      overlays.push(surfaceOverlay(token, alpha, seen))
    }
  }
  return overlays
}
