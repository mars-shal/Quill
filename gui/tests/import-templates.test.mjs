/**
 * Template and import conversion contracts.
 *
 * Both are pure functions in front of the store: a template decides what a
 * new document starts with, and an import decides what an existing file turns
 * into. Testing them here means a broken heading level or a swallowed
 * paragraph fails before a window opens.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

import { DOCUMENT_TEMPLATES, templateById } from '../src/library/templates.js'
import {
  cleanupImportedHtml,
  fileExtension,
  fileToDocument,
  isSupportedImport,
  markdownToHtml,
  sanitizeHtml,
  splitMathSegments,
  textToHtml,
  titleFromName,
} from '../src/library/importFile.js'

test('the thesis template carries the sections an examiner expects', () => {
  const thesis = templateById('thesis')
  assert.equal(thesis.title, 'Untitled thesis')
  assert.equal(thesis.kind, 'Thesis')
  assert.deepEqual(thesis.collections, ['Thesis'])
  for (const heading of ['Abstract', '1. Introduction', '2. Literature review', '3. Methodology', '4. Results', '5. Discussion', '6. Conclusion', 'References']) {
    assert.ok(thesis.content.includes(`<h2>${heading}</h2>`), `thesis should include ${heading}`)
  }
})

test('every template has the fields the create path needs, and unknown ids fall back', () => {
  const ids = new Set()
  for (const template of DOCUMENT_TEMPLATES) {
    assert.ok(template.id && !ids.has(template.id), `${template.id} is unique`)
    ids.add(template.id)
    assert.ok(template.name && template.description)
    assert.ok(template.title && template.kind && template.content)
    assert.ok(Array.isArray(template.collections) && template.collections.length)
  }
  assert.equal(templateById('does-not-exist').id, 'blank')
})

test('markdown imports become editor HTML', () => {
  const html = markdownToHtml([
    '# A heading',
    '',
    'A paragraph with **bold**, *italic* and [a link](https://example.com).',
    '',
    '- one',
    '- two',
    '',
    '> a quotation',
    '',
    '```',
    '<raw>',
    '```',
  ].join('\n'))

  assert.match(html, /<h1>A heading<\/h1>/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<em>italic<\/em>/)
  assert.match(html, /<a href="https:\/\/example.com">a link<\/a>/)
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/)
  assert.match(html, /<blockquote><p>a quotation<\/p><\/blockquote>/)
  assert.match(html, /<pre><code>&lt;raw&gt;<\/code><\/pre>/)
})

test('an imported HTML file loses its scripts and event handlers', () => {
  const clean = sanitizeHtml('<h1>Hi</h1><script>alert(1)</script><img src="x" onerror="steal()">')
  assert.doesNotMatch(clean, /script/i)
  assert.doesNotMatch(clean, /onerror/i)
  assert.match(clean, /<h1>Hi<\/h1>/)
})

test('plain text keeps its paragraph breaks and escapes markup', () => {
  const doc = fileToDocument({
    name: 'field-notes.txt',
    path: '/home/reader/field-notes.txt',
    content: 'First <note>\n\nSecond line',
  })
  assert.equal(doc.title, 'field notes')
  assert.equal(doc.content, '<p>First &lt;note&gt;</p><p>Second line</p>')
  assert.equal(doc.filename, 'field-notes.txt')
  assert.equal(doc.provenance, 'import:/home/reader/field-notes.txt')
})

test('the shell format wins over the extension for extracted files', () => {
  const pdf = fileToDocument({
    name: 'paper.pdf',
    format: 'text',
    content: 'A first paragraph.\n\nA second paragraph.',
  })
  assert.equal(pdf.title, 'paper')
  assert.equal(pdf.content, '<p>A first paragraph.</p><p>A second paragraph.</p>')

  const docx = fileToDocument({
    name: 'report.docx',
    format: 'markdown',
    content: '# Findings\n\nA paragraph.',
  })
  assert.match(docx.content, /<h1>Findings<\/h1>/)
})

test('markdown pipe tables become editor tables', () => {
  const html = markdownToHtml([
    '| Feature | RC | Direct |',
    '| --- | --- | --- |',
    '| Bandwidth | good | best |',
    '| Bias | independent | coupled |',
  ].join('\n'))
  assert.match(html, /<table><tbody><tr><th>Feature<\/th><th>RC<\/th><th>Direct<\/th><\/tr>/)
  assert.match(html, /<tr><td>Bandwidth<\/td><td>good<\/td><td>best<\/td><\/tr>/)
})

test('LaTeX delimiters become Mathematics nodes, not literal text', () => {
  const html = markdownToHtml('The gain is $A_v = g_m R_C$ and the load is \\(R_L\\).')
  assert.match(html, /<span data-type="inline-math" data-latex="A_v = g_m R_C"><\/span>/)
  assert.match(html, /<span data-type="inline-math" data-latex="R_L"><\/span>/)

  const display = markdownToHtml('$$\\frac{V_{out}}{V_{in}}$$')
  assert.match(display, /<div data-type="block-math" data-latex="\\frac\{V_\{out\}\}\{V_\{in\}\}"><\/div>/)
})

test('a bare dollar amount is not mistaken for math', () => {
  const html = markdownToHtml('The part costs $100 and the cable costs $20.')
  assert.doesNotMatch(html, /data-type="inline-math"/)
  assert.match(html, /\$100/)
})

test('PDF line breaks are rejoined into readable paragraphs', () => {
  const html = textToHtml('A single transistor stage cannot\nsupply all of these requirements.\n\nA second paragraph.')
  assert.equal(
    html,
    '<p>A single transistor stage cannot supply all of these requirements.</p><p>A second paragraph.</p>',
  )
})

test('PDF table columns become a real table when the spacing agrees', () => {
  const html = textToHtml('Feature    RC    Direct\nBandwidth    good    best\nBias    independent    coupled')
  assert.match(html, /<table><tbody><tr><th>Feature<\/th><th>RC<\/th><th>Direct<\/th><\/tr>/)
  assert.match(html, /<tr><td>Bandwidth<\/td><td>good<\/td><td>best<\/td><\/tr>/)
})

test('cleanup removes Word XML and revives literal LaTeX', () => {
  const previous = globalThis.DOMParser
  globalThis.DOMParser = new JSDOM().window.DOMParser
  try {
    const cleaned = cleanupImportedHtml(
      '<p>Gain is $A_v$</p><p>Table</p><p><w:tblPr><w:t>raw</w:t></w:tblPr></p><p><br></p>',
    )
    assert.doesNotMatch(cleaned, /w:tblPr|<w:/)
    assert.match(cleaned, /<span data-type="inline-math" data-latex="A_v"><\/span>/)
    assert.equal(cleaned.includes('<p><br></p>'), false)
  } finally {
    if (previous === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = previous
  }
  assert.deepEqual(splitMathSegments('gain $A_v$'), [
    { text: 'gain ' },
    { latex: 'A_v' },
  ])
  assert.deepEqual(splitMathSegments('cost $5 and $20'), [
    { text: 'cost $5 and $20' },
  ])
})

test('file names and support are read without trusting the path', () => {
  assert.equal(fileExtension('/tmp/a.markdown'), 'markdown')
  assert.equal(titleFromName('/tmp/A_Field Guide.md'), 'A Field Guide')
  assert.equal(titleFromName(''), 'Imported document')
  assert.equal(isSupportedImport('notes.MD'), true)
  assert.equal(isSupportedImport('paper.pdf'), true)
  assert.equal(isSupportedImport('report.docx'), true)
  assert.equal(isSupportedImport('photo.png'), false)
})
