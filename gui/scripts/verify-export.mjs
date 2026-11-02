/**
 * Verifies the export pipeline end-to-end against a real ProseMirror document.
 *
 * Drives the shipped Rust exporter with a fixture that covers every supported
 * construct plus hostile input, then inspects the written files with external
 * tools (`file`, `pdftotext`, `unzip`) rather than trusting the exporter's own
 * return value.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'quill-export-'))
const fixture = join(root, 'tests', 'fixtures', 'export-document.json')

let failed = false
const check = (label, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}
const has = (name) => {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts })

console.log(`exporting ${fixture}\n`)
try {
  run('cargo', ['run', '--quiet', '--example', 'export_samples', '--', dir, fixture], {
    cwd: join(root, 'src-tauri'),
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  })
} catch (e) {
  console.log(String(e.stderr || e.message))
  process.exit(1)
}

const read = (name) => readFileSync(join(dir, name), 'utf8')

// --- every file was produced ------------------------------------------------

for (const name of ['sample.html', 'sample.pdf', 'sample.docx', 'sample.epub', 'sample.md']) {
  check(`${name} written`, existsSync(join(dir, name)))
}

// --- HTML -------------------------------------------------------------------

const html = read('sample.html')
check('html starts with a doctype', html.startsWith('<!doctype html>'))
check('html keeps the title', html.includes('Quiet Interface'))
check('html keeps bold', html.includes('<strong>bold</strong>'))
check('html keeps italic', html.includes('<em>italic</em>'))
check('html keeps underline', html.includes('<u>underline</u>'))
check('html keeps strike', html.includes('<s>struck</s>'))
check('html keeps the highlight colour', html.includes('background:#fde68a'))
check('html keeps the safe link', html.includes('https://example.com/a'))
check('html drops the javascript: link', !html.includes('javascript:'))
check('html escapes the injected script', !html.includes('<script>alert'))
check('html renders list items', html.includes('<li>One</li>'))
check('html renders the blockquote', html.includes('<blockquote>'))
check('html renders the code block', html.includes('<pre>'))
check('html inlines its styles', html.includes('<style>'))
check('html references no remote assets', !/<link[^>]+href="http/.test(html))

// --- PDF --------------------------------------------------------------------

const pdf = readFileSync(join(dir, 'sample.pdf'))
check('pdf has a PDF header', pdf.subarray(0, 5).toString() === '%PDF-')
if (has('pdftotext')) {
  const text = run('pdftotext', [join(dir, 'sample.pdf'), '-'])
  check('pdf contains the title', text.includes('Quiet Interface'))
  check('pdf contains marked-up text', text.includes('bold'))
  check('pdf contains list items', text.includes('One') && text.includes('Two'))
  // The payload is user text, so it is expected to appear as inert characters.
  // The security property is that it was not treated as markup.
  // Extracted PDF text cannot distinguish escaped text from markup, so the only
  // meaningful assertion is that the payload survived as literal characters.
  // The "not executable" property is asserted against the HTML output above,
  // where the actual markup boundary is observable.
  check('pdf renders the payload as literal text', text.includes('<script>alert('))
  check('pdf excludes the blocked link target', !text.includes('javascript:'))
} else {
  console.log('  [SKIP] pdftotext unavailable')
}
if (has('file')) {
  const kind = run('file', ['-b', join(dir, 'sample.pdf')])
  check('file(1) recognises the pdf', /PDF document/.test(kind), kind.trim())
}

// --- DOCX -------------------------------------------------------------------

const docx = readFileSync(join(dir, 'sample.docx'))
check('docx is a zip container', docx.subarray(0, 4).toString() === 'PK\u0003\u0004')
if (has('unzip')) {
  const list = run('unzip', ['-l', join(dir, 'sample.docx')])
  check('docx contains word/document.xml', list.includes('word/document.xml'))
  const body = run('unzip', ['-p', join(dir, 'sample.docx'), 'word/document.xml'])
  check('docx keeps the title', body.includes('Quiet Interface'))
  check('docx keeps list text', body.includes('One') && body.includes('Two'))
  check('docx renders the payload as literal text', body.includes('alert('))
} else {
  console.log('  [SKIP] unzip unavailable')
}
if (has('file')) {
  const kind = run('file', ['-b', join(dir, 'sample.docx')])
  check('file(1) recognises the docx', /Microsoft Word/.test(kind), kind.trim())
}

// --- EPUB -------------------------------------------------------------------

const epub = readFileSync(join(dir, 'sample.epub'))
check('epub is a zip container', epub.subarray(0, 4).toString() === 'PK\u0003\u0004')
check('epub first entry is mimetype', epub.subarray(30, 38).toString() === 'mimetype')
if (has('unzip')) {
  check('epub mimetype is exact', run('unzip', ['-p', join(dir, 'sample.epub'), 'mimetype']) === 'application/epub+zip')
  const list = run('unzip', ['-l', join(dir, 'sample.epub')])
  for (const part of ['META-INF/container.xml', 'EPUB/package.opf', 'EPUB/nav.xhtml', 'EPUB/chapter1.xhtml']) {
    check(`epub contains ${part}`, list.includes(part))
  }
  const chapter = run('unzip', ['-p', join(dir, 'sample.epub'), 'EPUB/chapter1.xhtml'])
  check('epub chapter keeps the title', chapter.includes('Quiet Interface'))
  check('epub chapter excludes the script payload', !chapter.includes('<script>alert'))
  // Matches <br>, <br   > but not <br />.
  const unclosedVoid = chapter.match(/<(?:br|hr|img)((?:[^>/]|\/[^>])*)>/i)
  check('epub chapter self-closes void tags', unclosedVoid === null, unclosedVoid ? unclosedVoid[0] : '')
} else {
  console.log('  [SKIP] unzip unavailable')
}
if (has('file')) {
  const kind = run('file', ['-b', join(dir, 'sample.epub')])
  check('file(1) recognises the epub', /EPUB/.test(kind), kind.trim())
}

// --- Markdown ---------------------------------------------------------------

// Markdown is serialised by @tiptap/markdown in the frontend, so the Rust
// harness writes a fixed sample. Content correctness for that path is covered by
// tests/markdown.test.mjs; here we only assert the write path.
const md = read('sample.md')
check('markdown keeps its heading', md.startsWith('# '), md.split('\n')[0])
check('markdown keeps sub-headings', md.includes('## '), 'second-level heading')
check('markdown ends with a newline', md.endsWith('\n'))
check('markdown has no CRLF', !md.includes('\r'))

// --- hygiene ----------------------------------------------------------------

const leftovers = readdirSync(dir).filter((name) => name.includes('.quill-export-'))
check('no temp files left behind', leftovers.length === 0, `found ${leftovers.length}`)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${failed ? 'FAILED' : 'ALL CHECKS PASSED'}`)
if (failed) process.exit(1)
