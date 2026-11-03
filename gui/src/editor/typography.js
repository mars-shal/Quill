/**
 * Typography the toolbar needs and `@tiptap/extension-text-style` does not
 * ship: letter-spacing on text runs, and line-height on blocks.
 *
 * Both are stored as ordinary attributes and rendered as inline styles, so
 * they survive the HTML autosave and the Yjs body without touching the
 * document schema's node types.
 */
import { Extension } from '@tiptap/core'
import { TextStyle } from '@tiptap/extension-text-style'

/**
 * The text-style mark plus `letterSpacing`.
 *
 * `setMark` (rather than `updateAttributes`) is what the command uses: on a
 * selection with no textStyle mark yet there is nothing to update, and the
 * spacing would silently do nothing.
 */
export const TextStyleWithTracking = TextStyle.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      letterSpacing: {
        default: null,
        parseHTML: (element) => element.style.letterSpacing || null,
        renderHTML: (attributes) =>
          attributes.letterSpacing
            ? { style: `letter-spacing: ${attributes.letterSpacing}` }
            : {},
      },
    }
  },
  addCommands() {
    return {
      ...(this.parent?.() ?? {}),
      setLetterSpacing: (letterSpacing) => ({ chain }) =>
        chain().setMark('textStyle', { letterSpacing }).run(),
      unsetLetterSpacing: () => ({ chain }) =>
        chain().setMark('textStyle', { letterSpacing: null }).run(),
    }
  },
})

/**
 * `line-height` on paragraphs and headings.
 *
 * The command targets whichever block the selection is in, so one command
 * serves both types instead of two that half-work depending on the cursor.
 */
export const LineHeight = Extension.create({
  name: 'lineHeight',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (element) => element.style.lineHeight || null,
            renderHTML: (attributes) =>
              attributes.lineHeight
                ? { style: `line-height: ${attributes.lineHeight}` }
                : {},
          },
        },
      },
    ]
  },

  addCommands() {
    const apply = (lineHeight) => ({ state, chain }) => {
      const type = state.selection.$from.parent.type.name
      if (type !== 'paragraph' && type !== 'heading') return false
      return chain().updateAttributes(type, { lineHeight }).run()
    }
    return {
      setLineHeight: apply,
      unsetLineHeight: apply(null),
    }
  },
})
