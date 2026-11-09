import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * Inline ghost text.
 *
 * The suggestion lives in plugin state and is drawn as a widget decoration at
 * the caret, so it never enters the document until Tab accepts it. Typing,
 * moving the caret or Escape clears it; no keystroke can accidentally commit a
 * model's guess.
 */
export const ghostTextKey = new PluginKey('ghost-text')

export const GhostText = Extension.create({
  name: 'ghostText',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: ghostTextKey,
        state: {
          init: () => ({ text: '', pos: null }),
          apply(tr, value) {
            const meta = tr.getMeta(ghostTextKey)
            if (meta) return meta
            if (tr.docChanged || tr.selectionSet) return { text: '', pos: null }
            return value
          },
        },
        props: {
          decorations(state) {
            const { text, pos } = ghostTextKey.getState(state) || {}
            if (!text || pos == null) return null
            return DecorationSet.create(state.doc, [
              Decoration.widget(pos, () => {
                const span = document.createElement('span')
                span.className = 'ghost-text'
                span.textContent = text
                span.setAttribute('aria-hidden', 'true')
                return span
              }, { side: 1 }),
            ])
          },
          handleKeyDown(view, event) {
            const { text, pos } = ghostTextKey.getState(view.state) || {}
            if (!text) return false
            if (event.key === 'Tab') {
              event.preventDefault()
              view.dispatch(view.state.tr.insertText(text, pos))
              return true
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              view.dispatch(view.state.tr.setMeta(ghostTextKey, { text: '', pos: null }))
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})
