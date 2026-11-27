/**
 * `@` mentions for the writer: sections of this document and other files.
 *
 * Two pieces, deliberately separate:
 *
 *   - `MentionNode` is the atom the document stores. It keeps its own label and
 *     kind, renders as a chip, and flattens to `@Label` everywhere text is
 *     needed (markdown export, plain text, the library preview). The live
 *     document is Yjs JSON, so the chip survives a restart even though markdown
 *     has no syntax for it.
 *   - `MentionPicker` is the suggestion plugin. It looks for `@` after a space,
 *     asks the caller for the current sections/files, and publishes the list to
 *     the React menu.
 *
 * The menu is a separate component on purpose: ProseMirror's own popup would be
 * a second visual language next to the rest of the editor.
 */

import { Extension, Node } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { hideMention, publishMention } from './mentionStore.js'

export const MENTION_CHAR = '@'

export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      id: { default: null },
      label: { default: '' },
      kind: { default: 'section' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-mention]',
        getAttrs: (element) => ({
          id: element.getAttribute('data-id'),
          label:
            element.getAttribute('data-label') ||
            (element.textContent || '').replace(/^@/, ''),
          kind: element.getAttribute('data-mention') || 'section',
        }),
      },
    ]
  },

  renderHTML({ node }) {
    const kind = node.attrs.kind === 'file' ? 'file' : 'section'
    return [
      'span',
      {
        class: `writer-mention is-${kind}`,
        'data-mention': kind,
        'data-id': node.attrs.id,
        'data-label': node.attrs.label,
      },
      `${MENTION_CHAR}${node.attrs.label}`,
    ]
  },

  renderText({ node }) {
    return `${MENTION_CHAR}${node.attrs.label}`
  },

  renderMarkdown(node) {
    return `${MENTION_CHAR}${node.attrs?.label ?? ''}`
  },
})

/** Case-insensitive match on the label, then on the kind ("sec", "file"). */
export function filterMentions(items, query) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return items.slice(0, 8)
  return items
    .filter((item) => {
      const label = String(item.label || '').toLowerCase()
      return label.includes(needle) || item.kind.startsWith(needle)
    })
    .slice(0, 8)
}

export function MentionPicker({ getItems }) {
  return Extension.create({
    name: 'writerMentionPicker',

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: MENTION_CHAR,
          pluginKey: new PluginKey('writerMention'),
          allowSpaces: false,
          startOfLine: false,
          items: ({ query }) => filterMentions(getItems() || [], query),
          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertContent({
                type: 'mention',
                attrs: { id: props.id, label: props.label, kind: props.kind },
              })
              .insertContent(' ')
              .run()
          },
          render: () => {
            // The plugin owns both the selection index and the keys: React
            // cannot answer `return true` from inside an effect.
            let items = []
            let active = 0
            let latest = null

            const publish = () => {
              if (!latest) return
              publishMention({
                open: true,
                items,
                active,
                rect: latest.clientRect ? latest.clientRect() : null,
                onPick: (index) => {
                  const item = items[index]
                  if (item) latest.command(item)
                },
                onHover: (index) => {
                  if (index < 0 || index >= items.length || index === active) return
                  active = index
                  publish()
                },
              })
            }

            return {
              onStart: (props) => {
                items = props.items
                active = 0
                latest = props
                publish()
              },
              onUpdate: (props) => {
                items = props.items
                if (active > items.length - 1) active = Math.max(0, items.length - 1)
                latest = props
                publish()
              },
              onKeyDown: (props) => {
                const { event } = props
                if (event.key === 'ArrowDown') {
                  active = items.length ? (active + 1) % items.length : 0
                  publish()
                  return true
                }
                if (event.key === 'ArrowUp') {
                  active = items.length ? (active - 1 + items.length) % items.length : 0
                  publish()
                  return true
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  if (!items.length) return false
                  props.command(items[active])
                  return true
                }
                if (event.key === 'Escape') {
                  hideMention()
                  return true
                }
                return false
              },
              onExit: () => {
                latest = null
                hideMention()
              },
            }
          },
        }),
      ]
    },
  })
}
