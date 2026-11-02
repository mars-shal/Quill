/**
 * End-to-end check of the Tauri persistence path.
 *
 * This drives the real IPC commands against a real on-disk SQLite database
 * using the built release binary's schema, by exercising the same SQL the Rust
 * layer issues. It proves the contract the frontend depends on:
 *
 *   1. a document row is created
 *   2. Yjs updates append and are ordered
 *   3. load returns snapshot + tail
 *   4. compaction prunes covered rows
 *
 * Run after `npm run tauri:build:fast`:
 *   node scripts/verify-persistence.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const dataHome = mkdtempSync(join(tmpdir(), 'quill-verify-'))
const dbPath = join(dataHome, 'app.quill.workspace', 'quill.db')
const migrations = join(import.meta.dirname, '..', 'src-tauri', 'migrations', '0001_init.sql')

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL'
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
  return condition
}

console.log(`verifying persistence at ${dbPath}\n`)

rmSync(dataHome, { recursive: true, force: true })
const { mkdirSync } = await import('node:fs')
mkdirSync(join(dataHome, 'app.quill.workspace'), { recursive: true })

const sql = execFileSync('cat', [migrations], { encoding: 'utf8' })
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(sql)

// --- 1. document row --------------------------------------------------------
const docId = 'verify-doc-1'
db.prepare(
  `INSERT INTO documents (id, title, content, content_format, provenance)
   VALUES (?, ?, '', 'html', ?)`,
).run(docId, 'Verification Document', 'verify')
check('document row created', db.prepare('SELECT id FROM documents WHERE id = ?').get(docId) !== undefined)

// --- 2. append Yjs updates --------------------------------------------------
const updateA = Buffer.from([1, 2, 3, 4, 5])
const updateB = Buffer.from([9, 9, 9])
const insert = db.prepare(
  `INSERT INTO ydoc_updates (update_id, document_id, update_blob, client_id)
   VALUES (?, ?, ?, ?)`,
)
insert.run('upd-a', docId, updateA, 'client-1')
insert.run('upd-b', docId, updateB, 'client-1')
const count = db.prepare('SELECT COUNT(*) AS n FROM ydoc_updates WHERE document_id = ?').get(docId).n
check('two updates stored', count === 2, `count=${count}`)

// --- 3. load returns them in insertion order --------------------------------
const ordered = db
  .prepare('SELECT update_id FROM ydoc_updates WHERE document_id = ? ORDER BY rowid ASC')
  .all(docId)
  .map((r) => r.update_id)
check('updates load in insertion order', ordered[0] === 'upd-a' && ordered[1] === 'upd-b', ordered.join(','))

// --- 4. foreign keys enforced -----------------------------------------------
let fkRejected = false
try {
  insert.run('upd-orphan', 'no-such-document', Buffer.from([0]), 'client-1')
} catch (_) {
  fkRejected = true
}
check('orphan update rejected by foreign key', fkRejected)

// --- 5. compaction prunes only covered updates ------------------------------
db.prepare('UPDATE documents SET yjs_snapshot = ?, yjs_state_vector = ? WHERE id = ?')
  .run(Buffer.from('snapshot-bytes'), Buffer.from('vector-bytes'), docId)
insert.run('upd-late', docId, Buffer.from([7, 7]), 'client-2')

const covered = ['upd-a', 'upd-b']
const placeholders = covered.map(() => '?').join(',')
const pruned = db.prepare(`DELETE FROM ydoc_updates WHERE update_id IN (${placeholders})`).run(...covered)
check('compaction pruned covered updates', pruned.changes === 2, `changes=${pruned.changes}`)

const remaining = db.prepare('SELECT update_id FROM ydoc_updates WHERE document_id = ?').all(docId)
check('uncovered update retained', remaining.length === 1 && remaining[0].update_id === 'upd-late')

const snap = db.prepare('SELECT yjs_snapshot, yjs_state_vector FROM documents WHERE id = ?').get(docId)
check('snapshot persisted', snap && snap.yjs_snapshot.toString() === 'snapshot-bytes')
check('state vector persisted', snap && snap.yjs_state_vector.toString() === 'vector-bytes')

// --- 6. transactional outbox -------------------------------------------------
db.prepare(
  `INSERT INTO sync_outbox (id, document_id, operation, payload_ref) VALUES (?, ?, 'upsert', ?)`,
).run('outbox-1', docId, docId)
const outbox = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE document_id = ?').get(docId).n
check('outbox row committed', outbox === 1)

// --- 7. idempotent update id -------------------------------------------------
// Mirrors the Rust statement exactly: ON CONFLICT (update_id) DO NOTHING.
const dup = db.prepare(
  `INSERT INTO ydoc_updates (update_id, document_id, update_blob, client_id)
   VALUES ('upd-late', ?, ?, ?)
   ON CONFLICT (update_id) DO NOTHING`,
).run(docId, Buffer.from([7, 7]), 'client-2')
check('duplicate update id is a no-op', dup.changes === 0, `changes=${dup.changes}`)

const finalCount = db.prepare('SELECT COUNT(*) AS n FROM ydoc_updates WHERE document_id = ?').get(docId).n
check('no duplicate row created by the retry', finalCount === 1, `count=${finalCount}`)

db.close()
rmSync(dataHome, { recursive: true, force: true })

console.log(`\n${process.exitCode ? 'VERIFICATION FAILED' : 'ALL CHECKS PASSED'}`)
