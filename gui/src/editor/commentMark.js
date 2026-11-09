import { Mark, mergeAttributes } from '@tiptap/core'

/** A comment anchor: the selected text, not the comment thread itself. */
export const CommentMark = Mark.create({
  name: 'comment',
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-comment-id'),
        renderHTML: (attributes) => (attributes.id ? { 'data-comment-id': attributes.id } : {}),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'comment-mark' }), 0]
  },
})
