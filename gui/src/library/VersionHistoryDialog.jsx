import React, { useEffect, useState } from 'react'
import { ModalLayer } from '../ModalLayer.jsx'
import { Icon } from '../Icon.jsx'
import { listVersions, recordVersion, versionTime } from './versionHistory.js'

/**
 * The local version browser.
 *
 * List on the left, preview on the right, and one explicit restore. The preview
 * is text, not rendered HTML: restored content is the document owner's, but a
 * preview should never execute anything just to show what a save looked like.
 */
export function VersionHistoryDialog({ docId, onClose, onRestore, getCurrent }) {
  const [versions, setVersions] = useState(() => listVersions(docId))
  const [selected, setSelected] = useState(() => versions[0]?.id || '')

  useEffect(() => {
    setVersions(listVersions(docId))
    setSelected(listVersions(docId)[0]?.id || '')
  }, [docId])

  const current = versions.find((version) => version.id === selected) || versions[0]

  const saveNow = () => {
    const html = typeof getCurrent === 'function' ? getCurrent() : ''
    const next = recordVersion(docId, html, { force: true })
    setVersions(next)
    setSelected(next[0]?.id || '')
  }

  return (
    <ModalLayer onClose={onClose}>
      <section className="dialog version-dialog" role="dialog" aria-modal="true" aria-labelledby="version-title">
        <header className="dialog-head">
          <div>
            <div className="eyebrow">Local history</div>
            <h2 id="version-title">Version history</h2>
          </div>
          <button className="dialog-close" type="button" aria-label="Close version history" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="version-body">
          <div className="version-list" role="listbox" aria-label="Saved versions">
            <button className="version-save" type="button" onClick={saveNow}>
              <Icon name="plus" size={13} />
              Save a version now
            </button>
            {versions.length === 0 ? (
              <p className="version-empty">No versions yet. Quill saves one as you write.</p>
            ) : versions.map((version) => (
              <button
                key={version.id}
                type="button"
                role="option"
                aria-selected={version.id === current?.id}
                className={`version-item${version.id === current?.id ? ' is-active' : ''}`}
                onClick={() => setSelected(version.id)}
              >
                <strong>{versionTime(version.at)}</strong>
                <small>{version.words.toLocaleString()} words</small>
              </button>
            ))}
          </div>
          <div className="version-preview">
            {current ? (
              <>
                <div className="version-preview-meta">
                  <span>{versionTime(current.at)}</span>
                  <span>{current.words.toLocaleString()} words</span>
                </div>
                <p>{current.excerpt || 'This version was empty.'}…</p>
                <button className="soft-button primary" type="button" onClick={() => onRestore?.(current.html)}>
                  Restore this version
                </button>
              </>
            ) : (
              <p className="version-empty">Save a version to see a preview here.</p>
            )}
          </div>
        </div>
        <p className="version-note">
          Versions stay on this machine. Chat transcripts are not part of a version.
        </p>
      </section>
    </ModalLayer>
  )
}
