/**
 * The library screen: the document grid, its filters, and the sidebar beside it.
 *
 * Extracted verbatim from `main.jsx`. Memoised for the reason in the comment
 * above the component: the stats tick after a keystroke rewrites `stats` in
 * `App`, and without the memo that re-rendered this whole tree -- including a
 * word-count regex over every document's HTML -- for tiles sitting behind the
 * library at `opacity: 0`.
 *
 * Two notes on what did *not* come with it:
 *
 *  - `normalizeDoc` stayed behind. It was a one-line delegation to
 *    `store.normalizeDoc`, and `App` is its only caller, so the wrapper bought
 *    nothing. Same treatment as `slugify`.
 *
 *  - `countWords` came along, because the grid is its only reader. It is not
 *    `store.countWords`: that one counts the plain-text body, and this one counts
 *    a document's HTML with the tags stripped out, so the two can disagree and
 *    the grid is showing the stripped number.
 */

import React, { memo, useEffect, useMemo, useState } from 'react'
import { Icon } from '../Icon.jsx'
import { coverStyle, coverTreatment } from './cover.js'
import { AsciiRevealSafe } from './ui/AsciiRevealSafe.jsx'
import { AsciiSkeleton } from 'ascii-reveal'
import { EmptyState } from './ui/EmptyState.jsx'
import { TemplatePicker } from './TemplatePicker.jsx'

/** Labels the app shipped with, kept even when no document currently uses one. */
const DEFAULT_LABELS = ['Essays', 'Chapters', 'Notes']

const STATUS_ITEMS = [
  { label: 'Drafts', value: 'Drafts', type: 'status', icon: 'draft' },
  { label: 'Revising', value: 'Revising', type: 'status', icon: 'revise' },
  { label: 'Published', value: 'Published', type: 'status', icon: 'published' },
]

function AssistantPortrait({ size = 24 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="9.5" r="3.25"/><path d="M6.8 19.5c.55-2.65 2.35-4.1 5.2-4.1s4.65 1.45 5.2 4.1"/><path d="M9.5 9.5h.01M14.5 9.5h.01"/><path d="M4.5 5.5 3 4M19.5 5.5 21 4"/></svg>
}

function countWords(value) {
  const text = String(value || '').trim()
  return text ? text.split(/\s+/).length : 0
}

/** The tag-stripped body, for the search field. */
function plainText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ')
}

/**
 * The library screen.
 *
 * Memoised because the 250ms stats tick after a keystroke rewrites `stats` in
 * `App`, and every App state write re-rendered this whole tree -- including the
 * word count regex over every document's HTML and a `docs.filter` per sidebar
 * item, for tiles that were behind the library at `opacity: 0`. The props are
 * all referentially stable in `App` for that to be worth anything.
 */
const Library = memo(function Library({
  docs,
  trashed = [],
  filter,
  onFilter,
  onOpenDoc,
  onNew,
  onImport,
  onRestore,
  onRestoreMany,
  onDeleteMany,
  onPurgeMany,
  onPurge,
  onSettings,
  onDetails,
  onDownload,
  onDelete,
  sortAscending,
  onSort,
  viewMode,
  onView,
  density,
  onDensity,
  loading = false,
}) {
  const [query, setQuery] = useState('')
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const isTrash = filter.type === 'trash'
  const sourceDocs = isTrash ? trashed : docs

  useEffect(() => {
    setSelecting(false)
    setSelected(new Set())
  }, [filter.type, filter.value])

  const toggleSelect = (id) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const selectAll = () => setSelected(new Set(filteredDocs.map((doc) => doc.id)))
  const cancelSelect = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  const runBulk = (action, confirmText = '') => {
    if (!selected.size || typeof action !== 'function') return
    if (confirmText && typeof window !== 'undefined' && !window.confirm(confirmText)) return
    action([...selected])
    cancelSelect()
  }

  const labels = useMemo(() => {
    const found = new Set(DEFAULT_LABELS)
    for (const doc of docs) {
      for (const label of doc.collections || []) found.add(label)
    }
    return [...found].sort((a, b) => a.localeCompare(b))
  }, [docs])

  const navGroups = useMemo(() => [
    {
      label: 'Library',
      items: [
        { label: 'Home', value: 'home', type: 'home', icon: 'home' },
        { label: 'All documents', value: 'all', type: 'all', icon: 'layers' },
        { label: 'Trash', value: 'trash', type: 'trash', icon: 'trash' },
      ],
    },
    { label: 'Status', items: STATUS_ITEMS },
    {
      label: 'Labels',
      items: labels.map((label) => ({ label, value: label, type: 'collection', icon: 'tag' })),
    },
  ], [labels])

  const filteredDocs = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const next = sourceDocs.filter((doc) => {
      if (filter.type === 'collection') return doc.collections.includes(filter.value)
      if (filter.type === 'status') return doc.status === filter.value
      return true
    }).filter((doc) => {
      if (!needle) return true
      return `${doc.title} ${doc.kind} ${doc.collections.join(' ')} ${plainText(doc.content)}`.toLowerCase().includes(needle)
    })
    return sortAscending ? [...next].reverse() : next
  }, [sourceDocs, filter, sortAscending, query])

  // Right-click replaces the three floating tile buttons (details, download,
  // delete): one menu, one place, no chrome parked over every cover.
  //
  // The tile takes focus when the menu opens and the items refuse it on
  // mousedown, so closing -- including a dialog opened from the menu -- lands
  // focus back on the tile rather than on <body>.
  const [contextMenu, setContextMenu] = useState(null)
  const closeContextMenu = () => setContextMenu(null)
  const openContextMenu = (event, doc) => {
    event.preventDefault()
    event.currentTarget.focus()
    setContextMenu({
      id: doc.id,
      title: doc.title,
      tile: event.currentTarget,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 196)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 176)),
    })
  }
  useEffect(() => {
    if (!contextMenu) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [contextMenu])

  // One pass over the documents per change, keyed by the nav labels, instead of
  // a `docs.filter` per sidebar item per render.
  const navCounts = useMemo(() => {
    const counts = new Map()
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.type === 'home' || item.type === 'all') counts.set(item.label, docs.length)
        else if (item.type === 'trash') counts.set(item.label, trashed.length)
        else if (item.type === 'collection') {
          counts.set(item.label, docs.filter((doc) => doc.collections.includes(item.value)).length)
        } else counts.set(item.label, docs.filter((doc) => doc.status === item.value).length)
      }
    }
    return counts
  }, [docs, trashed, navGroups])

  // The same reasoning for the per-tile word counts and the per-tile cover: a
  // regex strip plus a whitespace split over each document's whole HTML, and a
  // hash over its id, on every render.
  //
  // The tile preview is folded in here rather than given a pass of its own. Both
  // need the tag-stripped plain text, and this is the screen's most expensive
  // operation by its own admission above -- a second regex over the same HTML
  // would make a cost this file already flags double for one tile's sake. The
  // cover treatment rides along for the same reason: it is per-document work
  // that returns the same three values on every render.
  const tiles = useMemo(() => {
    const entries = []
    for (const doc of filteredDocs) {
      const plain = doc.content.replace(/<[^>]+>/g, ' ')
      entries.push({ id: doc.id, words: countWords(plain), cover: coverTreatment(doc.id) })
    }
    return new Map(entries.map((entry) => [entry.id, entry]))
  }, [filteredDocs])

  const title = filter.type === 'home'
    ? 'Home'
    : filter.type === 'all'
      ? 'All documents'
      : filter.type === 'trash'
        ? 'Trash'
        : filter.value
  const countLabel = `${filteredDocs.length} ${filteredDocs.length === 1 ? 'document' : 'documents'}`
  const subtitle = loading
    ? 'Opening the shelf…'
    : query.trim()
      ? `${countLabel} matching “${query.trim()}”.`
      : isTrash
        ? 'Deleted documents wait here. Open one, or restore it from its menu.'
        : filter.type === 'home'
          ? 'Your books, labels and the work still in progress.'
          : filter.type === 'all'
            ? 'A quiet place for the things worth keeping.'
            : `${countLabel} in ${filter.value.toLowerCase()}.`
  const startNew = () => setTemplatesOpen(true)

  return <section className="library-page" aria-label="Quill library">
    <div className="library-backdrop" aria-hidden="true" />
    <div className="library-layout">
      <aside className="library-sidebar">
        <div className="library-brand-row"><img className="library-wordmark" src="/quill-brand.png" width="1680" height="759" alt="Quill" /></div>
        <div className="sidebar-search" role="search">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={query}
            aria-label="Search library"
            placeholder="Search library"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
        <nav className="library-nav" aria-label="Library filters">
          {navGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-group-label">{group.label}</div><div className="nav-list">{group.items.map((item) => { const active = filter.type === item.type && filter.value === item.value; return <button key={item.label} className={`nav-item${active ? ' active' : ''}${item.type === 'trash' ? ' nav-item--trash' : ''}`} type="button" aria-pressed={active} onClick={() => onFilter(item.type, item.value)}><Icon name={item.icon} size={15} /><span>{item.label}</span><span className="nav-count">{navCounts.get(item.label) ?? 0}</span></button> })}</div></div>)}
        </nav>
        <div className="sidebar-footer">
          <button className="soft-button sidebar-import" type="button" aria-label="Open a PDF, Word, Markdown, text or HTML file" title="Open PDF, DOCX, Markdown, text or HTML" onClick={onImport}><Icon name="upload" size={14} /><span>Open file</span></button>
          <button className="soft-button sidebar-settings" type="button" onClick={onSettings}><Icon name="settings" size={14} /><span>Settings</span></button>
        </div>
      </aside>
      <main className="library-main">
        <header className="library-main-head"><div><div className="eyebrow">Workspace / Personal</div><h1>{title}</h1><p>{subtitle}</p></div><div className="library-main-tools"><button className="soft-button" type="button" aria-label="Open a PDF, Word, Markdown, text or HTML file" title="Open PDF, DOCX, Markdown, text or HTML" onClick={onImport}><Icon name="upload" size={14} /><span>Open file</span></button><button className="soft-button" type="button" onClick={onSort}><Icon name="sort" size={14} /><span>{sortAscending ? 'Oldest' : 'Recent'}</span></button><button className="soft-button settings-fallback" type="button" onClick={onSettings}><Icon name="settings" size={14} /><span>Settings</span></button><button className="soft-button primary" type="button" onClick={startNew}><Icon name="plus" size={14} /><span>New document</span></button></div></header>
        <div className="library-toolbar">
          {selecting ? (
            <div className="library-selection" role="toolbar" aria-label="Selected documents">
              <strong>{selected.size} selected</strong>
              <button type="button" onClick={selectAll}>Select all</button>
              {isTrash ? (
                <>
                  <button type="button" disabled={!selected.size} onClick={() => runBulk(onRestoreMany)}>Restore</button>
                  <button className="danger" type="button" disabled={!selected.size} onClick={() => runBulk(onPurgeMany, `Delete ${selected.size} document${selected.size === 1 ? '' : 's'} forever?`)}>Delete forever</button>
                </>
              ) : (
                <button className="danger" type="button" disabled={!selected.size} onClick={() => runBulk(onDeleteMany, `Move ${selected.size} document${selected.size === 1 ? '' : 's'} to Trash?`)}>Move to Trash</button>
              )}
              <button type="button" onClick={cancelSelect}>Cancel</button>
            </div>
          ) : (
            <span className="library-count">{loading ? 'Loading library…' : countLabel}</span>
          )}
          <div className="library-controls">
            {!selecting && (
              <button className="soft-button select-button" type="button" onClick={() => setSelecting(true)} disabled={loading || !filteredDocs.length}>
                <Icon name="check" size={14} /><span>Select</span>
              </button>
            )}
            <div className="view-toggle" role="group" aria-label="Library view"><button className={viewMode === 'grid' ? 'active' : ''} type="button" aria-label="Grid view" aria-pressed={viewMode === 'grid'} onClick={() => onView('grid')}><Icon name="grid" size={14} /></button><button className={viewMode === 'list' ? 'active' : ''} type="button" aria-label="List view" aria-pressed={viewMode === 'list'} onClick={() => onView('list')}><Icon name="list" size={14} /></button></div><div className="density-toggle" role="group" aria-label="Grid density"><button className={density === 'comfortable' ? 'active' : ''} type="button" data-density="comfortable" aria-pressed={density === 'comfortable'} onClick={() => onDensity('comfortable')}>Comfortable</button><button className={density === 'compact' ? 'active' : ''} type="button" data-density="compact" aria-pressed={density === 'compact'} onClick={() => onDensity('compact')}>Compact</button></div>
          </div>
        </div>
        {/* Keyed on the view and density. React remounts the grid when the key
            changes, which is what replays the tile entrance -- so returning from a
            document fades the books back in rather than showing them already
            standing there. */}
        <AsciiRevealSafe key={`${viewMode}:${density}:${isTrash ? 'trash' : 'library'}`} as="div" className={`library-grid ${viewMode === 'list' ? 'list-view' : ''} ${density === 'compact' ? 'compact' : ''}${loading ? ' library-loading' : ''}`} aria-live="polite" aria-busy={loading} preset="dither" duration="fast" origin="top-left" lazy={false} loading={loading} revealOnMount={!loading}>
          {/* Plain elements, no framer-motion. Every tile used to carry its own
              spring -- an `initial`/`animate` pair on mount, a `whileHover` lift,
              a `whileTap` press, and an `exit` -- and a fifteen-tile library meant
              fifteen rAF-driven animations competing with the layer fade for the
              same frame budget. Hover lift and press are transitions in the
              stylesheet; the entrance is a CSS keyframe; and the `key` below is
              what makes the entrance replay when the view changes, because
              changing it remounts the grid. */}
          {/* The cover prints the title as well as carrying the label's colour,
              which is what makes it a book rather than a swatch -- see the rules
              at `.document-cover`. It is `aria-hidden` because the tile is a
              `role="button"` already named `Open <title>` by its `aria-label`, so
              the same string printed twice would be read twice if the button's
              descendants were ever exposed. The `<span>` is deliberately not a
              `<strong>`: `.tile-copy strong` is how the tests find a tile by its
              title, and a second strong inside the cover would make that query
              depend on DOM order for no reason. */}
          {/* Loading is a shelf of ASCII skeletons; empty is a designed state
              with its own next action. They are different facts and now look
              different: a filter with nothing in it used to show two permanent
              "Loading…" tiles, which promised a library that was never coming.
              The skeleton is only rendered while the platform store is opening. */}
          {loading ? (
            Array.from({ length: 4 }, (_, index) => (
              <div className="document-tile loading-tile" key={`loading-${index}`} aria-hidden="true">
                <div className="book-skeleton" data-ascii-skeleton>
                  <AsciiSkeleton as="div" variant="dither" rows={7} width="100%" height="100%" animate={false} seed={index} />
                </div>
                <div className="tile-copy"><span className="skeleton-line" /></div>
              </div>
            ))
          ) : filteredDocs.length === 0 ? (
            <EmptyState
              className="library-empty"
              title={isTrash ? 'Trash is empty' : docs.length === 0 ? 'Your library is empty' : query.trim() ? 'No matches' : 'Nothing here yet'}
              copy={isTrash
                ? 'Documents you delete appear here until you restore them.'
                : docs.length === 0
                  ? 'Create a document from a template, or open a PDF, Word, Markdown or text file from another folder.'
                  : query.trim()
                    ? `Nothing in this view matches “${query.trim()}”.`
                    : `No documents in ${filter.value.toLowerCase()}. Try another label, or start something new.`}
            >
              {!isTrash && (
                <button className="soft-button primary" type="button" onClick={startNew}>
                  <Icon name="plus" size={14} /><span>New document</span>
                </button>
              )}
              {!isTrash && (
                <button className="soft-button" type="button" onClick={onImport}>
                  <Icon name="upload" size={14} /><span>Open file</span>
                </button>
              )}
              {query.trim() && (
                <button className="soft-button" type="button" onClick={() => setQuery('')}>Clear search</button>
              )}
              {!isTrash && docs.length > 0 && filter.type !== 'all' && !query.trim() && (
                <button className="soft-button" type="button" onClick={() => onFilter('all', 'all')}>
                  Show all documents
                </button>
              )}
            </EmptyState>
          ) : (
            filteredDocs.map((doc) => {
              const tile = tiles.get(doc.id)
              const cover = tile.cover
              const isSelected = selected.has(doc.id)
              const open = () => {
                if (selecting) {
                  toggleSelect(doc.id)
                  return
                }
                if (isTrash) onRestore?.(doc.id)
                else onOpenDoc(doc.id)
              }
              const label = selecting
                ? `${isSelected ? 'Deselect' : 'Select'} ${doc.title}`
                : isTrash ? `Restore ${doc.title}` : `Open ${doc.title}`
              return <article key={doc.id} className={`document-tile ${viewMode === 'list' ? 'list-tile' : ''}${isTrash ? ' trashed-tile' : ''}${selecting ? ' select-mode' : ''}${isSelected ? ' is-selected' : ''}`} tabIndex="0" role="button" aria-label={label} aria-pressed={selecting ? isSelected : undefined} onClick={open} onContextMenu={(event) => { if (selecting) { event.preventDefault(); return } openContextMenu(event, doc) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }}>{selecting && <span className={`select-check${isSelected ? ' is-on' : ''}`} aria-hidden="true"><Icon name="check" size={13} /></span>}<div className={`document-cover ${cover.layout}`} style={coverStyle(cover)} data-ascii="surface" aria-hidden="true"><span className="cover-ribbon" /><span className="cover-title">{doc.title}</span><span className="cover-edition">{doc.kind}</span></div><div className="tile-copy"><strong>{doc.title}</strong><span>{isTrash ? `Deleted · ${doc.kind}` : `${doc.kind} · ${tile?.words ?? 0} words`}</span></div></article>
            })
          )}
          {!loading && !isTrash && !selecting && (
            <article key="new-document" className={`document-tile new-document-tile ${viewMode === 'list' ? 'list-tile' : ''}`} tabIndex="0" role="button" aria-label="Create a new document from a template" onClick={startNew} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startNew() } }}><div className="new-cover" data-ascii="surface"><Icon name="plus" size={22} /></div></article>
          )}
        </AsciiRevealSafe>
      </main>
    </div>
    {templatesOpen && (
      <TemplatePicker
        onClose={() => setTemplatesOpen(false)}
        onPick={(templateId) => {
          setTemplatesOpen(false)
          onNew(templateId)
        }}
      />
    )}
    {contextMenu && (
      <>
        <div
          className="context-scrim"
          onClick={closeContextMenu}
          onContextMenu={(event) => { event.preventDefault(); closeContextMenu() }}
        />
        <div className="tile-context" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {/* mousedown is refused so focus never leaves the tile: a dialog
              opened from here restores focus to the tile on Escape, which is
              the trigger the reader actually used. */}
          {isTrash ? (
            <>
              <button
                type="button"
                role="menuitem"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const { id, tile } = contextMenu
                  closeContextMenu()
                  tile?.focus()
                  onRestore?.(id)
                }}
              >
                Restore
              </button>
              {onPurge && (
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const { id, title, tile } = contextMenu
                    closeContextMenu()
                    tile?.focus()
                    if (typeof window !== 'undefined' && window.confirm?.(`Delete "${title}" forever?`)) onPurge(id)
                  }}
                >
                  Delete forever
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { const { id, tile } = contextMenu; closeContextMenu(); tile?.focus(); onOpenDoc(id) }}>Open</button>
              <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { const { id, tile } = contextMenu; closeContextMenu(); tile?.focus(); onDetails(id) }}>Details</button>
              <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { const { id, tile } = contextMenu; closeContextMenu(); tile?.focus(); onDownload(id) }}>Download</button>
              {onDelete && (
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const { id, title, tile } = contextMenu
                    closeContextMenu()
                    tile?.focus()
                    if (typeof window !== 'undefined' && window.confirm?.(`Move "${title}" to Trash?`)) onDelete(id)
                  }}
                >
                  Move to Trash
                </button>
              )}
            </>
          )}
        </div>
      </>
    )}
  </section>
})


/**
 * The document title, editable in place.
 *
 * This was a `contentEditable` heading that wrote to the store on every
 * keystroke. React owns that element's children, so each write re-rendered the
 * tree and reset the text under the caret, which made the field feel dead. It
 * also gave a heading no accessible way to be edited, and spelt every title.
 *
 * Now the title is a button that opens a real input: one write on commit, no
 * caret fighting, and Enter/Escape behave the way a form field should.
 */

export { Library }
