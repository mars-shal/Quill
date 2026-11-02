/**
 * The custom-theme contract, in one place.
 *
 * This file exists because of a bug that 200-odd green tests could not see.
 *
 * `CustomTheme` in Rust carries `#[serde(rename_all = "camelCase")]`, so the
 * field `theme_id` was serialised as `themeId`. Every reader of it is JavaScript
 * that matches on `theme_id`: `resolveTheme` looks a theme up by it,
 * `ThemePicker` keys its cards on it, and `slugify.js` mirrors the Rust
 * derivation of it. So `resolveTheme` never found a match and fell through to
 * the light built-in -- meaning every saved theme listed as "Light" and picking
 * one repainted the entire app in the light theme while the settings row still
 * held the theme's real id.
 *
 * The reason the suite stayed green is the reason this file is necessary: the
 * test harness mocked `list_custom_themes` with `theme_id`, agreeing with the
 * JavaScript and disagreeing with the Rust. The tests described an API that no
 * runtime had ever returned. A mock that is hand-written rather than generated
 * from the real type will drift, and nothing in JS-land can notice it has.
 *
 * So the field list is pinned on both sides against the same list of names:
 * here, and in `account.rs` in
 * `a_custom_theme_serialises_with_the_field_names_the_javascript_matches_on`.
 * If either side is renamed, one of the two fails.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The harness pulls in `mock.module`, so this file needs the module-mocks flag
// and belongs to the mocked group rather than the plain unit one.
import { handlers, themeFixtures } from './support/dom-harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The names the frontend matches on. Kept in step with the Rust assertion. */
const WIRE_FIELDS = ['theme_id', 'name', 'tokens', 'mode']

test('the harness returns the field names the frontend matches on', () => {
  // Seeded through the fixture's own save path rather than hand-written, so the
  // assertion describes the same round trip a real `save_custom_theme` makes.
  themeFixtures.save({ name: 'Midnight', tokens: { '--main': '#000' }, mode: 'dark' })
  const row = handlers.list_custom_themes()[0]
  assert.ok(row, 'the harness has a custom theme to return')
  assert.deepEqual(
    Object.keys(row).sort(),
    [...WIRE_FIELDS].sort(),
    'the mock agrees with the Rust wire shape, so a rename cannot pass here and fail in the app',
  )
})

test('the Rust struct declares exactly these fields', () => {
  // The other half of the pin, read out of the source. A struct field renamed
  // without the serde rename left alone would desynchronise the two halves.
  const source = readFileSync(join(root, 'src-tauri', 'src', 'account.rs'), 'utf8')
  const struct = source.slice(source.indexOf('pub struct CustomTheme'))
  const fields = [...struct.matchAll(/pub (\w+):/g)].map((match) => match[1])
  assert.deepEqual(fields.sort(), [...WIRE_FIELDS].sort(), 'the struct fields')

  assert.match(
    struct.slice(0, struct.indexOf('pub theme_id')),
    /#\[serde\(rename = "theme_id"\)\]/,
    'and theme_id is pinned to snake_case on the wire',
  )
})

test('a saved dark theme resolves as itself, not as the light built-in', async () => {
  // The symptom, end to end. `resolveTheme` finds nothing for an id it cannot
  // match, and its fallback is the light built-in -- so a dark theme came back
  // named "Light", previewed light, and applied light, while the settings row
  // kept saying the theme's real id.
  const { resolveTheme } = await import('../src/library/themes.js')
  const { BUILT_IN_THEMES } = await import('../src/library/themes.js')

  const rows = [
    { theme_id: 'midnight', name: 'Midnight', mode: 'dark', tokens: { '--main': '#05060a' } },
    { theme_id: 'sepia', name: 'Sepia', mode: 'light', tokens: { '--main': '#f6ecd9' } },
  ]
  const midnight = resolveTheme('midnight', rows)
  assert.equal(midnight.name, 'Midnight', 'its own name, not "Light"')
  assert.equal(midnight.mode, 'dark')
  assert.equal(midnight.custom, true)
  assert.notEqual(midnight.id, BUILT_IN_THEMES.light.id, 'and not the light fallback id')
  assert.equal(midnight.tokens['--main'], '#05060a', 'its own tokens')

  const sepia = resolveTheme('sepia', rows)
  assert.equal(sepia.name, 'Sepia')
  assert.equal(sepia.mode, 'light')
  assert.equal(sepia.custom, true)

  // And the card keys stay distinct, which is what React needs and what six
  // cards all called "light" was not.
  assert.notEqual(midnight.id, sepia.id)
})

test('the picker states the file limit the Rust core actually enforces', async () => {
  // The stored cap is 4 MiB, but the file has to survive base64 into it, so the
  // enforced file limit is about 3 MB. Reading the expression out of the Rust
  // rather than restating it here is the point: the number in the dialog and the
  // number in `images.rs` are now the same number by construction.
  const settings = readFileSync(join(root, 'src-tauri', 'src', 'settings.rs'), 'utf8')
  const images = readFileSync(join(root, 'src-tauri', 'src', 'images.rs'), 'utf8')
  const storedCap = settings.match(/MAX_IMAGE_DATA_BYTES[^=]*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/)
  assert.ok(storedCap, 'the stored cap is still written as a product')
  const [, a, b, c] = storedCap.map(Number)
  const storedBytes = a * b * c

  const prefixRoom = Number(images.match(/DATA_URL_PREFIX_ROOM: u64 = (\d+)/)[1])
  // base64: three bytes in, four characters out.
  const maxFileBytes = Math.floor((storedBytes - prefixRoom) / 4) * 3
  const maxMb = Math.ceil(maxFileBytes / (1024 * 1024))

  const picker = readFileSync(join(root, 'src', 'library', 'BackgroundPicker.jsx'), 'utf8')
  const label = picker.match(/MAX_IMAGE_LABEL = 'up to (\d+) MB'/)[1]
  assert.equal(
    Number(label),
    maxMb,
    `the dialog promises ${label} MB but the core refuses anything over ${maxMb} MB`,
  )
})
