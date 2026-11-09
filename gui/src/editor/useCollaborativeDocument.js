/**
 * `useCollaborativeDocument` — binds a Quill document to a Yjs document held by
 * the local persistence provider.
 *
 * Kept separate from the editor component so the hook can be used eagerly while
 * the (large) ProseMirror view is code-split and loaded on demand.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import Highlight from '@tiptap/extension-highlight'
import { Markdown } from '@tiptap/markdown'
import { Mathematics } from '@tiptap/extension-mathematics'
import { Image } from '@tiptap/extension-image'
import { TextAlign } from '@tiptap/extension-text-align'
import { TableKit } from '@tiptap/extension-table'
// `FontFamily` and `FontSize` are separate extensions, not part of the base
// `TextStyle` mark: the mark only carries `toggleTextStyle`/`removeEmptyTextStyle`,
// while the two commands the toolbar dispatches (`setFontFamily`/`setFontSize`)
// live here. Registering only the mark left `chain().setFontFamily(...)` undefined,
// so the font and size pickers silently did nothing.
import { FontFamily, FontSize } from '@tiptap/extension-text-style'
import { TextStyleWithTracking, LineHeight } from './typography.js'
import { CommentMark } from './commentMark.js'
import { SuggestionMark, SuggestionMode } from './suggestionMode.js'
import { GhostText } from './ghostText.js'
import { LocalYDoc } from '../platform/ydoc.js'

/**
 * Fragment name is part of the persisted format. Changing it would orphan every
 * document already written, so it is pinned here deliberately.
 */
export const FRAGMENT = 'quill-body'

export function baseExtensions() {
  return [
    StarterKit.configure({
      // The Collaboration extension supplies its own history; leaving
      // StarterKit's UndoRedo enabled causes duplicated/conflicting undo.
      undoRedo: false,
      heading: { levels: [1, 2, 3] },
    }),
    // StarterKit v3 already provides Underline, Strike and Link, so only what
    // it does not cover is added: Highlight (the Idea/Research/Quote/Cut tags),
    // TextStyle extended with letter-spacing, FontFamily and FontSize (the
    // commands the font and size pickers dispatch), Markdown so export never
    // round-trips through HTML, Mathematics for LaTeX support, Image,
    // TextAlign for the alignment menu, TableKit for tables, and LineHeight
    // for the spacing menu.
    TextStyleWithTracking,
    FontFamily,
    FontSize,
    Highlight,
    Markdown,
    Mathematics,
    Image,
    TextAlign.configure({
      types: ['heading', 'paragraph'],
      alignments: ['left', 'center', 'right', 'justify'],
    }),
    TableKit.configure({ table: { resizable: true } }),
    LineHeight,
    CommentMark,
    SuggestionMark,
    SuggestionMode,
    GhostText,
  ]
}


/** True when the Yjs fragment already holds content. */
export function fragmentHasContent(doc) {
  return doc.getXmlFragment(FRAGMENT).length > 0
}

/**
 * Converts legacy HTML into ProseMirror content and seeds it into the Yjs
 * document. Runs at most once per document.
 *
 * Parsing through the editor schema is the sanitisation boundary: nodes and
 * marks the schema does not define are dropped rather than rendered.
 */
function seedFromHtml(editor, ydoc, html) {
  if (!html || !editor || fragmentHasContent(ydoc.doc)) return false
  try {
    editor.commands.setContent(html, { emitUpdate: true })
    return fragmentHasContent(ydoc.doc)
  } catch (error) {
    console.error('Failed to seed legacy content', error)
    return false
  }
}

export function useCollaborativeDocument({ documentId, legacyHtml, onReady, onStatsChange, onStatusChange }) {
  const [ydoc] = useState(() => (documentId ? new LocalYDoc(documentId) : null))
  const [ready, setReady] = useState(false)
  const seeded = useRef(false)
  const statsTimer = useRef(null)

  // Latest-callback refs so changing a handler does not tear down the document.
  const onStatsChangeRef = useRef(onStatsChange)
  const onStatusChangeRef = useRef(onStatusChange)
  const onReadyRef = useRef(onReady)
  useEffect(() => { onStatsChangeRef.current = onStatsChange }, [onStatsChange])
  useEffect(() => { onStatusChangeRef.current = onStatusChange }, [onStatusChange])
  useEffect(() => { onReadyRef.current = onReady }, [onReady])

  // Load the persisted state before the editor is allowed to mount.
  useEffect(() => {
    if (!ydoc) return undefined
    let cancelled = false

    const unsubscribe = ydoc.subscribe('status', (status) => onStatusChangeRef.current?.(status))

    ydoc
      .load()
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((error) => {
        console.error('Failed to load document', error)
        if (!cancelled) setReady(true)
      })

    return () => {
      cancelled = true
      unsubscribe()
      ydoc.flushNow().finally(() => ydoc.destroy())
    }
  }, [ydoc])

  const editor = useEditor(
    {
      extensions: [
        ...baseExtensions(),
        Collaboration.configure({ document: ydoc?.doc, field: FRAGMENT }),
      ],
      // Collaboration supplies the document; never seed from a `content` prop
      // or ProseMirror will overwrite the shared state.
      content: null,
      editorProps: {
        attributes: {
          class: 'document-prose',
          spellcheck: 'true',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Document body',
        },
      },
      immediatelyRender: false,
    },
    [ydoc, ready],
  )

  // Seed legacy HTML once the editor exists and the Yjs state has loaded.
  useEffect(() => {
    if (!editor || !ydoc || seeded.current) return
    if (!ydoc.enabled) {
      // Browser fallback: no durable Yjs store, so seed every time.
      if (legacyHtml) {
        editor.commands.setContent(legacyHtml, { emitUpdate: true })
        seeded.current = true
      }
      return
    }
    if (fragmentHasContent(ydoc.doc)) {
      seeded.current = true
      return
    }
    if (seedFromHtml(editor, ydoc, legacyHtml)) {
      seeded.current = true
    }
  }, [editor, ydoc, legacyHtml])

  // Report word/character statistics, throttled so typing stays cheap.
  useEffect(() => {
    if (!editor) return undefined
    const publish = () => {
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, ' ', ' ')
      const trimmed = text.trim()
      const words = trimmed ? trimmed.split(/\s+/).length : 0
      onStatsChangeRef.current?.({
        words,
        chars: text.replace(/\s/g, '').length,
        paragraphs: editor.state.doc.childCount,
        read: Math.max(1, Math.ceil(words / 220)),
      })
    }
    publish()
    const handler = () => {
      if (statsTimer.current) clearTimeout(statsTimer.current)
      statsTimer.current = setTimeout(publish, 250)
    }
    editor.on('update', handler)
    return () => {
      editor.off('update', handler)
      if (statsTimer.current) clearTimeout(statsTimer.current)
    }
  }, [editor])

  useEffect(() => {
    if (editor) onReadyRef.current?.(editor)
  }, [editor])

  // Keep the spellcheck preference in sync with the live DOM node.
  const setSpellcheck = useCallback(
    (enabled) => {
      const dom = editor?.view?.dom
      if (dom) dom.setAttribute('spellcheck', enabled ? 'true' : 'false')
    },
    [editor],
  )

  return { editor, ydoc, ready, setSpellcheck }
}
