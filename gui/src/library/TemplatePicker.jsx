/**
 * The template picker shown before a new document exists.
 *
 * It is a dialog rather than a second row of tiles because the choice is a
 * one-time decision that changes what opens in the editor. Each option is
 * drawn as the sheet it produces -- a title, a rule and the sections the
 * template starts with -- because a template is a page, not a label with an
 * icon beside it.
 */

import React from 'react'
import { ModalLayer } from '../ModalLayer.jsx'
import { Icon } from '../Icon.jsx'
import { DOCUMENT_TEMPLATES, templateSections, templateTitle } from './templates.js'

function TemplatePaper({ template }) {
  const sections = templateSections(template)
  return (
    <span
      className="template-paper"
      style={{ '--template-color': template.color }}
      aria-hidden="true"
    >
      <span className="template-paper-band" />
      <span className="template-paper-kicker">{template.eyebrow}</span>
      <span className="template-paper-title">{templateTitle(template)}</span>
      <span className="template-paper-rule" />
      <span className="template-paper-body">
        {sections.map((section, index) => (
          <span className="template-paper-section" key={`${section}-${index}`}>
            <span className="template-paper-heading">{section}</span>
            <span className="template-paper-line" data-long={index % 3 === 0 ? '' : undefined} />
            <span className="template-paper-line" data-short={index % 2 === 0 ? '' : undefined} />
          </span>
        ))}
      </span>
      <span className="template-paper-foot">
        {template.id === 'blank' ? (
          <>
            <Icon name="plus" size={11} /> Start writing
          </>
        ) : (
          template.kind
        )}
      </span>
    </span>
  )
}

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
              aria-label={`${template.name}: ${template.description}`}
              onClick={() => onPick(template.id)}
            >
              <TemplatePaper template={template} />
              <span className="template-card-copy">
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
