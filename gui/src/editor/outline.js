/**
 * The sections outline.
 *
 * Every H1 is a section. H2 and H3 nest beneath it, so a writer who reaches for
 * the most natural heading level still gets a populated outline. This used to
 * skip H1 outright and treat H2 as the section level, which meant an H1
 * document showed no sections at all.
 */

/** The heading level that starts a section. */
export const SECTION_LEVEL = 'h1'

/** Heading levels the outline renders, outermost first. */
export const OUTLINE_LEVELS = ['h1', 'h2', 'h3']

/** The level nested directly under a section. */
const SUBSECTION_LEVEL = 'h2'

/**
 * Builds the outline from the live ProseMirror document.
 *
 * Headings are located by document position rather than by a DOM id: the editor
 * owns its own node attributes, and positions survive re-renders far more
 * predictably than synthetic ids would.
 *
 * @param {import('@tiptap/react').Editor} editor
 */
export function collectHeadings(editor) {
  const result = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true
    const level = `h${node.attrs.level}`
    if (!OUTLINE_LEVELS.includes(level)) return true
    result.push({ id: `section-${result.length}`, level, text: node.textContent || 'Untitled section', pos })
    return false
  })
  return result
}

/**
 * The id of the heading a row belongs under, or null at the top level.
 *
 * An H3 looks for the nearest H2 and falls back to the nearest H1, so a
 * document that skips a level still nests instead of floating loose.
 */
export function getParentId(headings, index) {
  const level = headings[index]?.level
  if (level !== SUBSECTION_LEVEL && level !== 'h3') return null
  const wanted = level === 'h3' ? [SUBSECTION_LEVEL, SECTION_LEVEL] : [SECTION_LEVEL]
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (wanted.includes(headings[cursor].level)) return headings[cursor].id
  }
  return null
}

/** 1-based position among the sections, for the outline numbering. */
export function sectionNumber(headings, index) {
  return headings.slice(0, index + 1).filter((item) => item.level === SECTION_LEVEL).length
}

/**
 * The section a reader is currently in, from the headings inside the reading
 * region.
 *
 * `tracked` is in document order and `current` holds the ids the observer
 * reports as inside the region, so the answer is the last one -- which is why
 * this walks the ordered list rather than the Set.
 *
 * Returns null for an empty region, and the caller must treat that as "no
 * change" rather than "no section": the reader spends most of their time in the
 * body text between headings, where nothing intersects, and clearing the
 * highlight there would make the outline flicker.
 *
 * @param {Array<{ id: string }>} tracked headings in document order
 * @param {Set<string>} current ids currently intersecting
 * @returns {string | null}
 */
export function pickActiveHeading(tracked, current) {
  let latest = null
  for (const heading of tracked) if (current.has(heading.id)) latest = heading.id
  return latest
}

/**
 * Whether the row at `index` has nested rows, so it renders a disclosure toggle.
 *
 * Looks ahead rather than testing the next heading's own state, because an H3
 * directly under an H1 is a child of the H1 even though it has no H2 of its own.
 */
export function hasChildren(headings, index) {
  const next = headings[index + 1]
  if (!next || !OUTLINE_LEVELS.includes(next.level)) return false
  if (next.level === SECTION_LEVEL) return false
  return getParentId(headings, index + 1) === headings[index].id
}
