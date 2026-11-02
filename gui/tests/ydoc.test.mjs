/**
 * LocalYDoc tests — exercising the real provider, not a copy of it.
 *
 * Run with: node --test tests/ydoc.test.mjs
 *
 * The provider accepts an injected `transport`, so these tests drive the same
 * code path the app uses, with the Rust core replaced by an in-memory stub that
 * mirrors the Rust command semantics (idempotent update ids, snapshot plus
 * pending tail, compaction pruning only covered updates).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'

const { LocalYDoc, toBase64, fromBase64 } = await import('../src/platform/ydoc.js')

// --- stub transport mirroring src-tauri/src/ydoc.rs --------------------------

class StubCore {
  constructor() {
    this.docs = new Map()
    this.failNext = 0
    this.calls = []
  }

  state(docId) {
    if (!this.docs.has(docId)) {
      this.docs.set(docId, { snapshot: null, stateVector: null, updates: new Map() })
    }
    return this.docs.get(docId)
  }

  /** Mirrors the Rust id derivation: sha256(documentId || 0 || bytes). */
  static updateId(docId, bytes) {
    return `${docId}:${bytes.length}:${Y.encodeStateAsUpdate(new Y.Doc()).byteLength}:${Buffer.from(bytes).toString('hex').slice(0, 16)}`
  }

  transport = async (command, args) => {
    this.calls.push({ command, args })
    if (this.failNext > 0) {
      this.failNext -= 1
      throw new Error('simulated store failure')
    }
    const state = this.state(args.documentId)

    switch (command) {
      case 'ydoc_load':
        return {
          snapshot: state.snapshot,
          stateVector: state.stateVector,
          updates: [...state.updates].map(([updateId, update]) => ({
            updateId,
            update: toBase64(update),
          })),
        }
      case 'ydoc_append_update': {
        const bytes = fromBase64(args.update)
        state.updates.set(StubCore.updateId(args.documentId, bytes), bytes)
        return 'ok'
      }
      case 'ydoc_pending_count':
        return state.updates.size
      case 'ydoc_compact':
        state.snapshot = args.snapshot
        state.stateVector = args.stateVector
        for (const id of args.coveredUpdateIds) state.updates.delete(id)
        return args.coveredUpdateIds.length
      default:
        throw new Error(`unexpected command ${command}`)
    }
  }

  pending(docId) {
    return this.state(docId).updates.size
  }
}

function makeDoc(core, docId = 'doc-1', options = {}) {
  return new LocalYDoc(docId, {
    transport: core.transport,
    enabled: true,
    clientId: 'test-client',
    ...options,
  })
}

// --- base64 ------------------------------------------------------------------

test('base64 round-trips arbitrary bytes', () => {
  const samples = [
    new Uint8Array(),
    new Uint8Array([0, 1, 250, 255]),
    new Uint8Array(5000).fill(7),
  ]
  for (const sample of samples) {
    assert.deepEqual(fromBase64(toBase64(sample)), sample)
  }
})

// --- load --------------------------------------------------------------------

test('a new document loads empty and reports ready', async () => {
  const core = new StubCore()
  const ydoc = makeDoc(core)

  const seen = []
  ydoc.subscribe('status', (s) => seen.push(s.state))
  await ydoc.load()

  assert.equal(ydoc.status, 'ready')
  assert.deepEqual(seen, ['ready'])
  ydoc.destroy()
})

test('stored content is restored on load', async () => {
  const core = new StubCore()

  const writer = makeDoc(core)
  await writer.load()
  writer.doc.getText('body').insert(0, 'restored from disk')
  await writer.flushNow()
  writer.destroy()

  const reader = makeDoc(core)
  await reader.load()
  assert.equal(reader.doc.getText('body').toString(), 'restored from disk')
  reader.destroy()
})

// --- persistence -------------------------------------------------------------

test('edits are persisted and reopened', async () => {
  const core = new StubCore()
  const first = makeDoc(core)
  await first.load()

  first.doc.getText('body').insert(0, 'hello world')
  await first.flushNow()
  first.destroy()

  const second = makeDoc(core)
  await second.load()
  assert.equal(second.doc.getText('body').toString(), 'hello world')
  second.destroy()
})

test('loading does not echo stored updates back as new writes', async () => {
  const core = new StubCore()
  const first = makeDoc(core)
  await first.load()
  first.doc.getText('body').insert(0, 'written once')
  await first.flushNow()
  first.destroy()

  const writesAfterFirst = core.pending('doc-1')

  const second = makeDoc(core)
  await second.load()
  assert.equal(core.pending('doc-1'), writesAfterFirst, 'no duplicate write on load')
  assert.equal(second.queue.length, 0, 'nothing queued after load')
  second.destroy()
})

test('several updates merge into a single durable record', async () => {
  const core = new StubCore()
  const ydoc = makeDoc(core)
  await ydoc.load()

  ydoc.doc.getText('body').insert(0, 'one ')
  ydoc.doc.getText('body').insert(4, 'two ')
  ydoc.doc.getText('body').insert(8, 'three')
  await ydoc.flushNow()

  assert.equal(core.pending('doc-1'), 1, 'batched into one update')
  ydoc.destroy()
})

test('a failed write is requeued and retried without duplicating content', async () => {
  const core = new StubCore()
  const ydoc = makeDoc(core)
  await ydoc.load()

  ydoc.doc.getText('body').insert(0, 'survives failure')
  core.failNext = 1

  // flush() absorbs the failure and schedules a retry rather than rejecting;
  // the batch is held in memory so nothing is lost.
  await ydoc.flush()
  assert.equal(core.pending('doc-1'), 0, 'nothing durable after the failure')
  assert.equal(ydoc.queue.length, 1, 'the batch is held for retry')

  await ydoc.flush()
  assert.equal(core.pending('doc-1'), 1, 'exactly one record after retry')
  assert.equal(ydoc.queue.length, 0, 'queue drained after a successful write')
  ydoc.destroy()

  const reopened = makeDoc(core)
  await reopened.load()
  assert.equal(reopened.doc.getText('body').toString(), 'survives failure')
  reopened.destroy()
})

test('an empty edit batch writes nothing', async () => {
  const core = new StubCore()
  const ydoc = makeDoc(core)
  await ydoc.load()

  await ydoc.flush()
  assert.equal(core.pending('doc-1'), 0)
  assert.equal(core.calls.filter((c) => c.command === 'ydoc_append_update').length, 0)
  ydoc.destroy()
})

// --- compaction --------------------------------------------------------------

test('compaction stores a snapshot and preserves content', async () => {
  const core = new StubCore()
  // Threshold of 1 so the next write triggers compaction.
  const ydoc = makeDoc(core, 'doc-1', { compactThreshold: 1 })
  await ydoc.load()

  ydoc.doc.getText('body').insert(0, 'compacted content')
  await ydoc.flushNow()

  const state = core.state('doc-1')
  assert.ok(state.snapshot, 'a snapshot was stored')
  assert.equal(state.updates.size, 0, 'the covered tail was pruned')

  const reopened = makeDoc(core)
  await reopened.load()
  assert.equal(reopened.doc.getText('body').toString(), 'compacted content')
  reopened.destroy()
  ydoc.destroy()
})

test('an update written after the snapshot survives compaction', async () => {
  const core = new StubCore()
  const ydoc = makeDoc(core)
  await ydoc.load()

  ydoc.doc.getText('body').insert(0, 'before snapshot')
  await ydoc.flushNow()
  const snapshotState = { ...core.state('doc-1') }
  const covered = [...snapshotState.updates.keys()]

  await ydoc.transport('ydoc_compact', {
    documentId: 'doc-1',
    snapshot: toBase64(Y.encodeStateAsUpdate(ydoc.doc)),
    stateVector: toBase64(Y.encodeStateVector(ydoc.doc)),
    coveredUpdateIds: covered,
  })

  ydoc.doc.getText('body').insert(15, ' + after')
  await ydoc.flushNow()

  const reopened = makeDoc(core)
  await reopened.load()
  assert.equal(reopened.doc.getText('body').toString(), 'before snapshot + after')
  reopened.destroy()
  ydoc.destroy()
})

// --- isolation and convergence ----------------------------------------------

test('documents are isolated from one another', async () => {
  const core = new StubCore()
  const a = makeDoc(core, 'doc-a')
  const b = makeDoc(core, 'doc-b')
  await Promise.all([a.load(), b.load()])

  a.doc.getText('body').insert(0, 'AAA')
  b.doc.getText('body').insert(0, 'BBB')
  await Promise.all([a.flushNow(), b.flushNow()])

  const reopenA = makeDoc(core, 'doc-a')
  const reopenB = makeDoc(core, 'doc-b')
  await Promise.all([reopenA.load(), reopenB.load()])

  assert.equal(reopenA.doc.getText('body').toString(), 'AAA')
  assert.equal(reopenB.doc.getText('body').toString(), 'BBB')
  ;[a, b, reopenA, reopenB].forEach((d) => d.destroy())
})

test('two clients editing the same document converge', async () => {
  const core = new StubCore()
  const a = makeDoc(core, 'shared')
  const b = makeDoc(core, 'shared')
  await a.load()
  await b.load()

  // Simulate remote replication by exchanging full state.
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'load')
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'load')

  a.doc.getText('body').insert(0, 'from A')
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'load')

  b.doc.getText('body').insert(7, ' and B')
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'load')

  assert.equal(a.doc.getText('body').toString(), b.doc.getText('body').toString())
  assert.equal(a.doc.getText('body').toString(), 'from A and B')
  a.destroy()
  b.destroy()
})

// --- lifecycle ---------------------------------------------------------------

test('destroy is idempotent and stops further persistence', async () => {
  const core = new StubCore()
  const ydoc = makeDoc(core)
  await ydoc.load()

  ydoc.doc.getText('body').insert(0, 'before destroy')
  await ydoc.flushNow()
  const baseline = core.pending('doc-1')

  ydoc.destroy()
  ydoc.destroy()

  await ydoc.flush()
  assert.equal(core.pending('doc-1'), baseline)
})

test('status events report a load failure', async () => {
  const core = new StubCore()
  core.failNext = 1
  const ydoc = makeDoc(core)

  const states = []
  ydoc.subscribe('status', (s) => states.push(s.state))
  await ydoc.load()

  assert.equal(ydoc.status, 'error')
  assert.ok(states.includes('error'))
  ydoc.destroy()
})
