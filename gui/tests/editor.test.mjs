/**
 * Editor tests — HTML sanitisation and schema handling.
 *
 * Run with: node --test tests/editor.test.mjs
 *
 * Uses jsdom plus a real Tiptap editor configured the same way the app does,
 * so the schema and parser under test are the ones that ship.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// Tiptap/ProseMirror expect a DOM at import time. Node 24 exposes some of
// these as getter-only globals, so assign via defineProperty.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
})

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}

defineGlobal('window', dom.window)
defineGlobal('document', dom.window.document)
defineGlobal('navigator', dom.window.navigator)
defineGlobal('HTMLElement', dom.window.HTMLElement)
defineGlobal('Node', dom.window.Node)
defineGlobal('DOMParser', dom.window.DOMParser)
defineGlobal('getSelection', () => dom.window.getSelection())

const { Editor } = await import('@tiptap/core')
const StarterKit = (await import('@tiptap/starter-kit')).default
const Collaboration = (await import('@tiptap/extension-collaboration')).default
const Y = await import('yjs')

const FRAGMENT = 'quill-body'

function makeEditor() {
  const doc = new Y.Doc()
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3] } }),
      Collaboration.configure({ document: doc, field: FRAGMENT }),
    ],
    content: null,
  })
  return { editor, doc }
}

function html(editor) {
  return editor.getHTML()
}

// --- legacy content conversion ----------------------------------------------

test('legacy headings and paragraphs convert', () => {
  const { editor } = makeEditor()
  editor.commands.setContent('<h2>First section</h2><p>Some text.</p>')
  const out = html(editor)
  assert.match(out, /First section/)
  assert.match(out, /Some text\./)
  assert.match(out, /<h2>/)
  editor.destroy()
})

test('nested headings from the seed data are preserved', () => {
  const { editor } = makeEditor()
  editor.commands.setContent(
    '<h2>Parent</h2><p>body</p><h3>Child</h3><p>more</p>',
  )
  const out = html(editor)
  assert.match(out, /<h2>Parent<\/h2>/)
  assert.match(out, /<h3>Child<\/h3>/)
  editor.destroy()
})

test('lists and quotes survive conversion', () => {
  const { editor } = makeEditor()
  editor.commands.setContent(
    '<ul><li>one</li><li>two</li></ul><blockquote><p>quoted</p></blockquote>',
  )
  const out = html(editor)
  assert.match(out, /<ul>/)
  assert.match(out, /one/)
  assert.match(out, /<blockquote>/)
  editor.destroy()
})

test('inline formatting survives conversion', () => {
  const { editor } = makeEditor()
  editor.commands.setContent(
    '<p>a <strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
  )
  const out = html(editor)
  assert.match(out, /<strong>bold<\/strong>/)
  assert.match(out, /<em>italic<\/em>/)
  assert.match(out, /<code>code<\/code>/)
  editor.destroy()
})

// --- sanitisation ------------------------------------------------------------

test('script tags are dropped', () => {
  const { editor } = makeEditor()
  editor.commands.setContent('<p>safe</p><script>window.__pwned = true</script>')
  const out = html(editor)
  assert.doesNotMatch(out, /<script/i)
  assert.doesNotMatch(out, /__pwned/)
  assert.match(out, /safe/)
  editor.destroy()
})

test('event handler attributes are dropped', () => {
  const { editor } = makeEditor()
  editor.commands.setContent('<p onclick="window.__pwned = true">click</p>')
  const out = html(editor)
  assert.doesNotMatch(out, /onclick/i)
  assert.doesNotMatch(out, /__pwned/)
  editor.destroy()
})

test('javascript: links are not preserved as clickable links', () => {
  const { editor } = makeEditor()
  editor.commands.setContent('<p><a href="javascript:window.__pwned=true">click</a></p>')
  const out = html(editor)
  assert.doesNotMatch(out, /javascript:/i)
  editor.destroy()
})

test('style attributes are not carried through', () => {
  const { editor } = makeEditor()
  editor.commands.setContent('<p style="position:fixed;top:0;left:0">text</p>')
  const out = html(editor)
  assert.doesNotMatch(out, /position:\s*fixed/i)
  editor.destroy()
})

test('iframe and object embeds are dropped', () => {
  const { editor } = makeEditor()
  editor.commands.setContent(
    '<p>before</p><iframe src="https://evil.example"></iframe><object data="x"></object>',
  )
  const out = html(editor)
  assert.doesNotMatch(out, /<iframe/i)
  assert.doesNotMatch(out, /<object/i)
  assert.match(out, /before/)
  editor.destroy()
})

// --- yjs integration ---------------------------------------------------------

test('content written to the editor reaches the Yjs fragment', () => {
  const { editor, doc } = makeEditor()
  editor.commands.setContent('<h2>Shared</h2><p>body</p>')

  const fragment = doc.getXmlFragment(FRAGMENT)
  assert.ok(fragment.length > 0, 'fragment should hold nodes')

  // A second client applying the state sees the same text.
  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
  const text = remote.getXmlFragment(FRAGMENT).toString()
  assert.match(text, /Shared/)
  editor.destroy()
})

test('reopening a Yjs doc restores the previous content', () => {
  const { editor, doc } = makeEditor()
  editor.commands.setContent('<h2>Persisted</h2><p>stays here</p>')
  const state = Y.encodeStateAsUpdate(doc)

  const reopenedDoc = new Y.Doc()
  Y.applyUpdate(reopenedDoc, state)

  const { editor: editor2 } = makeEditorWith(reopenedDoc)
  assert.match(editor2.getHTML(), /Persisted/)
  assert.match(editor2.getHTML(), /stays here/)
  editor.destroy()
  editor2.destroy()
})

function makeEditorWith(doc) {
  return {
    editor: new Editor({
      extensions: [
        StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3] } }),
        Collaboration.configure({ document: doc, field: FRAGMENT }),
      ],
      content: null,
    }),
  }
}

// --- statistics --------------------------------------------------------------

test('statistics reflect the document text', () => {
  const { editor } = makeEditor()
  editor.commands.setContent('<p>one two three four five</p>')
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, ' ', ' ')
  const words = text.trim().split(/\s+/).length
  assert.equal(words, 5)
  assert.equal(editor.state.doc.childCount, 1)
  editor.destroy()
})

// --- font family / size -----------------------------------------------------
//
// Regression: the toolbar dispatches `setFontFamily`/`setFontSize`, but those
// commands are provided by the `FontFamily` and `FontSize` extensions -- not by
// the base `TextStyle` mark. Registering only the mark left the commands off the
// chain, so the pickers silently did nothing. The editor below is built from the
// app's own extension list, so this fails if those two are ever dropped again.

test('the app extension set registers the font family and size commands', async () => {
  const { baseExtensions } = await import('../src/editor/useCollaborativeDocument.js')
  const doc = new Y.Doc()
  const editor = new Editor({
    extensions: [
      ...baseExtensions(),
      Collaboration.configure({ document: doc, field: FRAGMENT }),
    ],
    content: null,
  })

  assert.equal(typeof editor.commands.setFontFamily, 'function', 'setFontFamily must be registered')
  assert.equal(typeof editor.commands.setFontSize, 'function', 'setFontSize must be registered')

  // And they have to actually reach the document, not just exist: select the
  // text, apply both, and read the rendered style back out of the HTML.
  editor.commands.setContent('<p>some words</p>')
  editor.commands.setTextSelection({ from: 1, to: 11 })
  assert.equal(editor.commands.setFontFamily('Georgia'), true, 'setFontFamily applies')
  assert.equal(editor.commands.setFontSize('24px'), true, 'setFontSize applies')

  const html = editor.getHTML()
  assert.match(html, /font-family:\s*Georgia/, 'the family reaches the rendered span')
  assert.match(html, /font-size:\s*24px/, 'the size reaches the rendered span')

  editor.destroy()
})

// --- table size --------------------------------------------------------------
//
// The toolbar's Rows/Cols pickers walk Tiptap's one-step add/delete commands
// until the table reaches the requested shape. That walk is the part that can
// silently stop early, so it runs against the real extension list here.

const table = (rows, cols) => {
  const header = `<tr>${'<th>h</th>'.repeat(cols)}</tr>`
  const body = `<tr>${'<td>c</td>'.repeat(cols)}</tr>`.repeat(rows - 1)
  return `<table><tbody>${header}${body}</tbody></table>`
}

const selectFirstCell = (editor) => {
  let position = null
  editor.state.doc.descendants((node, at) => {
    if (position !== null) return false
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      position = at + 2
      return false
    }
    return true
  })
  assert.notEqual(position, null, 'the document contains a table cell')
  editor.commands.setTextSelection(position)
}

test('the table size helper shrinks and grows a real table', async () => {
  const { baseExtensions } = await import('../src/editor/useCollaborativeDocument.js')
  const { readTableSize, resizeTable } = await import('../src/editor/tableSize.js')
  const doc = new Y.Doc()
  const editor = new Editor({
    extensions: [
      ...baseExtensions(),
      Collaboration.configure({ document: doc, field: FRAGMENT }),
    ],
    content: null,
  })

  editor.commands.setContent(table(3, 3))
  selectFirstCell(editor)
  assert.deepEqual(readTableSize(editor), { rows: 3, cols: 3 }, 'a 3x3 table reads back as 3x3')

  resizeTable(editor, 2, 2)
  assert.deepEqual(readTableSize(editor), { rows: 2, cols: 2 }, 'shrinking removes rows and columns')
  assert.match(editor.getHTML(), /<th[\s>]/, 'the header row survives a shrink')

  resizeTable(editor, 4, 5)
  assert.deepEqual(readTableSize(editor), { rows: 4, cols: 5 }, 'growing adds rows and columns')
  assert.match(editor.getHTML(), /<th[\s>]/, 'the header row is still first after growing')

  // The last row cannot be deleted, so the helper reports what it reached
  // rather than pretending the request succeeded.
  resizeTable(editor, 1, 1)
  assert.deepEqual(readTableSize(editor), { rows: 1, cols: 1 }, 'a table can shrink to a single cell')

  editor.destroy()
})
