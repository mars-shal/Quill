import { Extension, Mark } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

/** Text typed while Suggesting is marked so it can be accepted or rejected. */
export const SuggestionMark = Mark.create({
  name: 'suggestion',
  parseHTML() { return [{ tag: 'span[data-suggestion]' }] },
  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-suggestion': '', class: 'suggestion-mark' }, 0]
  },
})

export const SuggestionMode = Extension.create({
  name: 'suggestionMode',
  addStorage() {
    return { enabled: false }
  },
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('suggestion-mode'),
        props: {
          handleTextInput(view, from, to, text) {
            if (!editor.storage.suggestionMode?.enabled) return false
            const { state, dispatch } = view
            const mark = state.schema.marks.suggestion
            if (!mark) return false
            const transaction = state.tr.insertText(text, from, to)
            transaction.addMark(from, from + text.length, mark.create())
            dispatch(transaction)
            return true
          },
        },
      }),
    ]
  },
})
