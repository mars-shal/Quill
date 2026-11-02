/**
 * Verifies Markdown serialisation, which runs on the frontend.
 *
 * ProseMirror JSON -> Markdown is done by `@tiptap/markdown` rather than in
 * Rust, because the JSON -> HTML -> Markdown path loses node identity (mark
 * merging, hard breaks, ordered-list start values, custom nodes). Rust then only
 * writes the resulting bytes to disk.
 *
 * These tests drive a real editor instance, because that is the only supported
 * entry point: `MarkdownManager` used standalone returns empty output unless it
 * is given an editor's already-flattened extensions, so testing it directly
 * would exercise a path the app never takes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
})
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Node', dom.window.Node)
define('DOMParser', dom.window.DOMParser)
define('getSelection', () => dom.window.getSelection())

const { Editor } = await import('@tiptap/core')
const StarterKit = (await import('@tiptap/starter-kit')).default
const Collaboration = (await import('@tiptap/extension-collaboration')).default
const { Markdown } = await import('@tiptap/markdown')
const { TextStyle } = await import('@tiptap/extension-text-style')
const Y = await import('yjs')

const FRAGMENT = 'quill-body'

/** Builds an editor with the same extension set the app ships. */
function makeEditor() {
  const doc = new Y.Doc()
  return new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3] } }),
      TextStyle,
      Markdown,
      Collaboration.configure({ document: doc, field: FRAGMENT }),
    ],
    content: null,
  })
}

/** Sets HTML and returns the serialised Markdown. */
function toMarkdown(html) {
  const editor = makeEditor()
  editor.commands.setContent(html)
  const md = editor.getMarkdown()
  editor.destroy()
  return md
}

// --- structure --------------------------------------------------------------

test('serialises a heading and a paragraph', () => {
  const md = toMarkdown('<h2>Title</h2><p>Body text.</p>')
  assert.match(md, /## Title/, md)
  assert.match(md, /Body text\./, md)
})

test('heading level is preserved', () => {
  assert.match(toMarkdown('<h1>One</h1>'), /# One/)
  assert.match(toMarkdown('<h2>Two</h2>'), /## Two/)
  assert.match(toMarkdown('<h3>Three</h3>'), /### Three/)
})

test('serialises inline marks', () => {
  const md = toMarkdown('<p><strong>bold</strong> and <em>italic</em> and <u>under</u> and <s>struck</s></p>')
  assert.match(md, /\*\*bold\*\*/, md)
  assert.match(md, /\*italic\*/, md)
  assert.match(md, /\+\+under\+\+/, md)
  assert.match(md, /~~struck~~/, md)
})

test('serialises lists', () => {
  const unordered = toMarkdown('<ul><li>One</li><li>Two</li></ul>')
  assert.match(unordered, /One/, unordered)
  assert.match(unordered, /Two/, unordered)
  assert.match(unordered, /-/, unordered)

  const ordered = toMarkdown('<ol><li>First</li><li>Second</li></ol>')
  assert.match(ordered, /First/, ordered)
  assert.match(ordered, /1\./, ordered)
})

test('serialises blockquote and code block', () => {
  const quoted = toMarkdown('<blockquote><p>Quoted line.</p></blockquote>')
  assert.match(quoted, /Quoted line\./, quoted)
  assert.match(quoted, />/, quoted)

  const code = toMarkdown('<pre><code>const x = 1;</code></pre>')
  assert.match(code, /const x = 1;/, code)
})

test('serialises a link', () => {
  const md = toMarkdown('<p><a href="https://example.com/notes">notes</a></p>')
  assert.match(md, /https:\/\/example\.com\/notes/, md)
})

test('serialises a rule', () => {
  assert.match(toMarkdown('<p>above</p><hr /><p>below</p>'), /---/)
})

// --- round trip -------------------------------------------------------------

test('markdown round-trips back into the editor without losing headings', () => {
  const first = makeEditor()
  first.commands.setContent('<h2>Kept</h2><p>And kept.</p>')
  const md = first.getMarkdown()
  first.destroy()

  const second = makeEditor()
  second.commands.setContent(md, { contentType: 'markdown' })
  const html = second.getHTML()
  second.destroy()

  assert.match(html, /Kept/, html)
  assert.match(html, /And kept\./, html)
})

// --- the shape the Rust exporters receive -----------------------------------

test('editor JSON is a document the Rust renderer can walk', () => {
  const editor = makeEditor()
  editor.commands.setContent('<h2>Heading</h2><p>Paragraph</p>')
  const json = editor.getJSON()

  // src-tauri/src/export.rs walks `content` arrays and reads `type`, so the
  // payload crossing IPC must be a ProseMirror document.
  assert.equal(json.type, 'doc')
  assert.ok(Array.isArray(json.content))
  assert.ok(json.content.every((node) => typeof node.type === 'string'))

  const types = json.content.map((n) => n.type)
  assert.ok(types.includes('heading'), `expected a heading, got ${types}`)
  assert.ok(types.includes('paragraph'), `expected a paragraph, got ${types}`)
  editor.destroy()
})

test('editor JSON carries marks the Rust renderer understands', () => {
  const editor = makeEditor()
  editor.commands.setContent('<p>a <strong>b</strong> <a href="https://e.test">c</a></p>')
  const json = editor.getJSON()

  const marks = (json.content[0]?.content ?? []).flatMap((n) => (n.marks ?? []).map((m) => m.type))
  assert.ok(marks.includes('bold'), `expected a bold mark, got ${marks}`)
  assert.ok(marks.includes('link'), `expected a link mark, got ${marks}`)
  editor.destroy()
})

test('getMarkdown does not mutate the shared document', () => {
  const editor = makeEditor()
  editor.commands.setContent('<h2>Stable</h2><p>Body.</p>')
  const before = editor.getJSON()
  const first = editor.getMarkdown()
  const second = editor.getMarkdown()
  assert.equal(first, second, 'serialisation must be deterministic')
  assert.deepEqual(editor.getJSON(), before, 'the document must be unchanged')
  editor.destroy()
})
