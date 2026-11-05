/**
 * Shared jsdom harness for the render suites.
 *
 * Extracted so the two render suites cannot drift apart. They differ in exactly
 * one respect, which is the whole point of having two:
 *
 *   app-render.test.mjs        mocks framer-motion
 *   app-render-motion.test.mjs uses the real framer-motion
 *
 * Everything else — the JSDOM instance, the globals, the browser API gaps, and
 * the stubbed Tauri IPC — is identical.
 */

import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'

/** Two documents in different collections, so a filter click has work to do. */
export const DOCS = [
  {
    id: 'doc-1',
    title: 'Stub Document',
    kind: 'Essay',
    collections: ['Essays'],
    status: 'Drafts',
    color: '#8a5a2b',
    filename: 'stub-document.md',
    content: '<h2>Heading</h2><p>Body text.</p>',
    contentFormat: 'html',
    schemaVersion: 1,
    cloudId: null,
    syncState: 'local_only',
    cloudRevision: 0,
    provenance: 'stub',
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    deletedAt: null,
  },
  {
    id: 'doc-2',
    title: 'Stub Chapter',
    kind: 'Chapter',
    collections: ['Chapters'],
    status: 'Published',
    color: '#3d7dff',
    filename: 'stub-chapter.md',
    content: '<h2>Opening</h2><p>Chapter text.</p>',
    contentFormat: 'html',
    schemaVersion: 1,
    cloudId: null,
    syncState: 'local_only',
    cloudRevision: 0,
    provenance: 'stub',
    createdAt: '2026-01-02 00:00:00',
    updatedAt: '2026-01-02 00:00:00',
    deletedAt: null,
  },
]

export const SETTINGS = {
  theme: 'light',
  font: 'Arial',
  density: 'comfortable',
  autosave: true,
  spellcheck: true,
  wordCount: true,
  reduceMotion: false,
  // P4-2, P4-3, P4-4. Present and empty so a test can see the defaults rather
  // than inferring them from what the dialog happens to render.
  editorTexture: '',
  editorTextureData: '',
  wallpaper: '',
  surfaceAlpha: 100,
  scrim: 0,
  textureWash: null,
}

export const imageFixtures = { next: null, error: '' }
export const dialogFixtures = { open: null, save: null }
export const onboardingFixtures = { state: { completed: 'true' } }

/**
 * The account mirror, as a table, for the same reason `onboardingFixtures` is.
 *
 * P6-8. The six account commands all read and write one row, so a stub that
 * returned a constant would make sign-out look like it worked and sign-in look
 * idempotent.
 *
 * Module-private, where it used to be exported for a test to seed. The chip that
 * suite mounted the app to look at is gone, and `account_state` is now only read
 * for the export author, so no test describes an install any more -- but the
 * stubs below still need one row to share, and it has to start signed out
 * because that is what a fresh install is.
 */
const accountState = { signedIn: false, account: null, online: false, syncEnabled: false, baseUrl: '' }

/**
 * Which provider credentials exist, as a set, for the same reason the account
 * mirror above is a table.
 *
 * `set_provider_secret` returns a status, but the panel asks
 * `get_provider_secret_status` for the row's stored state, so a constant `false`
 * there answered "no key" immediately after a successful write -- which would
 * make a working connect look like a failed one and hide the very thing the
 * provider tests check.
 */
let storedCredentials = new Set()

export const calls = []
export const state = { failBootstrap: false }

/**
 * The custom-theme table the stubbed commands read and write.
 *
 * A fixture rather than a constant, because the picker saves and deletes, and a
 * test that needs a theme to already exist has to be able to say which ones.
 */
export const themeFixtures = {
  list: () => customThemesFixture,
  save: (args) => {
    const themeId = String(args?.name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom-theme'
    const next = { theme_id: themeId, name: args?.name, tokens: args?.tokens ?? {}, mode: args?.mode }
    customThemesFixture = [...customThemesFixture.filter((t) => t.theme_id !== themeId), next]
    return next
  },
  remove: (themeId) => {
    customThemesFixture = customThemesFixture.filter((t) => t.theme_id !== themeId)
    return null
  },
  reset: (themes = []) => { customThemesFixture = themes },
}

/**
 * The provider registry, as a table, for the same reason the theme fixtures are.
 *
 * The assistant panel reads this to learn which row a key belongs to and whether
 * one already exists, so a constant would hide the difference between "no
 * provider selected" and "this provider, with no key yet" -- the two states the
 * panel has to tell apart. The seed is the shape a first launch produces: one
 * active provider whose label is the host it adopted.
 */
const SEEDED_PROVIDER = {
  id: 'compatible',
  label: 'api.groq.com',
  vendor: 'compatible',
  protocol: 'openai_chat',
  baseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'openai/gpt-oss-20b',
  models: [],
  isActive: true,
}

let providerFixturesList = [{ ...SEEDED_PROVIDER }]

export const providerFixtures = {
  list: () => providerFixturesList.map((provider) => ({ ...provider })),
  active: () => providerFixturesList.find((provider) => provider.isActive) ?? null,
  setActive: (id) => {
    providerFixturesList = providerFixturesList.map((provider) => ({
      ...provider,
      isActive: provider.id === id,
    }))
    return providerFixturesList.find((provider) => provider.isActive) ?? null
  },
  update: (input) => {
    providerFixturesList = providerFixturesList.map((provider) =>
      provider.id === input?.id ? { ...provider, ...input } : provider,
    )
    return providerFixturesList.find((provider) => provider.id === input?.id) ?? null
  },
  reset: () => { providerFixturesList = [{ ...SEEDED_PROVIDER }] },
}

let customThemesFixture = []

export const handlers = {
  bootstrap: () => ({
    appVersion: 'test',
    platform: 'test',
    databasePath: ':memory:',
    documentCount: DOCS.length,
    settings: SETTINGS,
  }),
  list_documents: () => DOCS,
  get_document: (args) => DOCS.find((d) => d.id === args?.id) ?? DOCS[0],
  ydoc_load: () => ({ snapshot: null, stateVector: null, updates: [], hasMore: false }),
  ydoc_append_update: () => 'update-id',
  ydoc_pending_count: () => 0,
  ydoc_compact: () => 0,
  get_settings: () => SETTINGS,
  set_settings: (args) => args?.value ?? SETTINGS,
  set_provider_secret: (args) => {
    storedCredentials.add(args?.provider)
    return { provider: args?.provider, hasCredential: true, updatedAt: null }
  },
  get_provider_secret_status: (args) => ({
    provider: args?.provider,
    hasCredential: storedCredentials.has(args?.provider),
    updatedAt: null,
  }),
  delete_provider_secret: (args) => {
    storedCredentials.delete(args?.provider)
    return null
  },
  // The registry the assistant panel reads to learn which provider a key belongs
  // to. `get_provider_secret_status` above stays a constant because a test that
  // wants the "Key ready" row seeds it; these four keep the registry itself real
  // enough to switch between providers.
  list_providers: () => providerFixtures.list(),
  get_active_provider: () => providerFixtures.active(),
  set_active_provider: (args) => providerFixtures.setActive(args?.id),
  update_provider: (args) => providerFixtures.update(args?.input),
  create_provider: (args) => {
    const row = { models: [], isActive: false, vendor: 'compatible', protocol: 'openai_chat', ...args?.input }
    providerFixturesList = [...providerFixturesList.filter((provider) => provider.id !== row.id), row]
    return row
  },
  // Nothing is installed on the machine the tests run on, and detection is a
  // filesystem probe the suite has no business performing.
  detect_cli_tools: () => [],
  list_provider_models: (args) =>
    providerFixtures.list().find((provider) => provider.id === args?.id)?.models ?? [],
  // Custom themes are a table, not a fixed fixture, so these keep their own list
  // and a test can seed it before the app boots. A fresh install also has the
  // six migrated presets, which `themeFixtures` stands in for here; the seeded
  // rows themselves are covered by the Rust and Phase 3 tests.
  list_custom_themes: () => themeFixtures.list(),
  save_custom_theme: (args) => themeFixtures.save(args),
  delete_custom_theme: (args) => themeFixtures.remove(args?.themeId),
  // Renaming the title writes through here. The real command takes a single
  // `input` object where an unset field is null and means "leave unchanged",
  // so a stub that reads `args.id`/`args.patch` silently returns the base
  // document and clobbers the caller's optimistic update.
  // P4-3. A test seeds `imageFixtures.next` to stand in for a file the reader
  // chose. The real command reads the path the dialog returned, which a jsdom
  // test cannot do, so this returns the bytes directly.
  read_image_as_data_url: () => {
    if (imageFixtures.error) throw new Error(imageFixtures.error)
    return imageFixtures.next
  },
  // P5-2. The first-run state is a key/value table, so the stub is one too: a
  // test seeds `onboardingFixtures.state` to describe an install and then asserts
  // on the keys the flow wrote. `completed` defaults to 'true' because a seeded
  // test library is an existing install -- the same answer P5-0 gives on the
  // Rust side -- so the welcome card does not appear over every other test.
  onboarding_value: (args) =>
    Object.prototype.hasOwnProperty.call(onboardingFixtures.state, args?.key)
      ? onboardingFixtures.state[args.key]
      : (args?.default ?? ''),
  onboarding_set: (args) => {
    onboardingFixtures.state[args?.key] = args?.value
    return null
  },
  // P6-1/P6-8. The six account commands. `account_sign_up` and
  // `account_sign_in` write the mirror the way the real ones do, and every
  // command returns the whole `AccountState` because that is the contract: the
  // app renders from the return value rather than re-reading, so a stub that
  // returned `null` would force a second call and hide which one failed.
  account_state: () => ({ ...accountState }),
  account_sign_up: (args) => {
    accountState = {
      signedIn: true,
      account: {
        id: 'test-1',
        email: args?.email ?? '',
        name: args?.name ?? '',
        workspace: 'Personal',
      },
      online: false,
      syncEnabled: false,
      baseUrl: '',
    }
    return { ...accountState }
  },
  account_sign_in: (args) => {
    accountState = {
      ...accountState,
      signedIn: true,
      account: { id: 'test-1', email: args?.email ?? '', name: '', workspace: 'Personal' },
    }
    return { ...accountState }
  },
  account_refresh: () => ({ ...accountState }),
  account_sign_out: () => {
    accountState = { signedIn: false, account: null, online: false, syncEnabled: false, baseUrl: '' }
    return { ...accountState }
  },
  // A full overwrite of both columns, deliberately. A stub that patched would
  // let a caller forget to echo `baseUrl` and the bug P6-7 exists to catch would
  // pass in tests and fail in the app.
  sync_config_write: (args) => {
    accountState = {
      ...accountState,
      baseUrl: args?.baseUrl ?? '',
      syncEnabled: Boolean(args?.syncEnabled),
    }
    return { ...accountState }
  },
  update_document: (args) => {
    const input = args?.input ?? {}
    const base = DOCS.find((d) => d.id === input.id) ?? DOCS[0]
    const merged = { ...base }
    for (const [key, value] of Object.entries(input)) {
      if (value !== null && value !== undefined) merged[key] = value
    }
    return { ...merged, updatedAt: new Date().toISOString() }
  },
}

/**
 * The Tauri event plugin, stubbed to the shape the real runtime provides.
 *
 * `@tauri-apps/api/event` is not mocked, so its `listen` walks the same path it
 * walks in the webview: `transformCallback` hands it an id, then it calls
 * `plugin:event|listen`. Without these the subscribe throws `unstubbed command`,
 * and a component that listens for run events would be silently untestable --
 * which is how a broken unsubscribe can survive a green suite.
 */
const eventCallbacks = new Map()
const eventListeners = new Map()
let nextCallbackId = 1
let nextEventId = 1

/** Register a handler and return the id the runtime would hand back. */
export function transformCallback(callback) {
  const id = nextCallbackId++
  eventCallbacks.set(id, callback)
  return id
}

/**
 * Deliver an event to everything currently listening for it.
 *
 * Tests drive the run stream through this rather than by poking component state,
 * so what is asserted is the path the reader's own clicks take.
 */
export function emit(event, payload, id = 0) {
  const listeners = eventListeners.get(event)
  if (!listeners) return 0
  let delivered = 0
  for (const [eventId, callbackId] of listeners) {
    const callback = eventCallbacks.get(callbackId)
    if (!callback) continue
    callback({ event, id, payload })
    delivered += 1
  }
  return delivered
}

/** How many live listeners an event currently has. A leak shows up here. */
export const listenerCount = (event) => eventListeners.get(event)?.size ?? 0

export async function invoke(command, args) {
  calls.push({ command, args })
  if (state.failBootstrap && command === 'bootstrap') {
    throw new Error('simulated bootstrap failure')
  }
  if (command === 'plugin:event|listen') {
    const listeners = eventListeners.get(args.event) ?? new Map()
    const eventId = nextEventId++
    listeners.set(eventId, args.handler)
    eventListeners.set(args.event, listeners)
    return eventId
  }
  if (command === 'plugin:event|unlisten') {
    eventListeners.get(args.event)?.delete(args.eventId)
    return null
  }
  const handler = handlers[command]
  if (!handler) throw new Error(`unstubbed command: ${command}`)
  return handler(args ?? {})
}

export const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:1420',
  pretendToBeVisual: true,
})

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })

define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('HTMLDivElement', dom.window.HTMLDivElement)
define('HTMLInputElement', dom.window.HTMLInputElement)
// Radix's Select renders a hidden form to drive its typeahead, and reads
// `HTMLFormElement` off the global to decide whether it is in a form context.
// Browsers have it; this JSDOM window is not given it by default, and without
// it mounting any Select throws before a single assertion runs.
define('HTMLFormElement', dom.window.HTMLFormElement ?? class HTMLFormElement {})
// Radix renders through portals (`DocumentFragment`) and keeps a hidden native
// `select` alongside its own listbox for form submission and mobile pickers.
// Both globals are absent from a bare Node global scope even though JSDOM has
// them on its window, so a Select throws on mount without these.
define('DocumentFragment', dom.window.DocumentFragment ?? class DocumentFragment {})
define('HTMLSelectElement', dom.window.HTMLSelectElement ?? class HTMLSelectElement {})
// Node ships its own `CustomEvent`, and JSDOM's `dispatchEvent` rejects it
// because it is not a JSDOM `Event`. Radix's focus scope dispatches a
// `CustomEvent` on the dialog when it unmounts, so the Node global turns a closed
// dialog into a crash rather than a no-op.
define('CustomEvent', dom.window.CustomEvent)
define('Node', dom.window.Node)
// Radix enumerates tabbable candidates with `createTreeWalker`, which takes
// `NodeFilter.SHOW_ELEMENT` as a bare global. Node defines no `NodeFilter`, so
// the mount-time autofocus path throws on the reference alone.
define('NodeFilter', dom.window.NodeFilter)
define('DOMParser', dom.window.DOMParser)
define('getSelection', () => dom.window.getSelection())
// framer-motion and ProseMirror both probe these constructors.
define('SVGElement', dom.window.SVGElement ?? class SVGElement {})
define('Element', dom.window.Element)
define('Range', dom.window.Range)
define('Selection', dom.window.Selection ?? class Selection {})
define('MutationObserver', dom.window.MutationObserver)
define('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })

/**
 * Pointer capture and scrolling, which Radix's Select drives and JSDOM has
 * neither of.
 *
 * A Radix `SelectTrigger` opens on `pointerdown`, not `click`, and its items are
 * selected on `pointerup`. It also asks the element whether it has captured the
 * pointer before it will move the highlight, and scrolls the active item into
 * view on open. Without these four, opening a Select throws rather than failing
 * an assertion, which is why the first attempt at migrating one never reached a
 * single test.
 */
for (const [name, value] of Object.entries({
  hasPointerCapture: () => false,
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
})) {
  if (typeof dom.window.Element.prototype[name] !== 'function') {
    dom.window.Element.prototype[name] = value
  }
}

/**
 * A pointer press, which is what Radix listens for.
 *
 * `button: 0` and no modifier are required: the trigger ignores anything else,
 * which is correct behaviour and would otherwise read as a Select that refuses
 * to open.
 */
export const pointerDown = (node, init = {}) => {
  const event = new dom.window.MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  })
  // Radix reads `pointerType` off the event, and a plain MouseEvent has none.
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  node.dispatchEvent(event)
  return event
}

/** The matching `pointerup`, which is what actually commits a Radix selection. */
export const pointerUp = (node, init = {}) => {
  const event = new dom.window.MouseEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  node.dispatchEvent(event)
  return event
}
/**
 * Every `IntersectionObserver` constructed since the harness loaded, in order.
 *
 * The effect libraries construct these during render, so the array is expected
 * to be non-empty. It is also the only way to test code that reacts to
 * intersection, because jsdom computes no geometry: nothing ever intersects on
 * its own, so `emitIntersections` drives the callback by hand.
 */
export const intersectionObservers = []

define('IntersectionObserver', class {
  constructor(cb, options = {}) {
    this.cb = cb
    this.options = options
    this.targets = []
    this.disconnected = false
    intersectionObservers.push(this)
  }
  observe(target) { this.targets.push(target) }
  unobserve(target) { this.targets = this.targets.filter((node) => node !== target) }
  disconnect() { this.disconnected = true; this.targets = [] }
  takeRecords() { return [] }
  /**
   * Drives the callback with hand-built entries.
   *
   * @param {Array<{ target: Element, isIntersecting: boolean }>} entries
   */
  emit(entries) { if (!this.disconnected) this.cb(entries, this) }
})

/**
 * The most recently constructed observer, or undefined.
 *
 * Effects construct several on mount, so callers that mean "ours" should reach
 * for this last -- the editor's heading observer is torn down and rebuilt
 * whenever the outline changes.
 */
export const lastIntersectionObserver = () => intersectionObservers.at(-1)

/**
 * Emits intersection entries for nodes matched by `selector`.
 *
 * @param {Element[] | NodeList} nodes
 * @param {boolean} isIntersecting
 */
export const emitIntersections = (nodes, isIntersecting) => {
  const observer = lastIntersectionObserver()
  if (!observer) throw new Error('no IntersectionObserver has been constructed')
  const targets = [...nodes].filter((node) => observer.targets.includes(node))
  observer.emit(targets.map((target) => ({ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 })))
  return targets
}
define('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0))
define('cancelAnimationFrame', (id) => clearTimeout(id))
define('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
}))

/** Lets a caller observe console.error without silencing it globally. */
export const consoleErrors = []
export function captureConsoleErrors() {
  const original = console.error
  console.error = (...args) => {
    consoleErrors.push(
      args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' '),
    )
    original(...args)
  }
  return () => { console.error = original }
}

// `ThinkingOrb` and `BotAvatar` resolve `prefers-color-scheme` through
// `window.matchMedia`, a property of the JSDOM window rather than of the Node
// global defined above.
dom.window.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})

// The effect libraries read this off the Node global to size their canvases and
// SVG filters.
define('getComputedStyle', (...args) => dom.window.getComputedStyle(...args))

/**
 * Canvas contexts, matching what the real webview actually offers.
 *
 * The 2D context is stubbed because jsdom returns null without the optional
 * `canvas` package, and a null context throws on the first draw. WebGL and
 * WebGL2 deliberately return null: this machine's WebKitGTK has no WebGL2, so
 * the metal-fx capability gate has to see the same answer here that it sees in
 * the app. Handing back a fake GL context made the gate pass, the effect mount,
 * and then metal-fx crashed on a real GL call.
 */
dom.window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (kind !== '2d') return null
  return {
    canvas: this,
    save() {}, restore() {}, scale() {}, translate() {}, rotate() {}, clearRect() {},
    fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {}, moveTo() {},
    lineTo() {}, arc() {}, arcTo() {}, rect() {}, ellipse() {}, fill() {}, stroke() {},
    clip() {}, fillText() {}, strokeText() {}, setLineDash() {}, drawImage() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, setTransform() {}, resetTransform() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getExtension: () => ({ loseContext() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {},
    measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    shadowBlur: 0,
    shadowColor: 'transparent',
  }
}

/**
 * Lets `addEventListener` accept an `AbortSignal` in its options.
 *
 * This is the one thing that stops the real framer-motion from running under
 * jsdom: it passes `{ signal }` to `addEventListener`, and jsdom throws on an
 * options object it does not recognise. The signal is dropped rather than
 * emulated, so a listener registered this way is not aborted — acceptable
 * because the suites tear the whole DOM down between cases.
 */
const nativeAdd = dom.window.EventTarget.prototype.addEventListener
const nativeRemove = dom.window.EventTarget.prototype.removeEventListener
const stripSignal = (options) => {
  if (options && typeof options === 'object' && 'signal' in options) {
    const { signal, ...rest } = options
    return rest
  }
  return options
}
dom.window.EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
  return nativeAdd.call(this, type, listener, stripSignal(options))
}
dom.window.EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
  return nativeRemove.call(this, type, listener, stripSignal(options))
}

// Present the webview as running inside Tauri. Without this the store takes its
// browser fallback, which is a different code path entirely.
dom.window.__TAURI_INTERNALS__ = { invoke, transformCallback }
dom.window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (event, eventId) => eventListeners.get(event)?.delete(eventId),
}

export const root = dom.window.document.getElementById('root')

/**
 * A short printable name for whatever currently has focus.
 *
 * Never assert on a DOM node directly. `assert.equal(nodeA, nodeB)` makes node
 * build an inspection of the mismatch, and inspecting a jsdom element wired to a
 * React tree does not terminate in any reasonable time: a suite that meant to
 * report a failing assertion in 2ms instead sat there for 90 seconds and
 * reported only "promise resolution is still pending". Comparing short strings
 * costs nothing and prints something readable.
 */
export const activeElementLabel = () => {
  const node = dom.window.document.activeElement
  if (!node) return 'nothing'
  const tag = node.tagName.toLowerCase()
  const cls = typeof node.className === 'string' && node.className
    ? `.${node.className.trim().split(/\s+/)[0]}`
    : ''
  const name = node.getAttribute?.('aria-label')
    || node.getAttribute?.('id')
    || (node.textContent || '').trim().slice(0, 24)
  return `${tag}${cls}${name ? `[${name}]` : ''}`
}

/** Asserts `selector` matches nothing, without serialising a node on failure. */
export const assertGone = (selector, message) => {
  const found = root.querySelector(selector)
  if (found) throw new assert.AssertionError({ message: `${message} (still present: ${selector})` })
}

/** Waits for timers and any queued microtasks to settle. */
export const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits for the application to finish booting.
 *
 * Boot is a run of async IPC round trips, so a fixed delay is a guess that
 * eventually loses on a cold or loaded machine: the shell arrives, but the
 * editor layer behind it does not. Wait for the shell, then for the boot
 * overlay to clear, before the suite starts touching either.
 */
export async function awaitBoot() {
  for (let i = 0; i < 400 && !root.querySelector('.app-shell'); i += 1) await tick(25)
  // The library owns the loading state now, so the boot overlay is gone while
  // the shelf is still a skeleton. Wait for the real grid before any test
  // reads a tile.
  for (let i = 0; i < 400 && root.querySelector('.library-loading'); i += 1) await tick(25)
  await tick(50)
}

/** Titles of the real document tiles, excluding the "New document" tile. */
export const tileTitles = () =>
  [...root.querySelectorAll('.document-tile:not(.new-document-tile) .tile-copy strong')]
    .map((node) => node.textContent)

/** Every tile present, including the new-document tile. */
export const allTileCount = () => root.querySelectorAll('.document-tile').length

export const navButton = (label) =>
  [...root.querySelectorAll('.nav-item')].find((node) => node.textContent.includes(label))

/**
 * Waits until the DOM stops changing.
 *
 * Exiting children stay mounted until their exit animation finishes, which is
 * correct behaviour rather than a stray node. Asserting on a fixed delay would
 * therefore report every filter as broken, so this polls for quiescence.
 */
export const settle = async (timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  let previous = root.innerHTML
  let stable = 0
  while (Date.now() < deadline) {
    await tick(30)
    if (root.innerHTML === previous) {
      stable += 1
      // Three identical reads in a row means the animations have finished.
      if (stable >= 3) return
    } else {
      stable = 0
      previous = root.innerHTML
    }
  }
}

export const clickNav = async (label) => {
  const button = navButton(label)
  if (!button) throw new Error(`no sidebar button labelled "${label}"`)
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await settle()
}

/**
 * Sets a controlled input's value the way React notices.
 *
 * React tracks the value on the DOM node, so a plain assignment is invisible to
 * it. The native setter plus an input event is the documented way round.
 */
/**
 * Types into a controlled field.
 *
 * The value is set through the element's own prototype setter, not the instance
 * one, because React installs a value tracker as an own property: writing through
 * it would make the tracker see no change and `onChange` would never fire. The
 * prototype is read from the element rather than hardcoded to `HTMLInputElement`
 * so a `<textarea>` gets its own setter -- a textarea typed this way used to
 * leave the composer unchanged, which made the send button look permanently
 * disabled.
 */
export const typeInto = (field, value) => {
  const prototype = Object.getPrototypeOf(field)
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new TypeError(`no value setter on ${field.tagName}`)
  setter.call(field, value)
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

/** Types into a field and waits for the render the value triggers. */
export const typeAndSettle = async (field, value) => {
  typeInto(field, value)
  await settle()
}

/**
 * Chooses an option on a `<select>` the way React notices.
 *
 * Same prototype-setter trick as `typeInto`, but the event is `change` rather
 * than `input`: React listens for `change` on a select, and jsdom does not
 * synthesise one from a `value` assignment -- a select set that way renders the
 * new label and never calls the handler, which reads as a picker that does
 * nothing.
 */
export const selectOption = async (select, value) => {
  if (select.tagName !== 'SELECT') throw new TypeError(`not a select: ${select.tagName}`)
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set
  if (!setter) throw new TypeError('no value setter on SELECT')
  setter.call(select, value)
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()
}

/**
 * Dispatches a click and waits for the render it triggers.
 *
 * Every interaction in the app goes through React state, so a click that is not
 * followed by a wait reads the DOM from before the update and looks like it did
 * nothing. `settle` polls until the markup is stable rather than guessing a
 * fixed delay.
 */
export const clickAndSettle = async (node) => {
  node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await settle()
}

export const press = (input, key) => {
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
}

mock.module('@tauri-apps/api/core', {
  // `transformCallback` has to be here as well as `invoke`: the real
  // `@tauri-apps/api/event` imports it from this module, so a mock without it
  // turns `listen` into a SyntaxError at import time and every event
  // subscription in the app fails silently rather than loudly.
  namedExports: { invoke, transformCallback },
  defaultExport: { invoke, transformCallback },
})

// The dialog plugin. `save` is stubbed for the export tests, and `open` is what
// P4-3 needs: the reader picks a file, the plugin returns its path, and one Rust
// command reads that path. A test sets `dialogFixtures.open` to a path or to null
// for a dismissal -- the two cases the real dialog has.
mock.module('@tauri-apps/plugin-dialog', {
  namedExports: {
    open: async () => dialogFixtures.open,
    save: async () => dialogFixtures.save,
  },
  defaultExport: { open: async () => dialogFixtures.open, save: async () => dialogFixtures.save },
})

// --- framer-motion mock -------------------------------------------------------

// framer-motion passes AbortSignal options to addEventListener, which jsdom does
// not implement. Animation is not what the mocked suites are about, so every
// motion component becomes a plain host element. `data-motion` preserves the
// element name so assertions can still target it, and the real props are kept --
// an earlier version of this mock rendered `children` alone, which silently
// deleted icon-only buttons such as `.send-button` from the tree and made any
// test that used them fail for reasons that had nothing to do with motion.
//
// Shared rather than duplicated per suite: a weaker copy in a second file is how
// the two would drift.
const MOTION_TAGS = new Set([
  'div', 'section', 'aside', 'main', 'nav', 'button', 'form', 'article', 'header', 'footer',
])
const PRESENTATION_PROPS = new Set(['initial', 'animate', 'exit', 'transition', 'whileTap', 'whileHover'])

/** Renders a motion component as a plain host element. */
function host(tag, props = {}) {
  const clean = {}
  for (const [key, value] of Object.entries(props ?? {})) {
    if (PRESENTATION_PROPS.has(key)) continue
    clean[key] = value
  }
  const Tag = MOTION_TAGS.has(tag) ? tag : 'div'
  return React.createElement(Tag, { 'data-motion': tag, ...clean }, props?.children)
}

/** One stable component per tag, or every render would change its type. */
const motionComponents = new Map()
function motionComponent(tag) {
  if (!motionComponents.has(tag)) {
    motionComponents.set(tag, function MotionHost(props) { return host(tag, props) })
  }
  return motionComponents.get(tag)
}

/**
 * Registers the framer-motion mock.
 *
 * Call this before importing `../src/main.jsx`: module mocks only apply to
 * imports that happen after they are registered.
 */
export function mockFramerMotion() {
  // `motion.button` and `motion('div')` both resolve to a host element.
  //
  // The per-tag cache is load-bearing. `motion.aside` is a property access in
  // every render of the component that uses it, so a proxy that built the
  // component on the spot handed React a *different component type* each time.
  // React unmounts and remounts a subtree whose element type changes, so the
  // assistant panel was rebuilt from scratch on every state change: the composer
  // value came back empty, the send button stayed disabled, and the transcript
  // never grew past the message it started with. Real framer-motion returns a
  // stable component per tag, so the mock has to as well.
  const motion = new Proxy(() => {}, {
    get: (_target, tag) => (typeof tag === 'string' || typeof tag === 'function' ? motionComponent(tag) : undefined),
  })
  mock.module('framer-motion', {
    namedExports: { AnimatePresence: ({ children }) => children, motion, useReducedMotion: () => false },
    defaultExport: { motion },
  })
  mock.module('motion/react', {
    namedExports: {
      animate: () => {
        const animation = { stop: () => {} }
        animation.then = (resolve) => {
          resolve?.(animation)
          return Promise.resolve()
        }
        return animation
      },
      useReducedMotion: () => false,
    },
  })
}
