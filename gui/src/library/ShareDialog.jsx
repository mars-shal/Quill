import React, { useState } from 'react'
import { ModalLayer } from '../ModalLayer.jsx'
import { Icon } from '../Icon.jsx'

/**
 * Sharing for a local-first document.
 *
 * There is no public URL to hand out, so the honest options are to copy the
 * content in a useful format or export a file. Saying that plainly is better
 * than a disabled "Invite people" control that implies a service Quill does not
 * run.
 */
export function ShareDialog({ title, onClose, onExport, getMarkdown, getText }) {
  const [copied, setCopied] = useState('')

  const copy = async (label, value) => {
    try {
      await navigator.clipboard?.writeText(value || '')
      setCopied(label)
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      setCopied('')
    }
  }

  const actions = [
    {
      id: 'markdown',
      label: 'Copy as Markdown',
      note: 'Keeps headings, lists, tables and LaTeX.',
      run: () => copy('markdown', getMarkdown?.() || ''),
    },
    {
      id: 'text',
      label: 'Copy plain text',
      note: 'Just the words, ready to paste anywhere.',
      run: () => copy('text', getText?.() || ''),
    },
  ]

  return (
    <ModalLayer onClose={onClose}>
      <section className="dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header className="dialog-head">
          <div>
            <div className="eyebrow">Share</div>
            <h2 id="share-title">“{title || 'Untitled document'}”</h2>
          </div>
          <button className="dialog-close" type="button" aria-label="Close share dialog" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="share-body">
          <p className="share-note">
            Quill is local-first, so this document has no public link. Copy it or export a file to send it.
          </p>
          {actions.map((action) => (
            <button className="share-action" type="button" key={action.id} onClick={action.run}>
              <span>
                <strong>{action.label}</strong>
                <small>{action.note}</small>
              </span>
              <span className="share-action-state">{copied === action.id ? 'Copied' : 'Copy'}</span>
            </button>
          ))}
          <button className="share-action" type="button" onClick={onExport}>
            <span>
              <strong>Export a file…</strong>
              <small>PDF, DOCX, Markdown, HTML or plain text.</small>
            </span>
            <span className="share-action-state">Export</span>
          </button>
        </div>
      </section>
    </ModalLayer>
  )
}
