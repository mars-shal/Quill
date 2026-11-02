/**
 * The document editor surface.
 *
 * This module is deliberately *not* code-split, and an earlier version of this
 * comment claimed it was. The claim never matched the build: `main.jsx` imported
 * this module statically, and the ProseMirror weight that would have justified a
 * split enters through `useCollaborativeDocument.js` instead, so a dynamic
 * import here would have split almost nothing.
 *
 * The weight is also not on the critical path in a way splitting would fix. The
 * editor layer stays mounted for the whole session -- it is what lets the
 * library cross-fade in front of a warm editor -- so the module is needed as soon
 * as the app is. And a Tauri build reads its bundle from local disk inside the
 * binary, so there is no network waterfall to shorten: a second chunk would add a
 * file read and a scheduling hop for a few hundred kilobytes that the OS has
 * already cached.
 *
 * First paint therefore still waits on ProseMirror. If that ever needs to change,
 * the split has to start at `useCollaborativeDocument` and at the editor layer's
 * mount-on-open behaviour, not here.
 */

import { EditorContent } from '@tiptap/react'

export function DocumentEditor({ editor, ready, className = '' }) {
  if (!ready) {
    return (
      <div className={`editor-canvas-loading ${className}`} aria-busy="true">
        Loading document…
      </div>
    )
  }

  return (
    <div className={`editor-surface ${className}`}>
      <EditorContent editor={editor} className="document-prose-host" />
    </div>
  )
}

export default DocumentEditor
