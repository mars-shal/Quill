/**
 * Markdown for assistant replies.
 *
 * The transcript used to split on newlines and render `<br />`, which left
 * headings, lists, tables, code and LaTeX as their source text. The import
 * converter already owns escaping and the block grammar, so this reuses it and
 * turns the math placeholders it emits into KaTeX HTML.
 *
 * The output goes through `dangerouslySetInnerHTML`, which is safe here because
 * `markdownToHtml` escapes every source character before adding its own tags.
 */

import katex from 'katex'
import { markdownToHtml } from './importFile.js'

const MATH_NODE = /<(span|div) data-type="(inline|block)-math" data-latex="([^"]*)"><\/\1>/g

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

function decodeAttribute(value) {
  return String(value).replace(/&(amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match] ?? match)
}

/**
 * Renders one assistant message as HTML.
 *
 * A formula KaTeX cannot parse falls back to the LaTeX source in a code span:
 * showing the source is useful, while an empty box or a crash is not.
 */
export function renderChatMarkdown(text = '') {
  // Models use literal <br> inside table cells to separate bullets. The
  // Markdown pass escapes it, so turn the escaped form back into a real break;
  // it is a tag we control, not source HTML.
  const escapedHtml = markdownToHtml(String(text)).replace(/&lt;br\s*\/?&gt;/gi, '<br>')
  const html = escapedHtml
    .replace(/<table>/g, '<div class="message-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
  return html.replace(MATH_NODE, (_, tag, kind, latex) => {
    try {
      return katex.renderToString(decodeAttribute(latex), {
        displayMode: kind === 'block',
        throwOnError: false,
        output: 'html',
      })
    } catch {
      return `<code>${decodeAttribute(latex)}</code>`
    }
  })
}
