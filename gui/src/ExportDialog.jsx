/**
 * Export dialog.
 *
 * Replaces the placeholder Publish action. The user picks a format, chooses a
 * destination with the native save dialog, and Quill renders and writes the file
 * atomically in the Rust core.
 *
 * Markdown is serialised here on the frontend; every other format is built by
 * Rust from the ProseMirror JSON. Anything the target format cannot represent
 * is reported back to the user rather than silently dropped.
 */

import { useCallback, useEffect, useState } from 'react'
import * as store from './platform/store.js'
import { ModalLayer } from './ModalLayer.jsx'
import { Dialog } from './library/ui/dialog.jsx'
import { RadioGroup, RadioGroupItem } from './library/ui/radio-group.jsx'
import { Icon } from './Icon.jsx'
import { Button } from './library/ui/button.jsx'

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ExportDialog({ document: doc, getPayload, author, onClose }) {
  const formats = store.exportFormats()
  const [format, setFormat] = useState(formats[0].format)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const selected = formats.find((f) => f.format === format) ?? formats[0]

  // Focus in, trap, Escape, and restore on close. The implementation moved to
  // platform/a11y.js so Details, Settings and the dialogs in Phases 3, 5 and 6
  // share it; it was only ever implemented here.

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const path = await store.pickExportPath({ title: doc.title, extension: selected.extension })
      if (!path) {
        setBusy(false)
        return
      }

      const payload = await getPayload(format)
      const outcome = await store.exportDocument({
        path,
        format,
        title: doc.title,
        author,
        document: payload.document,
        markdown: payload.markdown,
      })
      setResult(outcome)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [author, doc.title, format, getPayload, selected.extension])

  return (
    <ModalLayer onClose={onClose}>
      <Dialog.Content
        className="dialog export-dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <header className="dialog-head">
          <div>
            <div className="eyebrow">Export</div>
            <Dialog.Title>{doc.title}</Dialog.Title>
          </div>
          <button className="dialog-close" type="button" aria-label="Close export" onClick={onClose} disabled={busy}>
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="dialog-form">
          <div className="field-group">
            <div className="field-label" id="export-format-label">
              Format
            </div>
            <RadioGroup
              className="format-options"
              aria-labelledby="export-format-label"
              value={format}
              onValueChange={setFormat}
              disabled={busy}
            >
              {formats.map((item) => (
                <RadioGroupItem
                  key={item.format}
                  indicator={false}
                  value={item.format}
                  className={`format-option${item.format === format ? ' active' : ''}`}
                  disabled={busy}
                >
                  <span className="format-option-name">{item.label}</span>
                  <span className="format-option-desc">{item.description}</span>
                  <span className="format-option-ext">.{item.extension}</span>
                </RadioGroupItem>
              ))}
            </RadioGroup>
          </div>

          {result && (
            <div className="export-result" role="status">
              <p className="export-result-head">
                <Icon name="check" size={14} /> Exported {formatBytes(result.bytes)}
              </p>
              <p className="export-result-path">{result.path}</p>
              {result.warnings.length > 0 && (
                <ul className="export-warnings">
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}

          <div className="dialog-actions">
            <Button className="soft-button" type="button" onClick={onClose} disabled={busy}>
              {result ? 'Close' : 'Cancel'}
            </Button>
            <Button className="soft-button primary" type="button" onClick={run} disabled={busy}>
              {busy ? 'Exporting…' : 'Choose location and export'}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </ModalLayer>
  )
}
