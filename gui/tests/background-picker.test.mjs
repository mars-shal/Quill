/**
 * The background controls, and the applier they drive.
 *
 * The thing under test is P4-4's requirement: the contrast gate has to run on
 * what the reader will actually see. A gate that measures `--main` alone reports
 * that a wallpaper is fine right up until the wallpaper is behind the text, and
 * the failure then arrives as an unreadable document rather than as a sentence
 * in the settings dialog.
 *
 * Two jsdom gaps are stubbed, and only two. `Image` never loads and a canvas has
 * no 2D context, so `imageBackdrops` could not return anything at all. The stubs
 * stand in for the *decoder* and the *pixel buffer*; `extremeBackdrops`, the
 * layer stack and the arithmetic are the real implementations, and
 * `tests/backgrounds.test.mjs` covers them without a browser.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./tests/setup.mjs \
 *        --test tests/background-picker.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertGone,
  calls,
  dialogFixtures,
  dom,
  handlers,
  imageFixtures,
  root,
  SETTINGS,
  settle,
  tick,
  mockFramerMotion,
} from './support/dom-harness.mjs'

mockFramerMotion()

const { window } = dom

// A 1x1 PNG and a 1x1 WebP, so `isUsableImageData` has something real to accept.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='

/** The pixels the fake decoder reports, as `[r, g, b, a]` quadruples. */
let pixels = []

// The decoder stub. jsdom never loads an image, so `onload` would never fire and
// the sampler would hang rather than return null. It has to be installed on
// `globalThis` as well as on the window: the app resolves bare `Image`, and the
// harness only defines `window`, `document` and the element classes, so a
// window-only stub leaves `new Image()` as a ReferenceError -- which
// `imageBackdrops` catches and reports as "no backdrop", and the composited gate
// then quietly measures the theme alone.
class FakeImage {
  set src(_value) {
    this.naturalWidth = 1
    this.naturalHeight = 1
    queueMicrotask(() => this.onload?.())
  }
}
window.Image = FakeImage
Object.defineProperty(globalThis, 'Image', { value: FakeImage, writable: true, configurable: true })
window.HTMLCanvasElement.prototype.getContext = () => ({
  drawImage() {},
  getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(pixels.length ? pixels : new Uint8ClampedArray(width * height * 4)) }),
})

await import('../src/main.jsx')
await tick(250)

const html = window.document.documentElement

const click = async (node) => {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
}

const pressKey = (key, init = {}) =>
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  )

const openSettings = async ({ reset = true } = {}) => {
  // The sidebar slot the chip used to occupy, which is where the entry point
  // lives now.
  const button = root.querySelector('.library-sidebar .sidebar-settings')
  assert.ok(button, 'the library sidebar has a Settings button')
  await click(button)
  assert.ok(root.querySelector('.settings-page'), 'the settings dialog opened')
  // The background controls live in the Appearance panel, and Settings now opens
  // on Assistant. Taking the tab rather than reaching past it is what proves the
  // panel is reachable: the panels stay mounted and hidden, so a test that
  // ignored the tab bar would pass against controls no reader could see.
  const appearance = [...root.querySelectorAll('.settings-tabs [role="tab"]')]
    .find((node) => node.textContent.trim() === 'Appearance')
  assert.ok(appearance, 'the Appearance tab is rendered')
  await click(appearance)
  if (reset) await resetBackgrounds()
}

const closeSettings = async () => {
  // Escape, not a button in the page. The library sidebar stays on screen beside
  // Settings and carries the Settings button that toggles the page closed, so the
  // page has no way back of its own and no chevron claiming otherwise. Dispatched
  // on `document` because that is where the app's global keydown listener lives.
  pressKey('Escape')
  await settle()
  assertGone('.settings-page', 'Escape closed the settings page')
}

/**
 * Puts the background controls back to a fresh-install state.
 *
 * Needed because settings no longer have a Cancel. This file mounts the app once
 * for the whole run, so a wallpaper chosen by one test is still chosen by the
 * next one -- which used to be impossible, because every test ended by either
 * saving or rolling back. Resetting through the UI rather than by poking the
 * fixture keeps each test's starting point honest: it is the state a reader who
 * has never opened these controls is in.
 *
 * The wait at the end crosses the dialog's 350ms save debounce, so the reset has
 * actually landed in the app's own settings before the next test looks at them.
 */
const resetBackgrounds = async () => {
  // Order matters, and it is the reverse of the obvious one. The opacity and dim
  // sliders only exist while a wallpaper is chosen, so they have to be put back
  // *before* the wallpaper is cleared -- otherwise there is nothing to put back.
  if (root.querySelector('#surface-alpha')) {
    await setRange('surface-alpha', 100)
    await setRange('wallpaper-scrim', 0)
  }
  await click(chipNamed('None', 'Wallpaper'))
  await click(chipNamed('None', 'Paper texture'))
  await tick(450)
}

const picker = () => root.querySelector('.background-picker')
const chips = () => [...root.querySelectorAll('.texture-chip')]
/**
 * A chip by its label, optionally scoped to one row.
 *
 * The scope is not fussiness: both rows have a "Choose…" chip, and the texture
 * row comes first, so an unscoped lookup for a wallpaper silently picks the
 * texture file instead and the test then asserts about the wrong surface.
 */
const chipNamed = (needle, group) => {
  const row = group
    ? [...root.querySelectorAll('.background-group')].find((node) => node.querySelector('legend')?.textContent.includes(group))
    : root
  assert.ok(row, group ? `the ${group} row is rendered` : 'a row to search')
  const chip = [...row.querySelectorAll('.texture-chip')].find((node) => node.textContent.includes(needle))
  assert.ok(chip, `${group || 'some'}: a chip reading ${needle}, got ${[...row.querySelectorAll('.texture-chip')].map((n) => n.textContent.trim()).join(' | ')}`)
  return chip
}
const inlineBackgrounds = () => Object.fromEntries(
  [...html.style]
    .filter((property) => property.startsWith('--wallpaper') || property.startsWith('--surface-alpha') || property.startsWith('--editor-texture'))
    .map((property) => [property, html.style.getPropertyValue(property)]),
)

const setRange = async (id, value) => {
  const input = root.querySelector(`#${id}`)
  assert.ok(input, `#${id} is rendered`)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, String(value))
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()
}

// ---------------------------------------------------------------------------

test('a fresh install writes no background properties at all', async () => {
  // The opt-in property, and the reason it is asserted on the applier rather
  // than on the dialog: a reader who has never opened Appearance must get the
  // pixels the build had before any of this existed.
  assert.deepEqual(inlineBackgrounds(), {})
  await openSettings()
  assert.ok(picker(), 'the controls are there')
  assert.equal(root.querySelectorAll('.texture-chip.selected').length, 2, 'None is selected for both rows')
  assert.equal(root.querySelector('#surface-alpha'), null, 'no wallpaper means no opacity slider')
  assert.equal(root.querySelector('#wallpaper-scrim'), null, 'and no dim slider')
  assert.equal(root.querySelector('#texture-wash'), null, 'and no texture strength, because there is no texture')
  await closeSettings()
})

test('a bundled texture writes its URL and a veil sized for the theme', async () => {
  await openSettings()
  await click(chipNamed('Paper grain', 'Paper texture'))
  assert.equal(html.style.getPropertyValue('--editor-texture'), 'url("/textures/grain.svg")')
  // Light is the theme, and a light theme's default veil is 0.05, not the 0.14
  // in the stylesheet. The stylesheet value would put four colours under 4.5:1
  // over a dark texture, so it is written rather than inherited.
  assert.equal(html.style.getPropertyValue('--editor-texture-wash'), '0.05')
  // No texture strength slider for a bundled one: it is drawn at 5% and there is
  // nothing to tune, so the control would have no visible effect.
  assert.equal(root.querySelector('#texture-wash'), null)
  await closeSettings()
  // Closing keeps it, because it was saved rather than drafted. That is the whole
  // contract now: there is no Cancel to roll a preview back, so what you set is
  // what you keep.
  assert.equal(html.style.getPropertyValue('--editor-texture'), 'url("/textures/grain.svg")')

  // The applier's cleanup is still not optional -- a property left on <html>
  // outlives the setting that wrote it -- so it is tested by *clearing the
  // setting*, which is the thing that now removes it.
  await openSettings()
  await click(chipNamed('None', 'Paper texture'))
  await tick(450)
  assert.equal(html.style.getPropertyValue('--editor-texture'), '', 'a texture that was cleared is unpainted')
  assert.equal(html.style.getPropertyValue('--editor-texture-wash'), '', 'and its veil goes with it')
  await closeSettings()
})

test("a reader's own image replaces the bundled id rather than layering under it", async () => {
  await openSettings()
  await click(chipNamed('Paper grain', 'Paper texture'))
  assert.equal(html.style.getPropertyValue('--editor-texture'), 'url("/textures/grain.svg")')

  // A file the reader chose cannot be painted underneath a bundled id, because
  // `editorTextureValue` resolves the id first. So the id is cleared.
  pixels = [0, 0, 0, 255]
  dialogFixtures.open = '/home/reader/paper.png'
  imageFixtures.next = { dataUrl: PNG, mediaType: 'image/png', byteLength: 68, fileName: 'paper.png' }
  await click(chipNamed('Choose…', 'Paper texture'))
  assert.equal(html.style.getPropertyValue('--editor-texture'), `url("${PNG}")`)
  assert.ok(root.querySelector('#texture-wash'), 'a reader image has a strength control')
  assert.ok(root.querySelector('.picked-swatch'), 'and is named as theirs')
  imageFixtures.next = null
  dialogFixtures.open = null
  pixels = []
  await closeSettings()
})

test('the texture strength is a control, and it is the only lever there is', () => {
  // A light theme's darkest text is 4.5:1 on white and about 3.4:1 on the grey a
  // thin veil leaves, so the light default is deliberately thin. Turning the
  // strength up is how a reader makes a texture visible -- and it is also how
  // they lose the text, which the gate has to say while they do it.
  return (async () => {
    await openSettings()
    pixels = [43, 43, 43, 255]
    dialogFixtures.open = '/home/reader/dark.png'
    imageFixtures.next = { dataUrl: PNG, mediaType: 'image/png', byteLength: 68, fileName: 'dark.png' }
    await click(chipNamed('Choose…', 'Paper texture'))

    assert.equal(html.style.getPropertyValue('--editor-texture-wash'), '0.05', 'the light theme default')
    assert.ok(root.querySelector('.background-check-ok'), 'which is safe over a dark texture')

    await setRange('texture-wash', 40)
    assert.equal(html.style.getPropertyValue('--editor-texture-wash'), '0.4')
    assert.ok(root.querySelector('.background-check-bad'), 'a 40% strength is not, and it is reported')
    assert.match(root.querySelector('.background-check-list').textContent, /of your image/)

    // And the note says which control to reach for, because a black overlay
    // cannot rescue the dark end of an image for a theme with dark text: no
    // amount of dimming helps here, and the reader should not go looking.
    assert.match(root.querySelector('.background-check').textContent, /texture strength/i)

    imageFixtures.next = null
    dialogFixtures.open = null
    pixels = []
    await closeSettings()
  })()
})

test('a wallpaper writes the panels translucent, and the gate measures the wallpaper', async () => {
  await openSettings()
  // White to near-black: the honest worst case for a photograph.
  pixels = [255, 255, 255, 255, 10, 10, 10, 255]
  dialogFixtures.open = '/home/reader/photo.webp'
  imageFixtures.next = { dataUrl: WEBP, mediaType: 'image/webp', byteLength: 60, fileName: 'photo.webp' }
  await click(chipNamed('Choose…', 'Wallpaper'))

  // Choosing a wallpaper has to make something happen. At the default 100% panel
  // opacity both the library and the editor fill with opaque `--main`, so the
  // wallpaper was painted and then completely covered -- pick an image, see no
  // change. So the picker opens the panels to 82% on first pick, and the wallpaper
  // is painted immediately.
  assert.equal(html.style.getPropertyValue('--wallpaper'), `url("${WEBP}")`, 'painted on pick')
  assert.equal(html.style.getPropertyValue('--surface-alpha-pct'), '82%', 'and the panels opened to show it')
  assert.equal(root.querySelector('#surface-alpha').value, '82', 'the slider says so')
  assert.equal(
    chipNamed('Change…', 'Wallpaper').getAttribute('aria-checked'),
    'true',
    'and the row reads as chosen',
  )

  // Now the reader asks for translucent panels over that photo, and the gate
  // has to notice that the light theme's text cannot survive it.
  await setRange('surface-alpha', 60)
  assert.equal(html.style.getPropertyValue('--surface-alpha-pct'), '60%')
  assert.equal(html.style.getPropertyValue('--wallpaper'), `url("${WEBP}")`, 'now it is painted')
  const failures = root.querySelector('.background-check-list')
  assert.ok(failures, 'the check ran on the composited surface')
  assert.ok(failures.children.length > 0, 'and it failed')
  assert.match(failures.textContent, /of your image/)

  // Raising the opacity is the fix, and the count has to go down.
  const before = failures.children.length
  await setRange('surface-alpha', 100)
  const after = root.querySelector('.background-check-list')
  assert.equal(after, null, 'opaque panels are the P3 surface again, whatever the wallpaper is')
  assert.ok(before > 0, 'so the failure was the wallpaper, not the theme')

  imageFixtures.next = null
  dialogFixtures.open = null
  pixels = []
  await closeSettings()
})

test('the dim is measured rather than assumed away', async () => {
  // A black overlay on a black region changes nothing, so the dim only helps the
  // light end. A gate that ignored it would fail a wallpaper the reader has
  // already made readable, with no way to clear the failure.
  await openSettings()
  pixels = [255, 255, 255, 255, 10, 10, 10, 255]
  dialogFixtures.open = '/home/reader/photo.webp'
  imageFixtures.next = { dataUrl: WEBP, mediaType: 'image/webp', byteLength: 60, fileName: 'photo.webp' }
  await click(chipNamed('Choose…', 'Wallpaper'))
  await setRange('surface-alpha', 60)
  assert.ok(root.querySelector('.background-check-list'), 'fails before the dim')

  await setRange('wallpaper-scrim', 40)
  assert.equal(html.style.getPropertyValue('--wallpaper-dim'), '0.4')
  const text = root.querySelector('.background-check-list')?.textContent || ''
  // Whatever survives is the dark end, and the sentence says so, which is the
  // information the reader needs to know that more dimming will not help.
  if (text) assert.match(text, /the dark of your image/)

  await setRange('wallpaper-scrim', 0)
  assert.equal(html.style.getPropertyValue('--wallpaper-dim'), '', 'a zero dim is the absence of a dim')

  imageFixtures.next = null
  dialogFixtures.open = null
  pixels = []
  await closeSettings()
})

test('removing a wallpaper takes the panels back to opaque and unsets the properties', async () => {
  await openSettings()
  pixels = [255, 255, 255, 255]
  dialogFixtures.open = '/home/reader/photo.webp'
  imageFixtures.next = { dataUrl: WEBP, mediaType: 'image/webp', byteLength: 60, fileName: 'photo.webp' }
  await click(chipNamed('Choose…', 'Wallpaper'))
  // 55 is below the floor, and the floor is the assertion: a wallpaper can be
  // chosen and even dialled, but the panels cannot be taken translucent enough
  // for a bright image to turn a dark theme pale. See `panelAlpha`.
  await setRange('surface-alpha', 55)
  assert.equal(html.style.getPropertyValue('--surface-alpha-pct'), '60%', 'held at the floor')

  // "None" is the first chip in the wallpaper row.
  const none = chipNamed('None', 'Wallpaper')
  await click(none)
  assert.equal(html.style.getPropertyValue('--wallpaper'), '')
  assert.equal(html.style.getPropertyValue('--surface-alpha-pct'), '', 'a removed wallpaper leaves nothing translucent')
  assert.equal(root.querySelector('#surface-alpha'), null)

  imageFixtures.next = null
  dialogFixtures.open = null
  pixels = []
  await closeSettings()
  assert.deepEqual(inlineBackgrounds(), {})
})

test('there is no Save button, and a change is already saved when the dialog closes', async () => {
  // The dialog used to have Cancel / Save changes. It has neither now: a settings
  // dialog that asks you to confirm a change you already made by moving the
  // control is a dialog that can be closed with the wrong answer. So the
  // contract is the opposite one -- whatever you set is kept.
  await openSettings({ reset: false })
  await click(chipNamed('Linen', 'Paper texture'))
  assert.equal(html.style.getPropertyValue('--editor-texture'), 'url("/textures/linen.svg")', 'previewed at once')

  assert.equal(
    root.querySelector('.settings-page .dialog-actions'),
    null,
    'no action row, and so no Save and no Cancel',
  )

  // Past the 350ms debounce, so the write has actually been made.
  await tick(450)
  const saved = calls.filter((entry) => entry.command === 'set_settings').pop()
  assert.ok(saved, 'the change was persisted without anyone pressing anything')
  assert.equal(saved.args.value.editorTexture, 'linen')

  await closeSettings()
  assert.equal(root.querySelector('.settings-page'), null, 'the dialog closed')
  assert.equal(
    html.style.getPropertyValue('--editor-texture'),
    'url("/textures/linen.svg")',
    'and closing keeps the change, because it was never a draft',
  )
})

test('a file the reader cannot use is a message, not a silent no-op', async () => {
  await openSettings()
  dialogFixtures.open = '/home/reader/notanimage.bak'
  imageFixtures.error = 'that file is not an image Quill can use'
  await click(chipNamed('Choose…', 'Paper texture'))
  const alert = root.querySelector('.background-error')
  assert.ok(alert, 'the error is announced')
  assert.match(alert.textContent, /not an image Quill can use/)
  assert.equal(alert.getAttribute('role'), 'alert')
  assert.deepEqual(inlineBackgrounds(), {}, 'and nothing was applied')
  imageFixtures.error = ''
  dialogFixtures.open = null
  await closeSettings()
})

test('nothing here asks the webview for filesystem access', async () => {
  // The one rule that shaped P4-3: the dialog returns a path, one Rust command
  // reads that path, and the capability list stays as it was. A `File` from an
  // <input> would have meant plugin-fs with a broad scope, or assetProtocol.
  const read = calls.filter((call) => call.command === 'read_image_as_data_url')
  assert.equal(read.length >= 0, true)
  assert.equal(handlers.read_image_as_data_url instanceof Function, true)
  const capabilities = JSON.parse(await (await import('node:fs/promises')).readFile('src-tauri/capabilities/default.json', 'utf8'))
  const permissions = capabilities.permissions.join(' ')
  assert.ok(!/fs:/.test(permissions), `no fs scope, got: ${permissions}`)
  assert.ok(!/asset/i.test(JSON.stringify(capabilities)), 'and no asset protocol')
  assert.deepEqual(SETTINGS.wallpaper, '', 'the fixture starts with no wallpaper')
})
