/**
 * Turning a file the reader chose into a document.
 *
 * The desktop shell reads the file and hands back its text. This module owns
 * the conversion, so the same rules apply to every import path and can be
 * reasoned about without a webview: Markdown and DOCX-extracted HTML become
 * editor HTML, an HTML file is sanitised, and plain text keeps its paragraphs.
 *
 * Tables and LaTeX are first-class here because they are the two things an
 * academic import loses most visibly. Pipe tables become real `<table>` nodes;
 * `$...$`, `$$...$$`, `\(...\)` and `\[...\]` become the Mathematics
 * extension's own math nodes, which KaTeX renders.
 */

const EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text', 'html', 'htm', 'pdf', 'docx'])

/** Math delimiters, in the order that avoids treating `$$` as empty `$`. */
const MATH_PATTERN = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g

export function fileExtension(name = '') {
  const match = String(name).match(/\.([^.\\/]+)$/)
  return match ? match[1].toLowerCase() : ''
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value = '') {
  return escapeHtml(value)
}

function mathNode(latex, block = false) {
  const tag = block ? 'div' : 'span'
  const kind = block ? 'block-math' : 'inline-math'
  return `<${tag} data-type="${kind}" data-latex="${escapeAttribute(latex)}"></${tag}>`
}

/**
 * Pulls math out of a string before escaping, then puts editor nodes back.
 *
 * A placeholder keeps the math away from the emphasis rules: `_` and `^` in
 * LaTeX are not Markdown, and escaping the whole segment would turn `\{` into
 * an entity KaTeX never sees.
 */
function protectMath(value) {
  const pieces = []
  const text = String(value).replace(MATH_PATTERN, (match, block1, block2, inline1, inline2) => {
    const latex = (block1 ?? block2 ?? inline1 ?? inline2 ?? '').trim()
    const explicit = block1 !== undefined || block2 !== undefined || inline1 !== undefined
    if (!latex || (!explicit && !looksLikeMath(latex))) return match
    const token = `\u0000MATH${pieces.length}\u0000`
    pieces.push(mathNode(latex))
    return token
  })
  return { text, pieces }
}

function restoreMath(text, pieces) {
  return text.replace(/\u0000MATH(\d+)\u0000/g, (_, index) => pieces[Number(index)] ?? '')
}

/**
 * A bare `$...$` is math only when it looks like math. `$100$` is a price, and
 * turning a price into a KaTeX node is worse than leaving it as text.
 */
function looksLikeMath(value = '') {
  const text = String(value).trim()
  if (!text) return false
  if (/^[\d.,\s]+$/.test(text)) return false
  // `$100 and the cable costs $20` has a pair of dollar signs but no operator;
  // it is a price range, not an equation. A formula that starts with a number
  // still has to carry one of the math signals.
  if (/^\d/.test(text) && !/[\\^_{}=+\-*/<>]/.test(text)) return false
  return /[A-Za-z\\^_{}=+\-*/<>]/.test(text)
}

function textWithMath(value) {
  const { text, pieces } = protectMath(value)
  return restoreMath(escapeHtml(text), pieces)
}

/** Only links a document or a chat reply should be allowed to make clickable. */
function safeHref(value = '') {
  const href = String(value).trim()
  return /^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(href) ? href : ''
}

function inline(value) {
  const { text: protectedText, pieces } = protectMath(value)
  let text = escapeHtml(protectedText)
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>')
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, src) => {
    const href = safeHref(src)
    return href ? `<img src="${href}" alt="${alt}" />` : match
  })
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeHref(url)
    return href ? `<a href="${href}">${label}</a>` : match
  })
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  text = text.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>')
  return restoreMath(text, pieces)
}

function isTableRow(line = '') {
  return line.includes('|') && !/^\s*```/.test(line)
}

function isTableSeparator(line = '') {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function tableCells(line = '') {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function tableHtml(header, rows) {
  const head = `<tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr>`
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<table><tbody>${head}${body}</tbody></table>`
}

/** A compact Markdown-to-HTML pass for imported notes and drafts. */
export function markdownToHtml(source = '') {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n')
  const output = []
  let paragraph = []
  let list = null
  let quote = []
  let code = null

  const flushParagraph = () => {
    if (!paragraph.length) return
    output.push(`<p>${inline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    output.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  const flushQuote = () => {
    if (!quote.length) return
    output.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`)
    quote = []
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = raw.trimEnd()

    if (code) {
      if (/^```/.test(line.trim())) {
        output.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`)
        code = null
      } else {
        code.lines.push(raw)
      }
      continue
    }

    if (/^```/.test(line.trim())) {
      flushAll()
      code = { lines: [] }
      continue
    }

    if (!line.trim()) {
      flushAll()
      continue
    }

    const blockMath = line.trim().match(/^\$\$(.+?)\$\$$/) || line.trim().match(/^\\\[(.+?)\\\]$/)
    if (blockMath) {
      flushAll()
      output.push(mathNode(blockMath[1].trim(), true))
      continue
    }

    if (isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushAll()
      const header = tableCells(line)
      const rows = []
      index += 1 // consume the separator
      while (index + 1 < lines.length && isTableRow(lines[index + 1])) {
        index += 1
        rows.push(tableCells(lines[index]))
      }
      output.push(tableHtml(header, rows))
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushAll()
      output.push(`<h${heading[1].length}>${inline(heading[2].trim())}</h${heading[1].length}>`)
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushAll()
      output.push('<hr />')
      continue
    }

    const quoted = line.match(/^\s*>\s?(.*)$/)
    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      continue
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/)
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (unordered || ordered) {
      flushParagraph()
      flushQuote()
      const tag = unordered ? 'ul' : 'ol'
      if (list?.tag !== tag) {
        flushList()
        list = { tag, items: [] }
      }
      list.items.push((unordered || ordered)[1])
      continue
    }

    flushQuote()
    flushList()
    paragraph.push(line.trim())
  }

  flushAll()
  if (code) output.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`)
  return output.join('')
}

/**
 * PDF text to paragraphs.
 *
 * A PDF extractor returns a newline at the end of every visual line, not every
 * sentence. Joining those lines with spaces is what makes the result editable,
 * while a line with table-like spacing keeps its breaks. Hyphenated line ends
 * are repaired first, the way a reader would read them.
 */
export function textToHtml(source = '') {
  const normalised = String(source)
    .replace(/\r\n?/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
  return normalised
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim())
      if (!lines.length) return ''
      // A PDF table is positioned glyphs, not structure. When several
      // consecutive lines have the same number of wide-space/tab separated
      // columns, that is the strongest signal an extractor gives; render it as
      // a table rather than as rows of text.
      const rows = lines.map((line) => line.split(/\t+|\s{2,}/).map((cell) => cell.trim()).filter(Boolean))
      if (rows.length >= 2 && rows[0].length > 1 && rows.every((row) => row.length === rows[0].length)) {
        return tableHtml(rows[0], rows.slice(1))
      }
      const keepBreaks = lines.some((line) => /\S\s{2,}\S/.test(line) || /^\s*([-•–—]|\d+[.)])\s+/.test(line))
      const body = keepBreaks
        ? lines.map((line) => textWithMath(line)).join('<br />')
        : textWithMath(lines.join(' '))
      return `<p>${body}</p>`
    })
    .filter(Boolean)
    .join('')
}

/** Splits a plain string into text and `$...$`-style math segments. */
export function splitMathSegments(value = '') {
  const segments = []
  const pattern = new RegExp(MATH_PATTERN.source, 'g')
  let last = 0
  let match
  while ((match = pattern.exec(String(value)))) {
    if (match.index > last) segments.push({ text: String(value).slice(last, match.index) })
    const latex = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim()
    const explicit = match[1] !== undefined || match[2] !== undefined || match[3] !== undefined
    if (latex && (explicit || looksLikeMath(latex))) segments.push({ latex })
    else segments.push({ text: match[0] })
    last = pattern.lastIndex
  }
  if (last < String(value).length) segments.push({ text: String(value).slice(last) })
  // A rejected `$...$` pair leaves several text runs; join them so callers see
  // one text segment and the original bytes are unchanged.
  return segments.reduce((merged, segment) => {
    if (segment.text === undefined) {
      merged.push(segment)
    } else if (merged.length && merged[merged.length - 1].text !== undefined) {
      merged[merged.length - 1].text += segment.text
    } else {
      merged.push({ ...segment })
    }
    return merged
  }, [])
}

/** Strips the active parts of an imported HTML file. */
export function sanitizeHtml(source = '') {
  const text = String(source)
  if (typeof DOMParser === 'undefined') {
    return text
      .replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  }
  const doc = new DOMParser().parseFromString(text, 'text/html')
  for (const node of doc.querySelectorAll('script, style, iframe, object, embed, link, meta')) node.remove()
  for (const element of doc.body.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name)
      else if (/^(href|src)$/i.test(attribute.name) && /^\s*(javascript|data:text\/html)/i.test(attribute.value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  return doc.body.innerHTML
}

/**
 * The editor's Clean up action.
 *
 * It is deliberately deterministic. An imported draft should not need an LLM
 * turn to stop showing Word XML, and a reader who asks for cleanup wants their
 * document back, not a rewrite. The pass removes leftover `w:`/`m:` markup,
 * turns literal LaTeX in text nodes into real math nodes, drops empty
 * paragraphs, and leaves the document's own structure alone.
 */
export function cleanupImportedHtml(source = '') {
  const text = String(source)
  if (typeof DOMParser === 'undefined') {
    return text.replace(/<\/?[wm]:[^>]*>/g, '')
  }

  const doc = new DOMParser().parseFromString(text, 'text/html')
  for (const node of doc.querySelectorAll('script, style, iframe, object, embed, link, meta')) node.remove()
  for (const element of doc.body.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name)
    }
  }

  // A DOCX table that leaked as markup arrives as unknown `w:`/`m:` elements.
  // Unwrap them so their text survives and the tags do not.
  for (const element of [...doc.body.querySelectorAll('*')].filter((node) => /^[wm]:/i.test(node.tagName))) {
    const parent = element.parentNode
    if (!parent) continue
    while (element.firstChild) parent.insertBefore(element.firstChild, element)
    element.remove()
  }

  const walker = doc.createTreeWalker(doc.body, 4)
  const textNodes = []
  while (walker.nextNode()) textNodes.push(walker.currentNode)
  for (const node of textNodes) {
    const parent = node.parentElement
    if (!parent || parent.closest('pre, code, [data-type$="-math"]')) continue
    const cleaned = String(node.nodeValue || '').replace(/<\/?[wm]:[^>]*>/g, '')
    const segments = splitMathSegments(cleaned)
    if (!segments.some((segment) => segment.latex)) {
      if (cleaned !== node.nodeValue) node.nodeValue = cleaned
      continue
    }
    const fragment = doc.createDocumentFragment()
    for (const segment of segments) {
      if (segment.latex) {
        const span = doc.createElement('span')
        span.setAttribute('data-type', 'inline-math')
        span.setAttribute('data-latex', segment.latex)
        fragment.appendChild(span)
      } else if (segment.text) {
        fragment.appendChild(doc.createTextNode(segment.text))
      }
    }
    parent.replaceChild(fragment, node)
  }

  for (const paragraph of [...doc.body.querySelectorAll('p')]) {
    if (paragraph.textContent.trim()) continue
    if (paragraph.querySelector('img, [data-type$="-math"]')) continue
    paragraph.remove()
  }
  return doc.body.innerHTML
}

/** A filename without its extension, as a human title. */
export function titleFromName(name = '') {
  const base = String(name).split(/[\\/]/).pop() || ''
  const withoutExtension = base.replace(/\.[^.]+$/, '')
  const tidy = withoutExtension.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return tidy || 'Imported document'
}

/**
 * Builds the input `store.createDocument` expects from a file the shell read.
 *
 * `file` is `{ name, path, content, extension?, format? }`. The shell reports
 * what the extractor produced, and that wins over the extension: a DOCX is
 * extracted as HTML, a PDF as text, a Markdown file as Markdown.
 */
export function fileToDocument(file = {}, { clean = true } = {}) {
  const name = String(file.name || file.path || 'Imported document')
  const extension = (file.extension || fileExtension(name)).toLowerCase()
  const format = String(file.format || '').toLowerCase() || extension
  const content = String(file.content ?? '')
  const html = format === 'html'
    ? sanitizeHtml(content)
    : format === 'markdown'
      ? markdownToHtml(content)
      : textToHtml(content)

  const cleaned = clean && html ? cleanupImportedHtml(html) : html

  return {
    title: titleFromName(name),
    kind: 'Draft',
    collections: ['Imported'],
    status: 'Drafts',
    color: '#6a8792',
    filename: name.split(/[\\/]/).pop() || name,
    content: cleaned || '<p><br></p>',
    contentFormat: 'html',
    provenance: `import:${file.path || name}`,
  }
}

export function isSupportedImport(name = '') {
  return EXTENSIONS.has(fileExtension(name))
}
