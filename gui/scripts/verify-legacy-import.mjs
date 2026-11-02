/**
 * Runs the real importer against a temporary database and asserts the imported
 * content is correct, escaped, and structurally sound.
 *
 * The source file is read-only; everything lands in a throwaway database.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const source = join(root, '..', 'database', 'database.json')
if (!readFileSync(source)) throw new Error('source missing')

const dir = mkdtempSync(join(tmpdir(), 'quill-legacy-'))

// A legacy-shaped store exercising the paths that matter: duplicate collapse,
// a hostile section payload, a corrupt concept map, and an unknown namespace.
const body =
  'This is a paragraph of genuine prose written to clear the importer quality gate, ' +
  'which rejects bodies that are effectively empty or that have lost all structure, ' +
  'because those are the two reliable signatures of a record the legacy pipeline truncated.'
const fixture = {
  '3eceffdd-d161-4352-8dba-16c1c7991b15': {
    title: 'Quill Report',
    unique_id: '3eceffdd-d161-4352-8dba-16c1c7991b15',
    markdown: 'flat text',
    sections: [
      { level: 1, no: null, title: 'Top <script>alert(1)</script>', blocks: [{ type: 'paragraph', content: `Intro ${body}` }], children: [] },
      { level: 1, no: '1', title: 'Chapter', blocks: [], children: [
        { level: 2, no: '1.1', title: 'Nested', blocks: [{ type: 'paragraph', content: 'Nested body text.' }], children: [] },
      ] },
    ],
  },
  'aaaabbbb-1111-2222-3333-444455556666': {
    title: 'Duplicate',
    unique_id: 'aaaabbbb-1111-2222-3333-444455556666',
    markdown: 'flat text',
    sections: [{ level: 1, no: null, title: 'Top', blocks: [{ type: 'paragraph', content: `Intro ${body}` }], children: [] }],
  },
  'concept:3eceffdd-d161-4352-8dba-16c1c7991b15': { sections: [{ path: '', text_chars: 0 }] },
  'meta:parsecache': { '8:abc': '3eceffdd-d161-4352-8dba-16c1c7991b15', '6:abc': 'aaaabbbb-1111-2222-3333-444455556666' },
  'weird:thing': { a: 1 },
}
const fixturePath = join(dir, 'legacy.json')
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2))

let failed = false
const check = (label, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

console.log('running the Rust importer against a fixture store\n')
const out = execFileSync(
  'cargo',
  ['run', '--quiet', '--example', 'legacy_import_check', '--', fixturePath],
  { cwd: join(root, 'src-tauri'), encoding: 'utf8', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } },
)

for (const line of out.trim().split('\n')) {
  if (line.startsWith('RESULT ')) {
    const r = JSON.parse(line.slice(7))
    check('exactly one document created', r.documentsCreated === 1, `got ${r.documentsCreated}`)
    check('title imported', r.title === 'Quill Report', r.title)
    check('provenance recorded', r.provenance === 'legacy-py-json:3eceffdd-d161-4352-8dba-16c1c7991b15', r.provenance)
    check('content format is html', r.contentFormat === 'html', r.contentFormat)
    check('top-level heading rendered', r.html.includes('<h1>'), 'has h1')
    check('numbered nested heading rendered', r.html.includes('<h2>1.1 Nested</h2>'), 'has 1.1')
    check('hostile script escaped', !r.html.includes('<script'), 'no raw script')
    check('outbox row written', r.outbox === 1, `outbox=${r.outbox}`)
    check('run recorded', r.runs === 1, `runs=${r.runs}`)
  }
}

// Rerun against the same content must be a no-op.
const out2 = execFileSync(
  'cargo',
  ['run', '--quiet', '--example', 'legacy_import_check', '--', fixturePath],
  { cwd: join(root, 'src-tauri'), encoding: 'utf8', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } },
)
const second = JSON.parse(out2.trim().split('\n').find((l) => l.startsWith('RESULT ')).slice(7))
check('re-run creates no duplicate', second.totalDocuments === 1, `documents=${second.totalDocuments}`)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${failed ? 'FAILED' : 'ALL CHECKS PASSED'}`)
if (failed) process.exit(1)
