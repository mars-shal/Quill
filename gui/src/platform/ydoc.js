/**
 * Local-first Yjs persistence.
 *
 * Owns one Y.Doc per Quill document and keeps it durable through the Rust core:
 *
 *   load      -> read the stored snapshot, then replay the update tail
 *   persist   -> append local updates (debounced, merged into batches, retried)
 *   compact   -> fold the update tail into a new snapshot once it grows large
 *
 * Yjs updates are commutative, associative and idempotent, so replaying the
 * same update twice is harmless. That property is what makes the retry path
 * safe: a failed write is simply retried, and the Rust side additionally
 * derives a deterministic id from the update bytes to make it a no-op.
 *
 * This provider is local-only today. Cloud sync layers on top of the same
 * update log later without changing anything in this file.
 *
 * Note: this class deliberately *composes* a Y.Doc rather than extending it.
 * Subclassing would expose a second `on()` with a different signature and
 * shadow the native Yjs event emitter.
 */

import * as Y from 'yjs'
import { runtime } from './store.js'

/** Fold the update tail into a snapshot once this many updates accumulate. */
const COMPACT_THRESHOLD = 250
const PERSIST_DEBOUNCE_MS = 400

// A window being hidden or reloaded gives React no chance to unmount, so the
// debounced queue would be dropped with it. Live documents register here and
// drain on the way out: `visibilitychange` covers switching away (the common
// way to refresh), and `pagehide` is the best effort on the way out itself --
// the invoke may not survive teardown, which is exactly why the generated-text
// path also flushes eagerly.
const liveDocs = new Set()
if (typeof window !== 'undefined') {
  const drain = () => {
    for (const doc of [...liveDocs]) doc.flushNow().catch(() => {})
  }
  window.addEventListener('pagehide', drain)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') drain()
  })
}
const MAX_RETRY_MS = 8000
const MAX_BACKLOG_WARN = 2000

let invokeFn = null

async function tauriInvoke(command, args) {
  if (!invokeFn) {
    const mod = await import('@tauri-apps/api/core')
    invokeFn = mod.invoke
  }
  return invokeFn(command, args)
}

export function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function fromBase64(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Stable identity for this device/session, used to attribute updates. */
export function clientId() {
  const key = 'quill:client-id'
  let value = null
  try {
    value = localStorage.getItem(key)
  } catch {
    value = null
  }
  if (!value) {
    value = `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
    try {
      localStorage.setItem(key, value)
    } catch {
      /* private mode: an ephemeral id is fine */
    }
  }
  return value
}

export class LocalYDoc {
  /**
   * @param {string} documentId
   * @param {object} [options]
   * @param {string} [options.clientId] override the storage-derived client id
   * @param {(update: Uint8Array, origin: any) => void} [options.onLocalUpdate]
   *   Called for locally originated updates, used by the sync outbox in a later
   *   phase. Persistence is handled internally.
   * @param {(command: string, args: object) => Promise<any>} [options.transport]
   *   Overrides how the Rust core is reached. Injected by tests.
   * @param {boolean} [options.enabled]
   *   When false the provider runs in memory only. Defaults to whether the
   *   Tauri runtime is present.
   * @param {number} [options.compactThreshold]
   *   Pending updates required before compaction runs. Lowered in tests.
   */
  constructor(documentId, options = {}) {
    this.documentId = documentId
    this.doc = new Y.Doc()
    this.clientId = options.clientId || clientId()
    this.onLocalUpdate = options.onLocalUpdate || null
    this.transport = options.transport || tauriInvoke
    this.enabled = options.enabled ?? runtime.isTauri
    this.compactThreshold = options.compactThreshold ?? COMPACT_THRESHOLD

    this.status = 'loading'
    /** @type {Uint8Array[]} updates awaiting persistence */
    this.queue = []
    this.timer = null
    this.retryDelay = 500
    this.destroyed = false
    this.persisting = false
    /** Suppresses persisting updates that we are reading back in from disk. */
    this.replaying = true
    /**
     * Provider-level events (status/synced) use their own emitter rather than
     * `doc.on`, because `Y.Doc.emit(name, args)` spreads `args` and would make
     * the signature surprising. `doc.on` is reserved for native Yjs events.
     * @type {Map<string, Set<Function>>}
     */
    this.handlers = new Map()

    this.handleUpdate = (update, origin) => {
      if (this.destroyed) return
      // Ignore the echo of updates we just applied from storage.
      if (this.replaying) return
      if (origin === 'load') return
      this.queue.push(update)
      this.onLocalUpdate?.(update, origin)
      this.schedulePersist()
    }

    this.doc.on('update', this.handleUpdate)
    liveDocs.add(this)
  }

  /** Subscribe to provider events ('status' | 'synced'). Returns an unsubscribe. */
  subscribe(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set())
    this.handlers.get(name).add(handler)
    return () => this.handlers.get(name)?.delete(handler)
  }

  emit(name, detail) {
    for (const handler of this.handlers.get(name) ?? []) {
      try {
        handler(detail)
      } catch (error) {
        console.error(`ydoc listener for "${name}" failed`, error)
      }
    }
  }

  setStatus(state, detail) {
    this.status = state
    this.emit('status', { state, detail })
  }

  /** Loads the snapshot then replays the update tail into the document. */
  async load() {
    if (!this.enabled) {
      this.replaying = false
      this.setStatus('ready')
      this.emit('synced', { pending: 0 })
      return this
    }

    try {
      const state = await this.transport('ydoc_load', { documentId: this.documentId })

      if (state.snapshot) {
        Y.applyUpdate(this.doc, fromBase64(state.snapshot), 'load')
      }
      for (const update of state.updates ?? []) {
        Y.applyUpdate(this.doc, fromBase64(update.update), 'load')
      }

      this.replaying = false
      this.setStatus('ready')
      this.emit('synced', { pending: 0 })
      await this.maybeCompact()
    } catch (error) {
      this.replaying = false
      console.error('Failed to load document state', error)
      this.setStatus('error', error instanceof Error ? error.message : String(error))
    }
    return this
  }

  schedulePersist() {
    if (this.destroyed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch((error) => console.error('Persist failed', error))
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Merges the queued updates and writes them as one durable record. */
  async flush() {
    if (this.destroyed || this.persisting) return
    if (this.queue.length === 0) return

    const batch = this.queue
    this.queue = []

    // mergeUpdates is the efficient path: it combines the batch into a single
    // update and drops information already present in earlier updates.
    const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch)
    if (!merged || merged.byteLength === 0) return

    if (!this.enabled) {
      this.emit('synced', { pending: this.queue.length })
      return
    }

    this.persisting = true
    try {
      await this.transport('ydoc_append_update', {
        documentId: this.documentId,
        update: toBase64(merged),
        clientId: this.clientId,
      })
      this.retryDelay = 500
      this.emit('synced', { pending: this.queue.length })
      // Keep the update tail bounded. Without this the log would grow without
      // limit for the lifetime of the document.
      this.maybeCompact().catch(() => {})
    } catch (error) {
      // Requeue the batch. Re-persisting is safe because the Rust side
      // deduplicates on an id derived from the update bytes.
      this.queue = batch.concat(this.queue)
      this.emit('synced', { pending: this.queue.length })
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS)
      console.warn(`Persist failed, retrying in ${this.retryDelay}ms`, error)
      setTimeout(() => {
        this.flush().catch(() => {})
      }, this.retryDelay)
      if (this.queue.length > MAX_BACKLOG_WARN) {
        this.setStatus('degraded', `${this.queue.length} unsaved updates held in memory`)
      }
    } finally {
      this.persisting = false
    }
  }

  /**
   * Folds the update tail into a full-state snapshot.
   *
   * Purely an optimisation: a failure here must never lose content, so every
   * error is swallowed and logged.
   */
  async maybeCompact() {
    if (this.destroyed || !this.enabled) return
    try {
      const pending = await this.transport('ydoc_pending_count', { documentId: this.documentId })
      if (pending < this.compactThreshold) return

      const state = await this.transport('ydoc_load', { documentId: this.documentId })
      await this.transport('ydoc_compact', {
        documentId: this.documentId,
        snapshot: toBase64(Y.encodeStateAsUpdate(this.doc)),
        stateVector: toBase64(Y.encodeStateVector(this.doc)),
        coveredUpdateIds: (state.updates ?? []).map((u) => u.updateId),
      })
    } catch (error) {
      console.warn('Compaction skipped', error)
    }
  }

  /** Current full state, used for HTML/JSON export. */
  encodeState() {
    return Y.encodeStateAsUpdate(this.doc)
  }

  stateVector() {
    return Y.encodeStateVector(this.doc)
  }

  /** Blocking flush for window close / navigation. */
  async flushNow() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    liveDocs.delete(this)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.handlers.clear()
    this.doc.off('update', this.handleUpdate)
    this.doc.destroy()
  }
}
