/**
 * Table sizing for the formatting toolbar.
 *
 * Tiptap's table extension exposes add/delete for one row or column at a time;
 * a "make this 4 x 2" control needs to walk the difference. Kept out of
 * `ChatPanel.jsx` so the walking logic can be tested against a real editor
 * without mounting the whole assistant panel.
 */

import { findTable, TableMap } from '@tiptap/pm/tables'

export const TABLE_SIZE_MAX = 12

/** One option per selectable count, never smaller than the current table. */
export const tableSizes = (largest) =>
  Array.from({ length: Math.max(TABLE_SIZE_MAX, largest) }, (_, index) => index + 1)

/**
 * The rows and columns of the table under the caret, or `null` outside one.
 *
 * Read from the table map rather than the DOM: the map accounts for merged
 * cells, so a 3x3 with a span still reports the grid the reader sees.
 */
export function readTableSize(editor) {
  const selection = editor?.state?.selection
  if (!selection) return null
  const found = findTable(selection.$from)
  if (!found) return null
  const map = TableMap.get(found.node)
  return { rows: map.height, cols: map.width }
}

/**
 * Reshapes the table under the caret to `rows` x `cols`.
 *
 * The caret is parked in the bottom-right cell before each step: additions then
 * append at the edge (instead of piling up beside the original cell) and
 * deletions take the last row or column. Every step recomputes the map, because
 * deleting the row the caret is in moves the table under it.
 *
 * Returns the size the table actually reached, which may be smaller than the
 * request when Tiptap refuses to delete the last row or column.
 */
export function resizeTable(editor, rows, cols) {
  const targetRows = Math.min(TABLE_SIZE_MAX, Math.max(1, Number(rows) || 1))
  const targetCols = Math.min(TABLE_SIZE_MAX, Math.max(1, Number(cols) || 1))

  for (let guard = 0; guard < TABLE_SIZE_MAX * 4; guard += 1) {
    const found = findTable(editor.state.selection.$from)
    if (!found) return null
    const map = TableMap.get(found.node)
    if (map.height === targetRows && map.width === targetCols) break

    editor.commands.setTextSelection(
      found.start + map.positionAt(map.height - 1, map.width - 1, found.node) + 1,
    )

    let changed = false
    if (map.height > targetRows) changed = editor.chain().deleteRow().run()
    else if (map.height < targetRows) changed = editor.chain().addRowAfter().run()
    else if (map.width > targetCols) changed = editor.chain().deleteColumn().run()
    else if (map.width < targetCols) changed = editor.chain().addColumnAfter().run()
    if (!changed) break
  }

  return readTableSize(editor)
}
