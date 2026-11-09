/**
 * Platform abstraction for persistence and privileged operations.
 *
 * The same React UI runs in two environments:
 *   - inside the Tauri webview, where the Rust core owns SQLite, secrets and
 *     file access and is reached through `invoke`;
 *   - in a plain browser during development, where a localStorage-backed
 *     fallback keeps the UI usable.
 *
 * Production builds always take the Tauri path. The browser path exists only
 * so the UI can still be developed and reviewed with `npm run dev`.
 */

const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined

export const runtime = {
  isTauri,
  label: isTauri ? 'tauri' : 'browser',
}

/** Lazily import the Tauri API so the browser build never evaluates it. */
let invokeFn = null
let coreModule = null

async function tauriInvoke() {
  if (!isTauri) throw new Error('Tauri IPC is unavailable in this runtime')
  if (!invokeFn) {
    const mod = await import('@tauri-apps/api/core')
    invokeFn = mod.invoke
  }
  return invokeFn
}

/**
 * Lazily import the Tauri event API, for the same reason as `tauriInvoke`.
 * Separate from it because a listener outlives the call that made it: the only
 * thing that releases it is the unlisten function it hands back.
 */
let listenFn = null

async function tauriListen(event, handler) {
  if (!isTauri) throw new Error('Tauri IPC is unavailable in this runtime')
  if (!listenFn) {
    const mod = await import('@tauri-apps/api/event')
    listenFn = mod.listen
  }
  return listenFn(event, handler)
}

// ---------------------------------------------------------------------------
// Document record
// ---------------------------------------------------------------------------

/**
 * Normalises a persisted document so the UI always sees the same shape,
 * regardless of whether it came from SQLite, localStorage, or a legacy export.
 */
export function normalizeDoc(doc) {
  const collections = Array.isArray(doc.collections) && doc.collections.length
    ? doc.collections
    : [doc.cat || 'Notes']
  const title = String(doc.title || 'Untitled document')
  return {
    ...doc,
    title,
    collections,
    cat: doc.cat || collections[0],
    filename: doc.filename || `${slugify(title)}.md`,
    color: doc.color ?? '#6a8792',
    content: doc.content ?? '',
    contentFormat: doc.contentFormat || doc.content_format || 'html',
    status: doc.status || 'Drafts',
    kind: doc.kind || 'Draft',
    deletedAt: doc.deletedAt || doc.deleted_at || null,
  }
}

export function slugify(value) {
  return (
    String(value)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'untitled-document'
  )
}

function newLocalId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The browser fallback's document store.
 *
 * These two were called from seven places and never defined, so every browser
 * code path — `npm run dev` without Tauri, which the README documents — threw
 * `ReferenceError: readLocalDocs is not defined` during bootstrap and never
 * rendered. Nothing caught it because the Tauri branch always won in the app
 * and the render tests mock the Tauri IPC.
 *
 * The shape mirrors SQLite closely enough that the same `normalizeDoc` applies:
 * `collections` is a JSON string on disk and an array in memory, and every
 * record is normalised on the way out.
 */
const LOCAL_DOCS_KEY = 'quill:documents'

/** @returns {Array<object>} every stored document, or an empty list. */
function readLocalDocs() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_DOCS_KEY) || '[]')
    return Array.isArray(raw) ? raw.map(normalizeDoc) : []
  } catch {
    // A corrupt value must not take the whole library down; an empty library is
    // recoverable, a thrown ReferenceError at bootstrap is not.
    return []
  }
}

/** Replaces the stored document list. */
function writeLocalDocs(docs) {
  try {
    localStorage.setItem(LOCAL_DOCS_KEY, JSON.stringify(docs))
  } catch (error) {
    // Quota exceeded, or storage disabled entirely. The caller has already
    // applied the change optimistically, so surface it rather than pretend the
    // write succeeded.
    console.error('Could not persist documents to localStorage', error)
  }
  return docs
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function listDocuments({ includeDeleted = false } = {}) {
  if (isTauri) {
    const rows = await (await tauriInvoke())('list_documents', { includeDeleted })
    return rows.map(normalizeDoc)
  }
  const rows = readLocalDocs().map(normalizeDoc)
  return includeDeleted ? rows : rows.filter((doc) => !doc.deletedAt)
}

/**
 * Asks the reader for files outside the library and returns their paths.
 *
 * The dialog is the only filesystem grant the build takes, so the paths come
 * back here and the shell reads exactly the files the reader chose. A cancelled
 * dialog is an empty list, not an error.
 */
export async function pickImportPaths() {
  if (!isTauri) return []
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    title: 'Open a document',
    multiple: true,
    directory: false,
    filters: [
      { name: 'Documents', extensions: ['md', 'markdown', 'txt', 'text', 'html', 'htm', 'pdf', 'docx'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (!picked) return []
  return Array.isArray(picked) ? picked : [picked]
}

/** Broad document picker for chat attachments; MarkItDown handles the rest. */
export async function pickDocumentPaths() {
  if (!isTauri) return []
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    title: 'Attach a document',
    multiple: false,
    directory: false,
    filters: [
      {
        name: 'Documents',
        extensions: [
          'md', 'markdown', 'txt', 'text', 'html', 'htm', 'pdf', 'docx',
          'pptx', 'xlsx', 'xls', 'csv', 'json', 'xml', 'epub', 'rtf',
          'odt', 'ods', 'odp',
        ],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return picked ? [picked] : []
}

/** Convert one chosen document to Markdown through MarkItDown. */
export async function convertDocument(path) {
  if (!isTauri) throw new Error('Document conversion requires the desktop app')
  return (await tauriInvoke())('convert_document', { path })
}

/** Reads one text file the reader chose through the shell. */
export async function readTextFile(path) {
  if (!isTauri) throw new Error('Opening a file requires the desktop app')
  return (await tauriInvoke())('read_text_file', { path })
}

export async function getDocument(id) {
  if (isTauri) {
    return normalizeDoc(await (await tauriInvoke())('get_document', { id }))
  }
  const found = readLocalDocs().find((doc) => doc.id === id)
  if (!found) throw new Error(`document ${id} not found`)
  return found
}

export async function createDocument(input) {
  if (isTauri) {
    const created = await (await tauriInvoke())('create_document', {
      input: {
        title: input.title || 'Untitled document',
        kind: input.kind ?? null,
        collections: input.collections ?? null,
        status: input.status ?? null,
        color: input.color ?? null,
        filename: input.filename ?? null,
        content: input.content ?? '',
        contentFormat: input.contentFormat ?? null,
        provenance: input.provenance ?? null,
      },
    })
    return normalizeDoc(created)
  }

  const doc = normalizeDoc({
    id: newLocalId(),
    ...input,
    content: input.content ?? '',
    contentFormat: input.contentFormat || 'html',
    edited: 'just now',
    updatedAt: new Date().toISOString(),
  })
  writeLocalDocs([...readLocalDocs(), doc])
  return doc
}

export async function updateDocument(id, patch) {
  if (isTauri) {
    const updated = await (await tauriInvoke())('update_document', {
      input: {
        id,
        title: patch.title ?? null,
        kind: patch.kind ?? null,
        collections: patch.collections ?? null,
        status: patch.status ?? null,
        color: patch.color ?? null,
        filename: patch.filename ?? null,
        content: patch.content ?? null,
        contentFormat: patch.contentFormat ?? null,
      },
    })
    return normalizeDoc(updated)
  }

  const docs = readLocalDocs()
  const index = docs.findIndex((doc) => doc.id === id)
  if (index === -1) throw new Error(`document ${id} not found`)
  const next = normalizeDoc({ ...docs[index], ...patch, updatedAt: new Date().toISOString() })
  docs[index] = next
  writeLocalDocs(docs)
  return next
}

export async function deleteDocument(id) {
  if (isTauri) {
    await (await tauriInvoke())('delete_document', { id })
    return
  }
  writeLocalDocs(readLocalDocs().filter((doc) => doc.id !== id))
}

export async function purgeDocument(id) {
  if (isTauri) {
    await (await tauriInvoke())('purge_document', { id })
    return
  }
  writeLocalDocs(readLocalDocs().filter((doc) => doc.id !== id))
}

export async function restoreDocument(id) {
  if (isTauri) {
    return normalizeDoc(await (await tauriInvoke())('restore_document', { id }))
  }
  throw new Error('restore is not available in the browser runtime')
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const defaultSettings = {
  theme: 'light',
  // null: the mode follows the chosen theme. 'system' follows the OS light/dark
  // preference; 'light' and 'dark' are explicit choices made in the Appearance
  // mode cards (or implied by picking a theme of that mode).
  colorMode: null,
  font: 'Arial',
  density: 'comfortable',
  autosave: true,
  spellcheck: true,
  wordCount: true,
  reduceMotion: false,
  // Image backgrounds. `editorTexture` is a bundled id, `editorTextureData` and
  // `wallpaper` are `data:` URLs from `read_image_as_data_url`. `surfaceAlpha`
  // is 100 -- opaque -- so a reader who has never opened the Appearance section
  // sees exactly what the build looked like before these fields existed.
  editorTexture: '',
  editorTextureData: '',
  wallpaper: '',
  surfaceAlpha: 100,
  scrim: 0,
  // null means "whatever this theme needs", which is 0.05 for a light theme and
  // 0.14 for a dark one. A number is the reader's own choice, and it wins.
  textureWash: null,
  // Whether Settings scans this machine for CLIs and local servers (Ollama,
  // opencode, Codex, ...). Off means: no detection, no "On this machine" rows
  // -- the panel a reader who never wants local agents should not pay for.
  localTools: true,
  // Token-saving mode caps the answer length and trims the draft sent to the
  // model. It is a budget, not a separate assistant.
  tokenSaving: false,
  // Inline ghost-text completions, and how long typing must pause first.
  completions: true,
  completionDelay: 900,
  // Run the deterministic import tidy-up as a document is created. The editor's
  // Clean up action still exists for anything this does not catch.
  formatOnImport: true,
  // A plain, direct academic voice for generated prose. It changes the prompt,
  // not the model: shorter sentences, active voice, no formulaic transitions.
  naturalVoice: true,
  // JSON string of the saved writing profile, or empty for none.
  writingProfile: '',
}

/**
 * The textures that ship with the build.
 *
 * Ids, not paths, because a path in a settings row is a string that stops
 * resolving when the file moves. `textureUrl` turns one into a URL; nothing else
 * in the app should be concatenating `/textures/`.
 */
export const BUNDLED_TEXTURES = [
  { id: 'grain', name: 'Paper grain', hint: 'Fine, even' },
  { id: 'linen', name: 'Linen', hint: 'Woven' },
  { id: 'fibres', name: 'Fibres', hint: 'Long flecks' },
  { id: 'rules', name: 'Ruled', hint: 'On the text baseline' },
  { id: 'grid', name: 'Grid', hint: 'Faint squares' },
  { id: 'dots', name: 'Dots', hint: 'Even speckle' },
]

/** The URL for a bundled texture id, or '' for an id that is not bundled. */
export function textureUrl(id) {
  return BUNDLED_TEXTURES.some((texture) => texture.id === id) ? `/textures/${id}.svg` : ''
}

export async function getSettings() {
  if (isTauri) {
    return { ...defaultSettings, ...(await (await tauriInvoke())('get_settings')) }
  }
  try {
    const raw = JSON.parse(localStorage.getItem('quill:settings') || 'null')
    if (raw && typeof raw === 'object') return { ...defaultSettings, ...raw }
  } catch {
    /* fall through to defaults */
  }
  return { ...defaultSettings }
}

/**
 * Persists settings. `value` may be a partial: omitted keys keep their stored
 * value. The Rust `set_settings` command merges its payload for the same reason,
 * so neither side re-applies defaults over fields the caller did not mention.
 */
export async function setSettings(value) {
  // The caller's object, with only the keys it actually named. Spreading
  // `defaultSettings` in here would re-apply every default over the stored
  // value, which is the same data loss as not merging on the Rust side.
  const patch = Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== undefined),
  )
  if (isTauri) {
    return { ...defaultSettings, ...(await (await tauriInvoke())('set_settings', { value: patch })) }
  }
  const current = await getSettings()
  const next = { ...current, ...patch }
  localStorage.setItem('quill:settings', JSON.stringify(next))
  return next
}

// ---------------------------------------------------------------------------
// Provider secrets
// ---------------------------------------------------------------------------

/**
 * Stores a provider credential. In the Tauri runtime the value is handed to the
 * Rust core once and written to the OS credential store; it is never persisted
 * in the webview. The browser fallback keeps it in memory for the session only.
 */
const memorySecrets = new Map()

export async function setProviderSecret(provider, secret) {
  if (isTauri) {
    return (await tauriInvoke())('set_provider_secret', { provider, secret })
  }
  memorySecrets.set(provider, secret)
  return { provider, hasCredential: true, updatedAt: new Date().toISOString() }
}

export async function getProviderSecretStatus(provider) {
  if (isTauri) {
    return (await tauriInvoke())('get_provider_secret_status', { provider })
  }
  return {
    provider,
    hasCredential: memorySecrets.has(provider),
    updatedAt: memorySecrets.has(provider) ? new Date().toISOString() : null,
  }
}

export async function deleteProviderSecret(provider) {
  if (isTauri) {
    await (await tauriInvoke())('delete_provider_secret', { provider })
    return
  }
  memorySecrets.delete(provider)
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
//
// The three commands above take a provider *id*, not the name a reader picked
// off a menu. The Rust side resolves which credential slot to read from the
// provider row a run will actually use, so passing a display name like 'OpenAI'
// wrote the key to a slot nothing ever read -- saved, reported ready, and
// useless. These read the registry so the panel can pass the id instead.

/**
 * The browser build's registry: one synthetic provider, so the panel renders.
 *
 * `npm run dev` in a browser has no Rust core behind it, so there is no real
 * provider row to read -- and an empty registry is not the neutral state it
 * looks like. The assistant's picker takes both its label and its entire option
 * list from the active provider, so with no row it rendered the literal text
 * "No model" inside a permanently disabled button. That reads as a broken app,
 * not as a browser-only build, and it is what this row is here to stop.
 *
 * Both strings say what they are. A model named after a real vendor's would
 * imply this build can answer with it; it cannot, because there is no transport
 * and no credential here, and a turn sent from the preview fails at the call and
 * reports that failure in the transcript. What the row buys is an honest picture
 * of the chrome -- one provider, one model, a menu that opens -- not an answer.
 *
 * The field set mirrors `providers::Provider` in the Rust core, enums included:
 * `Vendor::Compatible` and `Protocol::OpenaiChat` are its `snake_case` names.
 */
const BROWSER_PROVIDER = {
  id: 'browser-preview',
  label: 'Browser preview',
  vendor: 'compatible',
  protocol: 'openai_chat',
  baseUrl: '',
  defaultModel: 'preview',
  models: ['preview'],
  isActive: true,
}

let memoryProviders = [{ ...BROWSER_PROVIDER }]

/**
 * One provider row, in the one shape the UI reads.
 *
 * `providers::Provider` is `#[serde(rename_all = "camelCase")]`, so the core
 * sends `defaultModel` and `baseUrl` -- while every caller here read
 * `default_model` and `base_url` and got `undefined`. That is what put the
 * literal text "No model" in the assistant header of a real installation whose
 * registry held a model, and what left the Settings rows blank: the row was
 * there the whole time, under a name nothing looked for. The test fixtures were
 * written in the shape the *code* expected rather than the shape the core sends,
 * so nothing failed.
 *
 * Normalising at this boundary rather than at each call site means there is one
 * answer to "what is a provider" on this side of the IPC. The snake_case keys
 * are still read so a fixture, a cached value or an older payload keeps
 * rendering rather than going blank again.
 */
function normalizeProvider(row) {
  if (!row) return null
  return {
    id: row.id ?? '',
    label: row.label ?? '',
    vendor: row.vendor ?? 'compatible',
    protocol: row.protocol ?? 'openai_chat',
    baseUrl: row.baseUrl ?? row.base_url ?? '',
    defaultModel: row.defaultModel ?? row.default_model ?? '',
    models: Array.isArray(row.models) ? row.models : [],
    isActive: Boolean(row.isActive ?? row.is_active),
  }
}

export async function listProviders() {
  if (isTauri) {
    const rows = await (await tauriInvoke())('list_providers')
    return Array.isArray(rows) ? rows.map(normalizeProvider) : []
  }
  return memoryProviders.map((provider) => ({ ...provider }))
}

export async function getActiveProvider() {
  if (isTauri) return normalizeProvider(await (await tauriInvoke())('get_active_provider'))
  return memoryProviders.find((provider) => provider.isActive) ?? null
}

export async function setActiveProvider(id) {
  if (isTauri) {
    return normalizeProvider(await (await tauriInvoke())('set_active_provider', { id }))
  }
  memoryProviders = memoryProviders.map((provider) => ({
    ...provider,
    isActive: provider.id === id,
  }))
  return memoryProviders.find((provider) => provider.isActive) ?? null
}

/**
 * Creates a provider row.
 *
 * The input is camelCase because `NewProvider` is too -- Tauri only converts
 * *command arguments*, not fields inside a struct that is itself an argument, so
 * a `default_model` key here would be silently dropped and the row would be
 * created with no model at all.
 */
export async function createProvider(input) {
  if (isTauri) return normalizeProvider(await (await tauriInvoke())('create_provider', { input }))
  const row = { isActive: false, models: [], ...input }
  memoryProviders = [...memoryProviders.filter((provider) => provider.id !== row.id), row]
  return { ...row }
}

export async function updateProvider(input) {
  if (isTauri) return normalizeProvider(await (await tauriInvoke())('update_provider', { input }))
  memoryProviders = memoryProviders.map((provider) =>
    provider.id === input.id ? { ...provider, ...input } : provider,
  )
  return memoryProviders.find((provider) => provider.id === input.id) ?? null
}

export async function listProviderModels(provider) {
  if (isTauri) return (await tauriInvoke())('list_provider_models', { id: provider })
  return memoryProviders.find((row) => row.id === provider)?.models ?? []
}

/**
 * Coding tools installed on this machine, and the local model servers running.
 *
 * A row whose `baseUrl` is empty is a program Quill cannot send a turn to -- the
 * pipeline speaks HTTP and a CLI has no endpoint -- so the panel reports it and
 * offers nothing, which is the honest pair. A row with `models` is a server that
 * answered, and becoming a provider is one click.
 *
 * The browser build has no machine to inspect, so it reports none rather than
 * inventing a tool the reader could press.
 */
export async function detectCliTools() {
  if (isTauri) return (await tauriInvoke())('detect_cli_tools')
  return []
}

/** Whether an endpoint is served by this machine, and so needs no API key. */
export function isLocalEndpoint(baseUrl) {
  if (!baseUrl) return false
  const authority = String(baseUrl).replace(/^https?:\/\//, '').split('/')[0].split('@').pop()
  const host = authority.startsWith('[') ? authority.slice(1).split(']')[0] : authority.split(':')[0]
  return ['localhost', '::1', '0.0.0.0'].includes(host) || /^127\./.test(host)
}

// ---------------------------------------------------------------------------
// Custom themes
// ---------------------------------------------------------------------------

/**
 * The browser fallback's theme store.
 *
 * `localStorage` rather than memory, unlike the provider secrets: a theme is not
 * a secret, and losing every custom theme on reload would make the browser
 * runtime's picker look broken. The corrupt-value guard is the same one
 * `readLocalDocs` uses, for the same reason -- a hand-edited or half-written
 * value must not stop the app from starting.
 */
const LOCAL_THEMES_KEY = 'quill:custom-themes'

function readLocalThemes() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_THEMES_KEY) || '[]')
    return Array.isArray(raw)
      ? raw.filter((entry) => entry && typeof entry.theme_id === 'string' && typeof entry.name === 'string')
      : []
  } catch {
    return []
  }
}

function writeLocalThemes(themes) {
  try {
    localStorage.setItem(LOCAL_THEMES_KEY, JSON.stringify(themes))
  } catch (error) {
    console.error('Could not persist themes to localStorage', error)
  }
  return themes
}

/**
 * Every custom theme, in creation order.
 *
 * The Tauri path goes to the `custom_themes` table, which the seeded presets
 * are migrated in alongside, so a fresh install and this call agree.
 */
export async function listCustomThemes() {
  if (isTauri) {
    return (await tauriInvoke())('list_custom_themes')
  }
  return readLocalThemes()
}

/**
 * Creates or updates a theme, returning the stored record.
 *
 * The id is derived from the name on both sides of the bridge, so renaming a
 * theme to a name that already exists overwrites that theme rather than
 * creating a second one with a different id the reader cannot tell apart. The
 * validations mirror `account::save_theme` exactly: a browser-only theme that
 * the Tauri build would have rejected is a theme that behaves differently
 * depending on the runtime, which is the failure this fallback exists to avoid.
 */
export async function saveCustomTheme({ name, tokens, mode }) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('give the theme a name')
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new Error('a theme must be a set of colour tokens')
  }
  if (mode !== 'light' && mode !== 'dark') throw new Error('a theme is either light or dark')

  if (isTauri) {
    return (await tauriInvoke())('save_custom_theme', { name: trimmed, tokens, mode })
  }
  const themeId = slugify(trimmed)
  const existing = readLocalThemes()
  const next = {
    theme_id: themeId,
    name: trimmed,
    tokens,
    mode,
    updated_at: new Date().toISOString(),
  }
  const kept = existing.filter((entry) => entry.theme_id !== themeId)
  writeLocalThemes([...kept, { ...next, created_at: existing.find((entry) => entry.theme_id === themeId)?.created_at ?? next.updated_at }])
  return next
}

/** Removes a theme. Deleting one that is not there is not an error. */
export async function deleteCustomTheme(themeId) {
  const id = String(themeId ?? '')
  if (isTauri) {
    await (await tauriInvoke())('delete_custom_theme', { themeId: id })
    return
  }
  writeLocalThemes(readLocalThemes().filter((entry) => entry.theme_id !== id))
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function bootstrap() {
  if (isTauri) {
    const info = await (await tauriInvoke())('bootstrap')
    return { ...info, runtime: runtime.label, tauri: true }
  }
  return {
    appVersion: 'browser-dev',
    platform: 'browser',
    databasePath: 'localStorage',
    documentCount: readLocalDocs().length,
    settings: await getSettings(),
    runtime: runtime.label,
    tauri: false,
  }
}

// ---------------------------------------------------------------------------
// Onboarding state
// ---------------------------------------------------------------------------

const LOCAL_ONBOARDING_KEY = 'quill:onboarding'

/**
 * First-run state, as a key/value table rather than columns.
 *
 * The Tauri path is the `onboarding_state` table seeded by migration `0002`. The
 * browser path is `localStorage`, and the default is `'true'` rather than
 * `'false'` -- a browser has no migration to seed the row, so defaulting to
 * "not completed" would show the welcome card to every developer opening the dev
 * server. A first run in a real install arrives here as an explicit `'false'`,
 * which is where `reconcile_onboarding_completed` has already had its say about
 * existing libraries.
 */
export async function readOnboarding(key, fallback = 'true') {
  if (isTauri) {
    return (await tauriInvoke())('onboarding_value', { key, default: fallback })
  }
  const raw = JSON.parse(localStorage.getItem(LOCAL_ONBOARDING_KEY) || '{}')
  return Object.prototype.hasOwnProperty.call(raw, key) ? String(raw[key]) : fallback
}

export async function writeOnboarding(key, value) {
  if (isTauri) {
    await (await tauriInvoke())('onboarding_set', { key, value })
    return
  }
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_ONBOARDING_KEY) || '{}')
    localStorage.setItem(
      LOCAL_ONBOARDING_KEY,
      JSON.stringify({ ...raw, [key]: value }),
    )
  } catch (error) {
    console.error('Could not persist onboarding state to localStorage', error)
  }
}

// ---------------------------------------------------------------------------
// Thesis runs (pipeline sidecar)
// ---------------------------------------------------------------------------

/**
 * The thesis run, over the same seam as everything else privileged.
 *
 * A run is a server-driven job on a Python sidecar that the desktop app never
 * runs itself, so the frontend never opens a socket to it either — the webview's
 * CSP allows `connect-src` to the app's own port and nothing else. Commands go
 * out through `invoke` and progress comes back as a `quill://run-event`
 * emission, which is the only shape a seven-to-twenty-minute job can report in.
 *
 * The browser fallback follows the rule the rest of this file follows. Reads
 * answer with a value that says so plainly; actions either reject with a message
 * a reader could read or do nothing at all. Nothing here pretends a run
 * happened, because a fabricated `runId` would be a transcript that reports a
 * document nobody wrote.
 */
const UNAVAILABLE = Object.freeze({
  state: 'unavailable',
  detail: 'Writing a thesis needs the desktop app.',
})

/** What the sidecar says about itself. Never rejects. */
export async function pipelineStatus() {
  if (!isTauri) return { ...UNAVAILABLE }
  try {
    return await (await tauriInvoke())('pipeline_status')
  } catch (error) {
    return { state: 'failed', detail: describeFailure(error) }
  }
}

/** Today's token usage per model, as the sidecar counted it. */
export async function usageStats() {
  if (!isTauri) return { date: '', limit: 0, models: {} }
  try {
    return await (await tauriInvoke())('usage_stats')
  } catch (error) {
    console.error('Failed to read usage', error)
    return { date: '', limit: 0, models: {} }
  }
}

/** One inline completion. Optional assist: failures resolve to empty text. */
export async function complete({ before, after } = {}) {
  if (!isTauri) return ''
  try {
    return (await (await tauriInvoke())('api_complete', { before: before ?? '', after: after ?? '' })) || ''
  } catch (error) {
    console.warn('Completion unavailable', error)
    return ''
  }
}

/** Asks Rust to bring the sidecar up. Resolves with the state it settled in. */
export async function pipelineStart() {
  if (!isTauri) return { ...UNAVAILABLE }
  try {
    return await (await tauriInvoke())('pipeline_start')
  } catch (error) {
    return { state: 'failed', detail: describeFailure(error) }
  }
}

export async function pipelineStop() {
  if (!isTauri) return { ...UNAVAILABLE }
  try {
    return await (await tauriInvoke())('pipeline_stop')
  } catch (error) {
    return { state: 'failed', detail: describeFailure(error) }
  }
}

/**
 * Starts a run and returns `{ runId, status, events }`.
 *
 * `documentId`, `sessionName` and `conceptMode` are optional on both sides of
 * the bridge, and are omitted rather than sent null so a future Rust argument
 * that is genuinely required is a visible error instead of a silent default.
 */
export async function startRun({ prompt, documentId, sessionName, conceptMode } = {}) {
  if (!isTauri) throw new Error('Writing a thesis needs the desktop app.')
  return (await tauriInvoke())('api_start_run', {
    prompt,
    documentId: documentId ?? null,
    sessionName: sessionName ?? null,
    conceptMode: conceptMode ?? null,
  })
}

/**
 * Asks the assistant one question and returns `{ reply, transport, task, sources }`.
 *
 * `transport` says whether the sidecar or a direct provider call answered. It is
 * returned rather than swallowed because the two are not equivalent: the sidecar
 * can ground an answer in the pipeline's research, a direct call cannot.
 *
 * `task` is the kind of turn the sidecar classified (`WRITE`, `EXPLAIN`, ...) and
 * `sources` are the pages it grounded the answer in. Both are empty from the
 * direct path, which does not classify and cannot research -- a panel that showed
 * them unconditionally would claim grounding the answer never had.
 *
 * A genuine failure rejects. The panel renders that as a failure bubble; it is not
 * an empty answer, and must not be shown as one.
 *
 * `messages` is the transcript so far and `draft` is what is on screen. The
 * draft travels with the request because this layer cannot read the editor, and
 * an answer about "this paragraph" is worthless if the paragraph did not go
 * with it.
 */
/**
 * One assistant turn, reporting its stages as they happen.
 *
 * `onStage` is called with `{ step, t }` each time the sidecar logs something it
 * has a readable name for -- "Reading the question", "Searching the web". It is
 * optional: the reply is the same either way, and a caller that ignores it just
 * waits.
 *
 * The turn id is not bookkeeping. Every turn's stages arrive on the same
 * channel, and turns are not serialised -- a second question can be asked while
 * the first is still answering -- so the id is the only thing that stops one
 * turn's progress appearing inside another's bubble.
 */
export async function chat({ messages, draft, conceptMode, variant, tokenSaving, naturalVoice, writingProfile, researchMode, onStage } = {}) {
  if (!isTauri) throw new Error('The assistant needs the desktop app.')
  const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const release = typeof onStage === 'function'
    ? subscribe('quill://chat-stage', (payload) => {
      if (payload?.turnId !== turnId) return
      const step = String(payload?.step || '').trim()
      if (step) onStage({ step, t: Number(payload?.t) || 0 })
    })
    : () => {}
  try {
    return await (await tauriInvoke())('api_chat_stream', {
      turnId,
      messages: (messages ?? []).map(({ role, content }) => ({ role, content })),
      draft: draft ?? null,
      conceptMode: conceptMode ?? 'reference',
      variant: variant ?? 'balanced',
      tokenSaving: Boolean(tokenSaving),
      naturalVoice: Boolean(naturalVoice),
      writingProfile: writingProfile || null,
      researchMode: Boolean(researchMode),
    })
  } finally {
    release()
  }
}

/**
 * A short clarifying questionnaire for the current request.
 *
 * Returns `[{ header, question, multiSelect, options }]`, or throws with the
 * model's reason. The panel renders one card, so this is deliberately not a
 * chat turn: it must not write to the document or run research.
 */
export async function questionnaire({ messages, draft, tokenSaving } = {}) {
  if (!isTauri) throw new Error('The assistant needs the desktop app.')
  const payload = await (await tauriInvoke())('api_questionnaire', {
    messages: (messages ?? []).map(({ role, content }) => ({ role, content })),
    draft: draft ?? null,
    tokenSaving: Boolean(tokenSaving),
  })
  if (payload?.error) throw new Error(String(payload.error))
  const questions = Array.isArray(payload?.questions) ? payload.questions : []
  if (!questions.length) throw new Error('The assistant returned no questions.')
  return questions
}

/** Check the public release feed for a newer Quill. */
export async function checkUpdates() {
  if (!isTauri) return { current: 'browser-dev', available: false, error: 'Updates need the desktop app.' }
  return (await tauriInvoke())('check_updates')
}

/** Open a release page in the system browser. */
export async function openExternal(url) {
  if (!url) return
  if (!isTauri) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

/** Build a local writing profile from the reader's own documents. */
export async function profileWritingStyle({ texts } = {}) {
  if (!isTauri) throw new Error('The writing profile needs the desktop app.')
  return (await tauriInvoke())('api_profile', { texts: (texts ?? []).map(String) })
}

/** Transcribe one short voice recording through the provider. */
export async function transcribeAudio({ audio, mime, filename } = {}) {
  if (!isTauri) throw new Error('Voice input needs the desktop app.')
  return (await tauriInvoke())('api_transcribe', {
    audio,
    mime: mime ?? 'audio/webm',
    filename: filename ?? 'recording.webm',
  })
}

/**
 * Resolve the citations in a draft and search open indexes for copied text.
 *
 * Slow and explicit: it talks to Crossref, OpenAlex, ORCID, Wikidata and
 * Marginalia, so it is a command the reader asks for, never a background scan.
 */
export async function verifyText({ text } = {}) {
  if (!isTauri) throw new Error('Verification needs the desktop app.')
  return (await tauriInvoke())('api_verify', { text: text ?? '' })
}

export async function runStatus(runId) {
  if (!isTauri) throw new Error('Writing a thesis needs the desktop app.')
  return (await tauriInvoke())('api_run_status', { runId })
}

export async function cancelRun(runId) {
  if (!isTauri) return
  await (await tauriInvoke())('api_cancel_run', { runId })
}

/**
 * Opens the event stream for a run.
 *
 * Resolves when the stream ends, so it is meant to be started and not awaited:
 * the events themselves arrive as `quill://run-event` emissions, which is the
 * only way progress can be shown while the job is still running.
 *
 * `since` is the last sequence number the caller saw. The stream is resumable,
 * so a panel that reconnects replays what it missed rather than restarting.
 */
export async function streamRun(runId, since) {
  if (!isTauri) return
  await (await tauriInvoke())('api_stream_run', { runId, since: since ?? null })
}

/**
 * Subscribes to run progress. The callback receives the raw event payload.
 *
 * The unsubscribe is returned synchronously rather than as a promise, because the
 * only place that holds it is an effect cleanup, which cannot await. That makes
 * one race worth handling: a teardown that runs before `listen` resolves still
 * has to remove the listener, since an unlisten nobody holds is a listener
 * nobody removes.
 *
 * `quill://run-event` is emitted for every run, so a callback that cares about
 * one in particular filters by `runId` itself.
 */
export function onRunEvent(callback) {
  return subscribe('quill://run-event', callback)
}

/** Subscribes to the sidecar's own lifecycle: `ready`, `starting`, `stopped`, `failed`. */
export function onPipelineStatus(callback) {
  return subscribe('quill://pipeline-status', callback)
}

function subscribe(event, callback) {
  if (!isTauri) return () => {}
  let unlisten = null
  let released = false
  tauriListen(event, (received) => callback(received?.payload))
    .then((release) => {
      if (released) release()
      else unlisten = release
    })
    .catch(() => {
      // A webview with no event channel cannot stream progress, but it can still
      // run everything else in the app, so this is not worth a dialog.
    })
  return () => {
    released = true
    if (unlisten) unlisten()
  }
}

/** A rejected command is either a sidecar that is not up or a run that refused. */
export function describeFailure(error) {
  const message = String(error?.message ?? error ?? '').trim()
  if (!message) return 'The writing service did not answer.'
  if (/offline|unreachable|connect/i.test(message)) {
    return 'The writing service is not running. Start it, then try again.'
  }
  return message
}

// ---------------------------------------------------------------------------
// Legacy import
// ---------------------------------------------------------------------------

/**
 * Classifies a legacy Python JSON store without writing anything.
 *
 * The user should always be able to review the plan before importing, so this is
 * deliberately separate from `legacyImport`.
 */
export async function legacyScan(path) {
  if (!isTauri) throw new Error('Legacy import requires the desktop app')
  return (await tauriInvoke())('legacy_scan', { path })
}

/** Imports validated legacy documents. Idempotent; safe to call repeatedly. */
export async function legacyImport(path) {
  if (!isTauri) throw new Error('Legacy import requires the desktop app')
  return (await tauriInvoke())('legacy_import', { path })
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const FORMATS = [
  { format: 'html', extension: 'html', label: 'Web page', description: 'A single self-contained HTML file' },
  { format: 'pdf', extension: 'pdf', label: 'PDF', description: 'Print-ready document with page numbers' },
  { format: 'docx', extension: 'docx', label: 'Word document', description: 'Editable .docx for Word and LibreOffice' },
  { format: 'epub', extension: 'epub', label: 'EPUB', description: 'Reflowable e-book' },
  { format: 'markdown', extension: 'md', label: 'Markdown', description: 'Plain .md, keeps the outline' },
]

/** Export formats, in the order the dialog shows them. */
export function exportFormats() {
  return FORMATS
}

/**
 * Renders a document and writes it atomically to `path`.
 *
 * Markdown is serialised here on the frontend via `@tiptap/markdown`; every
 * other format is built by Rust from the ProseMirror JSON.
 *
 * @param {object} options
 * @param {string} options.path
 * @param {string} options.format one of the keys from `exportFormats()`
 * @param {string} options.title
 * @param {object} [options.document] ProseMirror JSON
 * @param {string} [options.markdown] pre-serialised Markdown
 * @param {string} [options.author]
 */
export async function exportDocument({ path, format, title, document, markdown, author }) {
  if (!isTauri) throw new Error('Export requires the desktop app')
  return (await tauriInvoke())('export_document', {
    request: { path, format, title, document: document ?? null, markdown: markdown ?? null, author: author ?? null },
  })
}

/**
 * Asks the user to choose an image, and returns its `data:` URL.
 *
 * P4-3, and the reason `read_image_as_data_url` exists. The webview has no
 * `fs:` permission and no `assetProtocol`, so a `File` from an `<input>` would
 * have to be read through the plugin-fs plugin with a broad scope. Instead the
 * dialog returns a path the reader chose, one Rust command reads that path, and
 * the bytes come back inline. The scope the reader granted is one file, chosen
 * by them, for as long as the setting is stored.
 *
 * `size` is checked on both sides -- `images::MAX_BYTES` in Rust and the 4 MB
 * cap on the encoded URL -- because a 3.8 MB photo becomes a 5.1 MB base64
 * string, and refusing it after the reader has already picked it would be a
 * worse experience than refusing the file in the dialog's own filter.
 *
 * Returns `null` when the dialog is dismissed or the browser build is running.
 * Errors propagate: a file the reader picked and cannot use is a message, not a
 * silent no-op.
 */
export async function pickImageAsDataUrl({ title, sizeHint = 'Images' } = {}) {
  if (!isTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const path = await open({
    title: title || 'Choose an image',
    multiple: false,
    directory: false,
    filters: [{ name: sizeHint, extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
  })
  if (typeof path !== 'string' || !path) return null
  return (await tauriInvoke())('read_image_as_data_url', { path })
}

/**
 * Asks the user where to save, defaulting to the document's filename.
 * Returns null when the dialog is dismissed.
 */
export async function pickExportPath({ title, extension }) {
  if (!isTauri) return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  const safeBase = slugify(title || 'document')
  return save({
    title: 'Export document',
    defaultPath: `${safeBase}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  })
}

// ---------------------------------------------------------------------------
// Window helpers (Tauri only)
// ---------------------------------------------------------------------------

export async function setWindowTitle(title) {
  if (!isTauri) {
    if (typeof document !== 'undefined') document.title = title
    return
  }
  if (!coreModule) coreModule = await import('@tauri-apps/api/window')
  await coreModule.getCurrentWindow().setTitle(title)
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/**
 * The account bridge.
 *
 * Six commands, one shape. Args are camelCase because that is what Tauri
 * converts to the Rust command's snake_case parameters, so `syncConfigWrite` sends
 * `baseUrl` for `base_url` and `syncEnabled` for `sync_enabled`.
 *
 * The browser fallback keeps the account mirror in memory, like
 * `memorySecrets` above, and deliberately *not* in `localStorage` like the themes
 * directly below it. The mirror is a bearer token's worth of identity: writing
 * "who am I, and to which server" somewhere any script on the page can read is
 * the same mistake as storing a provider key there, and the themes are the
 * counter-example rather than the precedent. Losing the mirror on reload in
 * `npm run dev` is the correct trade: the next launch is signed out, which is a
 * perfectly valid state for a local-only reader.
 */
const memoryAccount = new Map()

/** What a reader who is not signed in looks like, in both runtimes. */
const SIGNED_OUT_STATE = Object.freeze({
  signedIn: false,
  account: null,
  online: false,
  syncEnabled: false,
  baseUrl: '',
})

const readMemoryAccount = () => memoryAccount.get('current') || SIGNED_OUT_STATE

/** The reader's account and sync state. Never rejects on a signed-out reader. */
export async function accountState() {
  if (isTauri) return (await tauriInvoke())('account_state')
  return { ...readMemoryAccount() }
}

/**
 * Creates an account and signs in.
 *
 * The browser fallback fabricates a mirror from whatever was typed rather than
 * pretending to reach a server. It is a lie told only to the developer running
 * `npm run dev`, and it is the useful kind: the account UI is otherwise
 * unreachable without a PocketBase deployment, and `online: false` is returned
 * honestly rather than faked, so the "unreachable" state is visible in dev too.
 */
export async function accountSignUp({ email, password, name }) {
  if (isTauri) return (await tauriInvoke())('account_sign_up', { email, password, name })
  return rememberLocalAccount({ email, password, name })
}

export async function accountSignIn({ email, password }) {
  if (isTauri) return (await tauriInvoke())('account_sign_in', { email, password })
  return rememberLocalAccount({ email, password, name: '' })
}

export async function accountRefresh() {
  if (isTauri) return (await tauriInvoke())('account_refresh')
  return { ...readMemoryAccount() }
}

/** Forgets the mirror. The keyring slot is cleared on the Rust side. */
export async function accountSignOut() {
  if (isTauri) return (await tauriInvoke())('account_sign_out')
  memoryAccount.delete('current')
  return { ...SIGNED_OUT_STATE }
}

/**
 * Points the account at a deployment and sets the sync opt-in.
 *
 * A full overwrite of both columns, not a patch. `configWriteArgs` is the only
 * sanctioned way to build this argument, so a caller flipping the toggle cannot
 * forget to echo the endpoint it is keeping.
 */
export async function syncConfigWrite({ baseUrl, syncEnabled }) {
  if (isTauri) return (await tauriInvoke())('sync_config_write', { baseUrl, syncEnabled })
  const current = readMemoryAccount()
  const next = { ...current, baseUrl: baseUrl || '', syncEnabled: Boolean(syncEnabled) }
  if (next.signedIn) memoryAccount.set('current', next)
  return { ...next }
}

/**
 * The browser stand-in for a successful sign-in.
 *
 * The password is read and dropped on the floor. It is not stored anywhere, not
 * even in this module's memory, and the email is kept because it is the one
 * thing the UI has to show. `id` is derived from the address rather than random so
 * a reload within a session is stable.
 */
function rememberLocalAccount({ email, password, name }) {
  const clean = String(email || '').trim()
  if (!clean) {
    throw new Error('Enter an email address.')
  }
  if (String(password || '').length < 10) {
    throw new Error('Use at least 10 characters.')
  }
  const state = {
    signedIn: true,
    account: {
      id: `local:${clean.toLowerCase()}`,
      email: clean,
      name: name || '',
      workspace: 'Personal',
    },
    online: false,
    syncEnabled: false,
    baseUrl: '',
  }
  memoryAccount.set('current', state)
  return { ...state }
}
