import React, { useEffect, useRef, useState } from 'react'

/**
 * A document menu bar, close to the one a word processor trained everyone on.
 *
 * The format toolbar already owns the controls used while typing. This bar is
 * for the actions that belong to the document rather than the caret: open,
 * export, move, clean up, comments, versions. Each menu is a real button with
 * `aria-expanded` and a role="menu" popover, so keyboard and screen-reader
 * behaviour is the same as the visual one.
 */
export function EditorMenuBar({
  mode,
  onMode,
  onNew,
  onOpen,
  onExport,
  onDelete,
  onBack,
  onShare,
  onHistory,
  onComments,
  onVerify,
  onDetails,
  onSettings,
  onCleanup,
  onInsertImage,
  onInsertMath,
  onComplete,
  onAcceptSuggestions,
  onRejectSuggestions,
  runCommand,
}) {
  const [open, setOpen] = useState('')
  const barRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (barRef.current && !barRef.current.contains(event.target)) setOpen('')
    }
    const key = (event) => { if (event.key === 'Escape') setOpen('') }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const item = (label, action, hint = '') => ({
    label,
    hint,
    action: () => { setOpen(''); action?.() },
  })
  const separator = { separator: true }

  const menus = [
    {
      id: 'file',
      label: 'File',
      items: [
        item('New document', onNew),
        item('Open file…', onOpen),
        separator,
        item('Export…', onExport),
        item('Document details…', onDetails),
        item('Share…', onShare),
        separator,
        item('Move to Trash', onDelete),
        item('Back to library', onBack),
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        item('Undo', () => runCommand?.('undo'), '⌘Z'),
        item('Redo', () => runCommand?.('redo'), '⇧⌘Z'),
        separator,
        item('Select all', () => runCommand?.('selectAll'), '⌘A'),
        separator,
        item('Comments…', onComments),
        item('Version history…', onHistory),
      ],
    },
    {
      id: 'insert',
      label: 'Insert',
      items: [
        item('Image…', onInsertImage),
        item('Formula…', onInsertMath),
        item('Table', () => runCommand?.('insertTable', { rows: 3, cols: 3, withHeaderRow: true })),
        item('Horizontal rule', () => runCommand?.('setHorizontalRule')),
      ],
    },
    {
      id: 'format',
      label: 'Format',
      items: [
        item('Heading 1', () => runCommand?.('toggleHeading', { level: 1 })),
        item('Heading 2', () => runCommand?.('toggleHeading', { level: 2 })),
        item('Heading 3', () => runCommand?.('toggleHeading', { level: 3 })),
        separator,
        item('Bulleted list', () => runCommand?.('toggleBulletList')),
        item('Numbered list', () => runCommand?.('toggleOrderedList')),
        item('Quote', () => runCommand?.('toggleBlockquote')),
        separator,
        item('Bold', () => runCommand?.('toggleBold'), '⌘B'),
        item('Italic', () => runCommand?.('toggleItalic'), '⌘I'),
        item('Underline', () => runCommand?.('toggleUnderline'), '⌘U'),
        item('Strike', () => runCommand?.('toggleStrike')),
        separator,
        item('Clear formatting', () => runCommand?.('unsetAllMarks')),
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      items: [
        item('Suggest a completion', onComplete, '⌘Space'),
        item('Comments…', onComments),
        item('Version history…', onHistory),
        separator,
        item('Verify citations & plagiarism…', onVerify),
        item('Clean up formatting', onCleanup),
        item('Accept all suggestions', onAcceptSuggestions),
        item('Reject all suggestions', onRejectSuggestions),
        separator,
        item('Settings…', onSettings),
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        item('Editing mode', () => onMode?.('editing')),
        item('Suggesting mode', () => onMode?.('suggesting')),
        item('Viewing mode', () => onMode?.('viewing')),
      ],
    },
  ]

  return (
    <div className="editor-menubar" ref={barRef} role="menubar" aria-label="Document menus">
      <div className="editor-menubar-list">
        {menus.map((menu) => (
          <div className="editor-menu" key={menu.id}>
            <button
              type="button"
              className={`editor-menu-trigger${open === menu.id ? ' is-open' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === menu.id}
              onClick={() => setOpen((value) => (value === menu.id ? '' : menu.id))}
            >
              {menu.label}
            </button>
            {open === menu.id && (
              <div className="editor-menu-popover" role="menu" aria-label={menu.label}>
                {menu.items.map((entry, index) => entry.separator ? (
                  <span className="editor-menu-sep" key={`sep-${index}`} role="separator" />
                ) : (
                  <button
                    key={entry.label}
                    type="button"
                    role="menuitem"
                    className="editor-menu-item"
                    onClick={entry.action}
                  >
                    <span>{entry.label}</span>
                    {entry.hint && <kbd>{entry.hint}</kbd>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="editor-mode-switch" role="group" aria-label="Editing mode">
        {['editing', 'suggesting', 'viewing'].map((value) => (
          <button
            key={value}
            type="button"
            className={mode === value ? 'active' : ''}
            aria-pressed={mode === value}
            onClick={() => onMode?.(value)}
          >
            {value === 'editing' ? 'Editing' : value === 'suggesting' ? 'Suggesting' : 'Viewing'}
          </button>
        ))}
      </div>
    </div>
  )
}
