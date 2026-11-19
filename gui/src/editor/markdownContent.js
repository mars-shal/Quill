/**
 * Normalises the ProseMirror JSON that `@tiptap/markdown` produces.
 *
 * Markdown emphasis nests: `*a _b_*` is one italic span inside another, and both
 * map to the same `italic` mark. The markdown parser applies the mark to every
 * text node it contains, so the inner node ends up with `[italic, italic]` --
 * a collection ProseMirror rejects (`Invalid collection of marks for node text:
 * italic,italic`). The collaboration extension turns that into a disabled
 * document, so a generated draft with one nested emphasis could not be written
 * back at all.
 *
 * Rebuilding each set through the schema's own `addToSet` is the same reduction
 * ProseMirror performs when it validates content: it merges duplicate marks and
 * drops mutually exclusive pairs. Parsed HTML goes through that path already;
 * parsed Markdown did not until here.
 */
export function normaliseMarkdownContent(node, schema) {
  if (Array.isArray(node)) return node.map((child) => normaliseMarkdownContent(child, schema))
  if (!node || typeof node !== 'object') return node

  const normalised = { ...node }

  if (Array.isArray(node.marks)) {
    const marks = node.marks.reduce((set, entry) => {
      const type = schema?.marks?.[entry?.type]
      if (!type) return set
      return type.create(entry.attrs || {}).addToSet(set)
    }, [])
    if (marks.length) {
      normalised.marks = marks.map((mark) => (
        Object.keys(mark.attrs || {}).length
          ? { type: mark.type.name, attrs: mark.attrs }
          : { type: mark.type.name }
      ))
    } else {
      delete normalised.marks
    }
  }

  if (Array.isArray(node.content)) {
    normalised.content = node.content.map((child) => normaliseMarkdownContent(child, schema))
  }

  return normalised
}
