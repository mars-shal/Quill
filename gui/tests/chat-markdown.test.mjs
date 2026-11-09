/**
 * Markdown rendering for assistant replies.
 *
 * The transcript is the one surface where model output is shown without an
 * editor schema to parse it, so this pins the two safety properties as well as
 * the formatting: source HTML is escaped, and a `javascript:` link is not made
 * clickable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { renderChatMarkdown } from '../src/library/chatMarkdown.js'

test('assistant markdown becomes real HTML', () => {
  const html = renderChatMarkdown([
    '## Findings',
    '',
    'A **bold** claim with `inline code`.',
    '',
    '- first',
    '- second',
    '',
    '```',
    'const x = 1',
    '```',
  ].join('\n'))

  assert.match(html, /<h2>Findings<\/h2>/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<code>inline code<\/code>/)
  assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/)
  assert.match(html, /<pre><code>const x = 1<\/code><\/pre>/)
})

test('assistant tables and LaTeX render', () => {
  const html = renderChatMarkdown([
    '| Stage | Gain |',
    '| --- | --- |',
    '| First | 40 |',
    '',
    'The gain is $A_v = g_m R_C$.',
  ].join('\n'))

  assert.match(html, /<table><tbody><tr><th>Stage<\/th><th>Gain<\/th><\/tr>/)
  assert.match(html, /<tr><td>First<\/td><td>40<\/td><\/tr>/)
  assert.match(html, /class="katex"/)
})

test('raw HTML is escaped and unsafe links stay text', () => {
  const html = renderChatMarkdown('<script>alert(1)</script>\n\n[click](javascript:alert(1))')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /href="javascript:/)
})
