import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_WASH,
  MAX_IMAGE_DATA_BYTES,
  backgroundProperties,
  clampPercent,
  editorTextureValue,
  isUsableImageData,
  resolveTextureWash,
} from '../src/library/backgrounds.js'
import { DEFAULT_TEXTURE_WASH, backgroundOverlays, dimBackdrops, extremeBackdrops } from '../src/library/image-metrics.js'
import { BUNDLED_TEXTURES, defaultSettings, textureUrl } from '../src/platform/store.js'
import { checkTokens, describeFailure, mix, paintStack, REQUIRED_PAIRS, stackBackdrops, surfaceOverlay } from '../src/library/contrast.js'
import { resolveTheme, THEME_IDS } from '../src/library/themes.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const WEBP = 'data:image/webp;base64,UklGRhIAAABXRUJQ'

test('the veil follows the theme until the reader says otherwise', () => {
  // The values are measured, not chosen: a dark theme keeps its contrast at
  // 14% over a mid-grey texture, and a light theme's darkest text does not.
  assert.equal(DEFAULT_WASH.dark, 0.14)
  assert.equal(DEFAULT_WASH.light, 0.05)
  assert.equal(resolveTextureWash('dark', null), 0.14)
  assert.equal(resolveTextureWash('light', null), 0.05)
  // `Number(null)` and `Number('')` are both 0, so "follow the theme" has to be
  // named before the value is coerced or a light theme gets no veil at all.
  assert.equal(resolveTextureWash('light', undefined), 0.05)
  assert.equal(resolveTextureWash('dark', ''), 0.14)
  // An explicit 0 is a real choice, not an absence.
  assert.equal(resolveTextureWash('dark', 0), 0)
  assert.equal(resolveTextureWash('light', 0.3), 0.3)
  assert.equal(resolveTextureWash('dark', 9), 0.6, 'clamped')
  assert.equal(resolveTextureWash('dark', -1), 0, 'clamped')
  assert.equal(resolveTextureWash('light', 'nonsense'), 0.05, 'unusable is unset')
  assert.equal(resolveTextureWash('anything', null), 0.05, 'an unknown mode is treated as light, the stricter default')
})

test('a texture always writes a veil, because the theme default is not the stylesheet default', () => {
  const light = backgroundProperties({ editorTexture: 'grain' }, { mode: 'light' })
  const dark = backgroundProperties({ editorTexture: 'grain' }, { mode: 'dark' })
  assert.equal(light['--editor-texture-wash'], '0.05')
  assert.equal(dark['--editor-texture-wash'], '0.14')
  assert.equal(backgroundProperties({ editorTexture: 'grain', textureWash: 0.25 }, { mode: 'light' })['--editor-texture-wash'], '0.25')
  // No texture means nothing at all is written, so the stylesheet's own 0.14 is
  // untouched. Null rather than an empty object, so there is no set of properties
  // to accidentally add to later.
  assert.equal(backgroundProperties({}), null)
})

test('the default veil is enough for the light themes and the default is what is used', () => {
  // A texture whose dark end is the 8th percentile a typical photograph has.
  for (const id of ['light', 'paper']) {
    const tokens = resolveTheme(id).tokens
    const veil = DEFAULT_WASH[id === 'light' ? 'light' : 'light']
    const layers = backgroundOverlays(
      { editorTextureData: PNG },
      { textureBackdrops: ['#2b2b2b'], wash: veil },
    )
    assert.deepEqual(checkTokens(tokens, REQUIRED_PAIRS, layers), [], `${id} at its own default veil`)
    // And the stylesheet's 0.14 would not have been, which is why the applier
    // writes the resolved value rather than leaving the token alone.
    const tooThin = backgroundOverlays({ editorTextureData: PNG }, { textureBackdrops: ['#2b2b2b'], wash: 0.14 })
    assert.ok(checkTokens(tokens, REQUIRED_PAIRS, tooThin).length > 0, `${id} fails at 0.14, so the default has to be lower`)
  }
})

test('the default settings carry a flat surface and nothing to paint', () => {
  assert.equal(defaultSettings.editorTexture, '')
  assert.equal(defaultSettings.editorTextureData, '')
  assert.equal(defaultSettings.wallpaper, '')
  assert.equal(defaultSettings.surfaceAlpha, 100)
  assert.equal(defaultSettings.scrim, 0)
  // The single most important property of this feature: a reader who has never
  // opened Appearance gets no custom properties written at all, so the
  // stylesheet keeps owning them.
  assert.equal(backgroundProperties(defaultSettings), null)
  assert.equal(backgroundProperties({}), null)
})

test('every bundled texture resolves to a URL under /textures and nothing else does', () => {
  assert.ok(BUNDLED_TEXTURES.length >= 4 && BUNDLED_TEXTURES.length <= 6)
  for (const texture of BUNDLED_TEXTURES) {
    assert.equal(textureUrl(texture.id), `/textures/${texture.id}.svg`)
  }
  // A settings row is not trusted input. Anything that is not a listed id
  // resolves to nothing rather than to a path built from the stored string.
  for (const hostile of ['', '../secrets', '/etc/passwd', 'grain.svg', 'GRAIN', 'https://example.com/a.svg', null, undefined, 42]) {
    assert.equal(textureUrl(hostile), '')
  }
})

test('a bundled texture id wins over a picked image, because that is what paints', () => {
  assert.equal(editorTextureValue({ editorTexture: 'linen', editorTextureData: PNG }), 'url("/textures/linen.svg")')
  assert.equal(editorTextureValue({ editorTextureData: PNG }), `url("${PNG}")`)
  assert.equal(editorTextureValue({}), null)
  assert.equal(editorTextureValue({ editorTexture: 'nope', editorTextureData: 'file:///tmp/x.png' }), null)
})

test('image data URLs are accepted only when they are images and small enough', () => {
  assert.ok(isUsableImageData(PNG))
  assert.ok(isUsableImageData(`  ${PNG}  `), 'a stored value may carry whitespace')
  for (const bad of ['', '   ', 'file:///tmp/a.png', 'asset://localhost/a.png', 'https://example.com/a.png', 'data:text/html;base64,PHNjcmlwdD4=', null, undefined, 42, {}]) {
    assert.equal(isUsableImageData(bad), false, `${String(bad)} should be refused`)
  }
  const prefix = 'data:image/png;base64,'
  const atCap = prefix + 'A'.repeat(MAX_IMAGE_DATA_BYTES - prefix.length)
  assert.equal(atCap.length, MAX_IMAGE_DATA_BYTES)
  assert.equal(isUsableImageData(atCap), true, 'exactly at the cap is allowed')
  assert.equal(isUsableImageData(`${atCap}A`), false, 'one byte over the cap is over')
})

test('the two percentages are clamped rather than trusted', () => {
  assert.equal(clampPercent(50), 50)
  assert.equal(clampPercent(4000), 100)
  assert.equal(clampPercent(-40), 0)
  assert.equal(clampPercent('62'), 62)
  assert.equal(clampPercent(62.4), 62)
  assert.equal(clampPercent(undefined, 100), 100)
  assert.equal(clampPercent(undefined, 0), 0)
  assert.equal(clampPercent(NaN, 100), 100)
  assert.equal(clampPercent(Infinity, 0), 0)
})

test('a wallpaper writes the alpha, the percentage and a dim only when it is asked to', () => {
  const props = backgroundProperties({ wallpaper: WEBP, surfaceAlpha: 62, scrim: 35 })
  assert.equal(props['--wallpaper'], `url("${WEBP}")`)
  assert.equal(props['--surface-alpha'], '0.62')
  assert.equal(props['--surface-alpha-pct'], '62%')
  assert.equal(props['--wallpaper-dim'], '0.35')
  // A dim of zero is the absence of a dim, and painting a transparent black
  // layer would still cost the compositor one.
  assert.equal('--wallpaper-dim' in backgroundProperties({ wallpaper: WEBP, scrim: 0 }), false)
})

test('panel opacity means nothing without a wallpaper, so it is not applied', () => {
  // Translucent panels over no wallpaper are translucent over <body>, which is
  // the theme's --backdrop. That is a real change to the app requested by a
  // setting whose effect the reader cannot see.
  assert.equal(backgroundProperties({ surfaceAlpha: 40 }), null)
  const withTexture = backgroundProperties({ surfaceAlpha: 40, editorTexture: 'grain' })
  assert.equal(withTexture['--editor-texture'], 'url("/textures/grain.svg")')
  assert.equal('--surface-alpha' in withTexture, false)
  assert.equal('--surface-alpha-pct' in withTexture, false)
})

test('extremeBackdrops returns the light and dark ends and ignores transparent pixels', () => {
  const pixels = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 255,
    0, 0, 0, 0,
    128, 128, 128, 255,
  ])
  assert.deepEqual(extremeBackdrops(pixels), ['#ffffff', '#000000'])
  // A transparent pixel's stored RGB is whatever the encoder left behind, so
  // including it would invent a colour the reader never sees.
  const withHiddenBlack = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0])
  assert.deepEqual(extremeBackdrops(withHiddenBlack), ['#ffffff'])
  assert.equal(extremeBackdrops(new Uint8ClampedArray([9, 9, 9, 0])), null, 'a fully transparent image has no backdrop')
  assert.deepEqual(extremeBackdrops(new Uint8ClampedArray([7, 7, 7, 255, 7, 7, 7, 255])), ['#070707'], 'a flat image is one colour, not two')
})

test('a wallpaper produces one layer per panel surface, a texture one on the page', () => {
  const layers = backgroundOverlays({}, { wallpaperBackdrops: ['#ffffff', '#000000'], alpha: 0.6 })
  assert.deepEqual(layers.map((layer) => layer.token), ['--main', '--sidebar', '--chat'])
  assert.equal(layers[0].alpha, 0.6)

  const texture = backgroundOverlays({ editorTextureData: PNG }, { textureBackdrops: ['#888888'] })
  assert.equal(texture.length, 1)
  assert.equal(texture[0].token, '--main')
  // The wash is the inverse of the veil: a 0.14 wash means the texture shows
  // through 14%, so the layer of --main on top is 0.86. Getting this backwards
  // would put the texture at 86% strength behind body text.
  assert.equal(texture[0].alpha, 1 - DEFAULT_TEXTURE_WASH)
  assert.ok(texture[0].alpha > 0.85)
})

test('a bundled texture contributes no layer, because it has no image to sample', () => {
  const bundled = backgroundOverlays({ editorTexture: 'grain' }, { textureBackdrops: ['#888888'] })
  assert.deepEqual(bundled, [], 'a 5%-black SVG is not a backdrop worth failing a gate over')
  // And a bundled id overrides a picked image, so the picked image's backdrops
  // must not be measured while the id is set.
  const both = backgroundOverlays({ editorTexture: 'grain', editorTextureData: PNG }, { textureBackdrops: ['#888888'] })
  assert.deepEqual(both, [])
})

test('an unsampled background contributes no layer rather than a guessed one', () => {
  assert.deepEqual(backgroundOverlays({ wallpaper: WEBP }, { wallpaperBackdrops: null }), [])
  assert.deepEqual(backgroundOverlays({ wallpaper: WEBP }), [])
})

// ---------------------------------------------------------------------------
// The composited gate
// ---------------------------------------------------------------------------

test('an opaque layer composites to exactly the base colour, so P3 numbers hold', () => {
  const tokens = resolveTheme('night').tokens
  const bare = checkTokens(tokens)
  assert.deepEqual(bare, [], 'the built-in themes pass the P3 gate')
  const opaque = checkTokens(tokens, REQUIRED_PAIRS, [
    surfaceOverlay('--main', 1, ['#ffffff']),
    surfaceOverlay('--sidebar', 1, ['#f0f0f0']),
    surfaceOverlay('--chat', 1, ['#fafafa']),
  ])
  assert.deepEqual(opaque, [], 'and still pass with an opaque wallpaper layer')
  // Not "similar": the same empty list, so the P3 numbers are unchanged.
})

test('a wallpaper is refused at low opacity and the reader is told which end failed', () => {
  // The requirement from P4-4: the gate runs on the composited surface, so a
  // wallpaper that breaks the text is refused rather than shipped. A photo that
  // runs from white to near-black is the honest worst case for this.
  const photo = ['#ffffff', '#0a0a0a']
  for (const id of THEME_IDS) {
    const tokens = resolveTheme(id).tokens
    const layers = (alpha, backdrops = photo) => ['--main', '--sidebar', '--chat'].map((token) => surfaceOverlay(token, alpha, backdrops))
    const failures = checkTokens(tokens, REQUIRED_PAIRS, layers(0.45))
    assert.ok(failures.length > 0, `${id} at 45% must fail`)
    for (const failure of failures) {
      assert.ok(failure.backdrop, 'a composited failure names the backdrop that caused it')
      assert.ok(failure.painted, 'and the colour it actually painted')
      assert.match(describeFailure(failure), /of your image/)
    }
    // Opaque panels are exactly the P3 surface again, whatever the wallpaper is
    // set to, so the failure is always about the surfaces that went translucent.
    assert.ok(failures.every((failure) => ['--main', '--sidebar', '--chat'].includes(failure.bg)))
  }
})

test('raising the panel opacity never makes the gate worse', () => {
  // Monotonicity is what makes the slider usable: a reader who drags it right
  // and sees the count go up has been given a broken control, and this is the
  // test that says so.
  const photo = ['#ffffff', '#0a0a0a']
  const steps = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
  for (const id of THEME_IDS) {
    const tokens = resolveTheme(id).tokens
    let previous = Infinity
    for (const alpha of steps) {
      const count = checkTokens(tokens, REQUIRED_PAIRS, ['--main', '--sidebar', '--chat'].map((token) => surfaceOverlay(token, alpha, photo))).length
      assert.ok(count <= previous, `${id}: ${alpha} produced ${count} failures after ${previous}`)
      previous = count
    }
    assert.equal(previous, 0, `${id} must be able to reach a clean surface`)
  }
})

test('a light theme needs its panels opaque over a full-range photo, and the gate says so', () => {
  // Recorded rather than wished away. A black overlay on a black region changes
  // nothing, so no amount of dimming rescues the dark end of the image for a
  // theme with dark text; only the panel opacity does. The gate reports the dark
  // end specifically, which is the information the reader needs.
  const photo = ['#ffffff', '#0a0a0a']
  for (const id of ['light', 'paper']) {
    const tokens = resolveTheme(id).tokens
    const dimmed = dimBackdrops(photo, 0.8)
    const failures = checkTokens(tokens, REQUIRED_PAIRS, ['--main', '--sidebar', '--chat'].map((token) => surfaceOverlay(token, 0.8, dimmed)))
    assert.ok(failures.length > 0, `${id} at 80% with a heavy dim still fails on the dark end`)
    assert.ok(failures.some((failure) => describeFailure(failure).includes('the dark')))
  }
  // The dark theme does not, which is why the feature is not simply refused.
  const night = resolveTheme('night').tokens
  const dimmed = dimBackdrops(photo, 0.2)
  const passing = [0.6, 0.7, 0.8, 0.9, 0.95, 1].filter((alpha) => checkTokens(night, REQUIRED_PAIRS, ['--main', '--sidebar', '--chat'].map((token) => surfaceOverlay(token, alpha, dimmed))).length === 0)
  assert.ok(passing.length > 0, 'night reaches a clean surface below fully opaque')
  assert.ok(passing[0] < 1)
})

test('the dim is measured, not ignored', () => {
  // A 60% dim turns a white region into 40% grey, and the gate has to see the
  // grey: failing a wallpaper the reader has already made readable, with no way
  // to clear the failure, is the worst kind of wrong.
  assert.deepEqual(dimBackdrops(['#ffffff'], 0), ['#ffffff'], 'no dim changes nothing')
  assert.deepEqual(dimBackdrops(['#ffffff'], 0.6), ['rgb(102, 102, 102)'])
  assert.deepEqual(dimBackdrops(['#000000'], 0.6), ['rgb(0, 0, 0)'], 'a black overlay on black is a no-op, and that is correct')
  assert.deepEqual(dimBackdrops(['#ffffff', '#000000'], 1), ['rgb(0, 0, 0)', 'rgb(0, 0, 0)'])
  assert.equal(dimBackdrops(null, 0.5), null)
  const before = checkTokens(resolveTheme('night').tokens, REQUIRED_PAIRS, ['--main'].map((token) => surfaceOverlay(token, 0.5, ['#ffffff'])))
  const after = checkTokens(resolveTheme('night').tokens, REQUIRED_PAIRS, ['--main'].map((token) => surfaceOverlay(token, 0.5, dimBackdrops(['#ffffff'], 0.5))))
  assert.ok(after.length < before.length, 'dimming the only backdrop must be able to clear a failure')
})

test('the page veil is what stands between the prose and a reader\'s texture', () => {
  const light = resolveTheme('light').tokens
  // A texture's dark end, sampled at the 8th percentile a real photograph has
  // rather than at pure black, which no photograph has.
  const dark = ['#2b2b2b']

  // No veil at all: the prose is dark text on near-black and is unreadable.
  const bare = backgroundOverlays({ editorTextureData: PNG }, { textureBackdrops: dark, wash: 1 })
  assert.ok(checkTokens(light, REQUIRED_PAIRS, bare).length > 0, 'no veil fails, which is why there is one')

  // The veil the light theme actually gets, which is what clears it.
  const veiled = backgroundOverlays({ editorTextureData: PNG }, { textureBackdrops: dark, wash: DEFAULT_WASH.light })
  assert.deepEqual(checkTokens(light, REQUIRED_PAIRS, veiled), [], 'and the light default clears it')

  // A dark theme needs far less of it, which is why the two defaults differ.
  const night = resolveTheme('night').tokens
  assert.deepEqual(checkTokens(night, REQUIRED_PAIRS, backgroundOverlays({ editorTextureData: PNG }, { textureBackdrops: dark, wash: DEFAULT_WASH.dark })), [])
  assert.ok(checkTokens(light, REQUIRED_PAIRS, backgroundOverlays({ editorTextureData: PNG }, { textureBackdrops: dark, wash: 0.3 })).length > 0, 'and 30% is refused for light')
})

test('a texture and a wallpaper together do not double-measure the page', () => {
  // The page is either the veil or the translucent panel, never both: the veil
  // paints over the panel, so a second --main layer would be opaque, hide the
  // veil, and stop the texture being measured at all.
  const layers = backgroundOverlays(
    { editorTextureData: PNG, wallpaper: WEBP },
    { textureBackdrops: ['#2b2b2b'], wallpaperBackdrops: ['#ffffff', '#101010'], alpha: 0.5, scrim: 0.4, wash: DEFAULT_WASH.light },
  )
  const forMain = layers.filter((layer) => layer.token === '--main')
  assert.equal(forMain.length, 1, 'exactly one layer owns --main')
  assert.equal(forMain[0].backdrops[0], '#2b2b2b', 'and it is the texture, because that is what the page shows')
  // The wallpaper still reaches the reader through the two side panels.
  assert.deepEqual(layers.filter((layer) => layer.token !== '--main').map((layer) => layer.token), ['--sidebar', '--chat'])
  assert.equal(layers.find((layer) => layer.token === '--sidebar').backdrops[0], 'rgb(153, 153, 153)', 'dimmed, because the dim is over the wallpaper')
})

test('a stack is composited front to back, and an opaque layer hides what is under it', () => {
  // Two layers of the same colour would compose to that colour in either order,
  // which would make this test pass whatever paintStack did. So the layers are
  // black and white and the order is the only thing that can move the result.
  const veil = surfaceOverlay('--main', 0.5, null, '#000000')
  const panel = surfaceOverlay('--main', 0.5, null, '#ffffff')
  // Index 0 is nearest the reader, so veil-then-panel is a black half over a
  // white half over white, and the other order is a different colour.
  assert.equal(paintStack([veil, panel], '#ffffff'), 'rgb(128, 128, 128)')
  assert.equal(paintStack([panel, veil], '#ffffff'), 'rgb(192, 192, 192)')

  const withBackdrops = surfaceOverlay('--main', 0.5, ['#000000'], '#ffffff')
  assert.deepEqual(stackBackdrops([surfaceOverlay('--main', 1, null), withBackdrops]), ['#000000'], 'an opaque layer short-circuits')
  assert.deepEqual(stackBackdrops([surfaceOverlay('--main', 0, null), withBackdrops]), ['#000000'], 'a fully clear layer does not')
  assert.equal(stackBackdrops([surfaceOverlay('--main', 0.5, null)]), null, 'an unknown backdrop is unknown, not white')

  // A layer whose own colour was never resolved cannot be painted, and saying
  // so is better than painting the stack as if the layer were not there.
  assert.equal(paintStack([surfaceOverlay('--main', 0.5, ['#000'])], '#ffffff'), null)
})

test('mix clamps its weight and refuses a colour it cannot read', () => {
  assert.deepEqual(mix([255, 255, 255], [0, 0, 0], 0.5), [128, 128, 128])
  assert.deepEqual(mix([255, 0, 0], [0, 0, 255], 5), [255, 0, 0])
  assert.deepEqual(mix([255, 0, 0], [0, 0, 255], -3), [0, 0, 255])
  assert.equal(mix('nonsense', [0, 0, 0], 0.5), null)
})

test('a token set that has not been asked about a wallpaper is measured alone', () => {
  // The P3 call signature has to keep working: the picker's save gate and the
  // preset generator both call checkTokens with one argument.
  assert.deepEqual(checkTokens(resolveTheme('light').tokens), [])
  assert.ok(checkTokens({ '--main': '#ffffff' }, [['x', '--nope', 4.5]]).length > 0)
})

test('an opaque panel setting means the wallpaper is never painted', () => {
  // At surfaceAlpha 100 both `.library-layout` and `.editor-shell` fill with
  // `--surface`, which is opaque `--main`, so a wallpaper behind them is entirely
  // invisible. It was still being painted: a viewport-sized decode and composite
  // of a multi-megabyte photograph, per frame, for nothing. Asserted because the
  // failure is invisible -- the app looks right and is simply slower.
  const wallpaper = `data:image/jpeg;base64,${'A'.repeat(64)}`
  const opaque = backgroundProperties({ wallpaper, surfaceAlpha: 100, scrim: 28 })
  assert.equal(opaque['--wallpaper'], undefined, 'not painted')
  assert.equal(opaque['--wallpaper-dim'], undefined, 'and no dim layer over nothing')

  // Below 100 it comes back, with the alpha that makes it visible.
  const seeThrough = backgroundProperties({ wallpaper, surfaceAlpha: 72, scrim: 28 })
  assert.match(seeThrough['--wallpaper'], /^url\("data:image\/jpeg;base64,/)
  assert.equal(seeThrough['--surface-alpha-pct'], '72%')
  assert.equal(seeThrough['--wallpaper-dim'], '0.28')

  // The stored wallpaper is not disturbed either way, so the slider can go back.
  assert.deepEqual(
    backgroundProperties({ wallpaper, surfaceAlpha: 100, scrim: 28 }, { mode: 'dark' }),
    backgroundProperties({ wallpaper, surfaceAlpha: 100, scrim: 28 }, { mode: 'light' }),
    'and it does not depend on the theme, only on the alpha',
  )
})
