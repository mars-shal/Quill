/**
 * The template picker shown before a new document exists.
 *
 * It is a dialog rather than a second row of tiles because the choice is a
 * one-time decision that changes what opens in the editor. The grid keeps the
 * six templates visible at once, and the footer repeats that every option can
 * be edited or renamed afterwards.
 */

import React from 'react'
import { ModalLayer } from '../ModalLayer.jsx'
import { Icon } from '../Icon.jsx'
import { DOCUMENT_TEMPLATES } from './templates.js'

export function TemplatePicker({ onClose, onPick }) {
  return (
    <ModalLayer onClose={onClose}>
      <section
        className="dialog template-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-title"
      >
        <header className="dialog-head">
          <div>
            <div className="eyebrow">Start something</div>
            <h2 id="template-title">Choose a template</h2>
          </div>
          <button
            className="dialog-close"
            type="button"
            aria-label="Close template picker"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="template-grid">
          {DOCUMENT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              className={`template-card${template.id === 'blank' ? ' template-card--blank' : ''}`}
              type="button"
              onClick={() => onPick(template.id)}
            >
              <span className="template-card-icon" aria-hidden="true">
                <Icon name={template.icon} size={18} />
              </span>
              <span className="template-card-copy">
                <span className="template-card-eyebrow">{template.eyebrow}</span>
                <strong>{template.name}</strong>
                <small>{template.description}</small>
              </span>
            </button>
          ))}
        </div>
        <footer className="template-dialog-foot">
          <p>Every template is a normal document. Rename it, change its labels or delete the sections you do not need.</p>
          <button className="soft-button" type="button" onClick={onClose}>Cancel</button>
        </footer>
      </section>
    </ModalLayer>
  )
}
