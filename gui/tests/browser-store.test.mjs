/**
 * The browser platform path.
 *
 * `readLocalDocs` and `writeLocalDocs` were called from seven places in
 * `store.js` and never defined, so `npm run dev` in a plain browser — which the
 * README documents as a supported way to work — died during bootstrap with
 * `ReferenceError: readLocalDocs is not defined` and rendered nothing.
 *
 * Nothing caught it: in the app the Tauri branch always wins, and the render
 * suites mock the Tauri IPC, so no test ever took the browser branch. This file
 * is that test. It must not define `__TAURI_INTERNALS__`, or `store.js` will
 * take the Tauri path again.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/** A minimal localStorage, since this file runs without a JSDOM. */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

const store = await import('../src/platform/store.js')

test('the browser path is actually taken', () => {
  assert.equal(globalThis.__TAURI_INTERNALS__, undefined,
    'this suite must not present a Tauri webview')
  assert.equal(store.runtime.isTauri, false, 'store should report the browser runtime')
})

test('an empty library reads as empty rather than throwing', async () => {
  const docs = await store.listDocuments()
  assert.deepEqual(docs, [], 'a fresh browser profile has no documents')
})

test('documents round-trip through localStorage', async () => {
  const created = await store.createDocument({
    title: 'Browser Draft',
    kind: 'Draft',
    collections: ['Notes'],
    status: 'Drafts',
    color: '#6a8792',
    content: '<h1>One</h1><p>Two</p>',
    contentFormat: 'html',
  })
  assert.equal(created.title, 'Browser Draft')

  const listed = await store.listDocuments()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, created.id)
  assert.deepEqual(listed[0].collections, ['Notes'], 'collections must come back as an array')

  const fetched = await store.getDocument(created.id)
  assert.equal(fetched.title, 'Browser Draft')
})

test('an update persists and reloads', async () => {
  const [existing] = await store.listDocuments()
  await store.updateDocument(existing.id, { title: 'Renamed In Browser' })

  const reloaded = await store.listDocuments()
  assert.equal(reloaded[0].title, 'Renamed In Browser')

  // A second read proves it went to storage rather than to an in-memory cache.
  const raw = JSON.parse(localStorage.getItem('quill:documents'))
  assert.equal(raw[0].title, 'Renamed In Browser')
})

test('delete removes the document', async () => {
  const [existing] = await store.listDocuments()
  await store.deleteDocument(existing.id)
  assert.deepEqual(await store.listDocuments(), [])
})

test('a corrupt stored value does not take the library down', async () => {
  localStorage.setItem('quill:documents', '{not json')
  // The point of the try/catch in readLocalDocs: an unreadable value must
  // degrade to an empty library, not throw during bootstrap.
  assert.deepEqual(await store.listDocuments(), [])

  localStorage.setItem('quill:documents', '{"not":"an array"}')
  assert.deepEqual(await store.listDocuments(), [])
})

test('settings round-trip and fall back to defaults', async () => {
  const defaults = await store.getSettings()
  assert.equal(defaults.theme, 'light')

  await store.setSettings({ ...defaults, theme: 'night' })
  assert.equal((await store.getSettings()).theme, 'night')

  localStorage.setItem('quill:settings', 'not json')
  assert.equal((await store.getSettings()).theme, 'light', 'a corrupt value falls back to defaults')
})

test('a partial settings write leaves the other keys alone', async () => {
  await store.setSettings({ theme: 'night', font: 'Newsreader', density: 'compact' })

  // Only `theme`. Before the Rust side merged its payload, a partial write
  // reset every field the caller did not name.
  const after = await store.setSettings({ theme: 'paper' })

  assert.equal(after.theme, 'paper')
  assert.equal(after.font, 'Newsreader', 'an omitted key must survive the write')
  assert.equal(after.density, 'compact', 'an omitted key must survive the write')
  assert.ok(
    !('provider' in after) && !('model' in after) && !('endpoint' in after),
    'the flat provider triple is no longer part of settings',
  )

  const reloaded = await store.getSettings()
  assert.equal(reloaded.font, 'Newsreader', 'and must be what a reload reads back')
  assert.equal(reloaded.theme, 'paper')
})

test('a partial settings write can turn a true default off', async () => {
  await store.setSettings({ autosave: true, spellcheck: true })
  const after = await store.setSettings({ autosave: false })

  assert.equal(after.autosave, false, 'false must be written, not treated as absent')
  assert.equal(after.spellcheck, true, 'an omitted key must survive')
  assert.equal((await store.getSettings()).autosave, false)
})

test('the WebGL2 probe answers a boolean instead of throwing', async () => {
  const { hasWebGL2, resetCapabilityCache } = await import('../src/platform/capabilities.js')
  resetCapabilityCache()

  // This suite has no `document`, so the probe takes its catch path. That is the
  // case worth pinning: `metal-fx` v2 throws during render when WebGL2 is
  // missing, and the probe runs at import time in the chat panel, so a probe that
  // threw here would take the module with it instead of reporting "no".
  const first = hasWebGL2()
  assert.equal(typeof first, 'boolean', 'the probe must report a capability, not fail')

  // And it caches. Each call creates a canvas and, on a real webview, a GL
  // context, so a probe that re-ran per call would allocate on every render.
  assert.equal(hasWebGL2(), first, 'the result is cached for the session')

  resetCapabilityCache()
  assert.equal(typeof hasWebGL2(), 'boolean', 'and the seam can clear it')
})

// ---------------------------------------------------------------------------
// Custom themes
// ---------------------------------------------------------------------------

test('a saved theme is listed, and its id is the slug of its name', async () => {
  storage.delete('quill:custom-themes')
  assert.deepEqual(await store.listCustomThemes(), [], 'a fresh runtime has no reader themes')

  const saved = await store.saveCustomTheme({
    name: 'Deep Sea',
    tokens: { '--main': '#04121c', '--text-1': '#e8f2f8' },
    mode: 'dark',
  })
  assert.equal(saved.theme_id, 'deep-sea')
  assert.equal(saved.name, 'Deep Sea', 'the name is stored as typed, not slugified')
  assert.equal(saved.mode, 'dark')

  const listed = await store.listCustomThemes()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].theme_id, 'deep-sea')
  assert.equal(listed[0].tokens['--main'], '#04121c')
  // The stored row carries the timestamps; the returned record does not, on
  // either runtime, because `CustomTheme` in Rust has the same four fields. The
  // picker reads "Saved 3m ago" off the listed row, not off the return value.
  assert.ok(listed[0].created_at, 'a stored theme needs a creation time')
  assert.ok(listed[0].updated_at)
})

test('saving the same name again updates the theme rather than duplicating it', async () => {
  storage.delete('quill:custom-themes')
  const first = await store.saveCustomTheme({ name: 'Paper', tokens: { '--main': '#fff' }, mode: 'light' })
  const [firstCreated] = (await store.listCustomThemes()).map((t) => t.created_at)
  const second = await store.saveCustomTheme({ name: 'paper', tokens: { '--main': '#faf8f2' }, mode: 'light' })

  assert.equal(second.theme_id, first.theme_id, 'the id is derived from the name, so case cannot fork it')
  const listed = await store.listCustomThemes()
  assert.equal(listed.length, 1, 'a re-save must not leave two rows the reader cannot tell apart')
  assert.equal(listed[0].tokens['--main'], '#faf8f2')
  assert.equal(listed[0].created_at, firstCreated, 'the creation time survives an update')
})

test('a theme with no name, no tokens or no mode is refused before it is stored', async () => {
  storage.delete('quill:custom-themes')
  // The same three rules `account::save_theme` enforces. If the browser accepted
  // something the Tauri build rejects, the same theme would behave differently
  // depending on the runtime, which is the whole reason this fallback exists.
  for (const [input, because] of [
    [{ name: '   ', tokens: { '--main': '#fff' }, mode: 'light' }, 'a blank name'],
    [{ name: 'Nameless', tokens: null, mode: 'light' }, 'a missing token set'],
    [{ name: 'Nameless', tokens: ['#fff'], mode: 'light' }, 'an array of tokens'],
    [{ name: 'Nameless', tokens: { '--main': '#fff' } }, 'no mode'],
    [{ name: 'Nameless', tokens: { '--main': '#fff' }, mode: 'auto' }, 'a mode that is neither'],
  ]) {
    await assert.rejects(() => store.saveCustomTheme(input), /./, `${because} must be rejected`)
  }
  assert.deepEqual(await store.listCustomThemes(), [], 'nothing rejected may be stored')
})

test('an empty token set is stored, and resolves to its base theme', async () => {
  // Both runtimes accept `{}` -- Rust's check is `tokens.is_object()`, and an
  // empty object is one. The consequence is that such a theme is indistinguishable
  // from the built-in for its mode, so the picker is where an untouched draft has
  // to be caught; the store's job is only to agree between runtimes.
  storage.delete('quill:custom-themes')
  await store.saveCustomTheme({ name: 'Blank', tokens: {}, mode: 'dark' })
  const [stored] = await store.listCustomThemes()
  assert.equal(stored.theme_id, 'blank')
  const { resolveTheme, BUILT_IN_THEMES } = await import('../src/library/themes.js')
  const resolved = resolveTheme(stored.theme_id, [stored])
  assert.equal(resolved.custom, true)
  assert.deepEqual(resolved.tokens, BUILT_IN_THEMES.night.tokens, 'an empty theme is night, unchanged')
})

test('deleting a theme removes it, and deleting a missing one is not an error', async () => {
  storage.delete('quill:custom-themes')
  await store.saveCustomTheme({ name: 'Temporary', tokens: { '--main': '#fff' }, mode: 'light' })
  await store.deleteCustomTheme('temporary')
  assert.deepEqual(await store.listCustomThemes(), [])

  // The picker offers a delete button on a theme that another window may have
  // removed already; a throw there would surface as a crash instead of a no-op.
  await store.deleteCustomTheme('temporary')
  await store.deleteCustomTheme('never-existed')
  assert.deepEqual(await store.listCustomThemes(), [])
})

test('a corrupt theme store reads as empty instead of stopping the app', async () => {
  // The reason `readLocalDocs` has a guard, applied to themes: half of a write,
  // or a value edited by hand in devtools, must not stop Quill from starting.
  storage.set('quill:custom-themes', '{not json')
  assert.deepEqual(await store.listCustomThemes(), [])

  storage.set('quill:custom-themes', JSON.stringify({ not: 'an array' }))
  assert.deepEqual(await store.listCustomThemes(), [])

  // Entries without an id are dropped; the ones that are usable survive.
  storage.set('quill:custom-themes', JSON.stringify([
    { theme_id: 'kept', name: 'Kept', mode: 'dark', tokens: {} },
    { name: 'No id', mode: 'dark' },
    null,
  ]))
  const listed = await store.listCustomThemes()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].theme_id, 'kept')
  storage.delete('quill:custom-themes')
})
