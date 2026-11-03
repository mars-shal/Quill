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
import { Button } from './ui/button.jsx'

const navGroups = [
  {
    label: 'Collections',
    items: [
      { label: 'All documents', value: 'all', type: 'all', icon: 'layers' },
      { label: 'Essays', value: 'Essays', type: 'collection', icon: 'file' },
      { label: 'Chapters', value: 'Chapters', type: 'collection', icon: 'file' },
      { label: 'Notes', value: 'Notes', type: 'collection', icon: 'file' },
    ],
  },
  {
    label: 'Status',
    items: [
      { label: 'Drafts', value: 'Drafts', type: 'status', icon: 'draft' },
      { label: 'Revising', value: 'Revising', type: 'status', icon: 'revise' },
      { label: 'Published', value: 'Published', type: 'status', icon: 'published' },
    ],
  },
]

function AssistantPortrait({ size = 24 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="9.5" r="3.25"/><path d="M6.8 19.5c.55-2.65 2.35-4.1 5.2-4.1s4.65 1.45 5.2 4.1"/><path d="M9.5 9.5h.01M14.5 9.5h.01"/><path d="M4.5 5.5 3 4M19.5 5.5 21 4"/></svg>
}

function countWords(value) {
  const text = String(value || '').trim()
  return text ? text.split(/\s+/).length : 0
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
const Library = memo(function Library({ docs, filter, onFilter, onOpenDoc, onNew, onSettings, onDetails, onDownload, onDelete, sortAscending, onSort, viewMode, onView, density, onDensity }) {
  const filteredDocs = useMemo(() => {
    const next = docs.filter((doc) => {
      if (filter.type === 'all') return true
      if (filter.type === 'collection') return doc.collections.includes(filter.value)
      return doc.status === filter.value
    })
    return sortAscending ? [...next].reverse() : next
  }, [docs, filter, sortAscending])

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
  // One pass over `docs` per change, keyed by the nav labels, instead of a
  // `docs.filter` per sidebar item per render.
  const navCounts = useMemo(() => {
    const counts = new Map()
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.type === 'all') counts.set(item.label, docs.length)
        else if (item.type === 'collection') {
          counts.set(item.label, docs.filter((doc) => doc.collections.includes(item.value)).length)
        } else counts.set(item.label, docs.filter((doc) => doc.status === item.value).length)
      }
    }
    return counts
  }, [docs])
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
  const title = filter.type === 'all' ? 'All documents' : filter.value
  const subtitle = filter.type === 'all' ? 'A quiet place for the things worth keeping.' : `${filteredDocs.length} ${filteredDocs.length === 1 ? 'document' : 'documents'} in ${filter.value.toLowerCase()}.`

  return <section className="library-page" aria-label="Quill library">
    <div className="library-backdrop" aria-hidden="true" />
    <div className="library-layout">
      <aside className="library-sidebar">
        <div className="library-brand-row"><img className="library-wordmark" src="/quill-brand.png" width="523" height="194" alt="Quill" /></div>
        <nav className="library-nav" aria-label="Library filters">
          {navGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-group-label">{group.label}</div><div className="nav-list">{group.items.map((item) => { const active = filter.type === item.type && filter.value === item.value; return <button key={item.label} className={`nav-item${active ? ' active' : ''}`} type="button" aria-pressed={active} onClick={() => onFilter(item.type, item.value)}><Icon name={item.icon} size={15} /><span>{item.label}</span><span className="nav-count">{navCounts.get(item.label) ?? 0}</span></button> })}</div></div>)}
        </nav>
        <Button className="soft-button sidebar-settings" type="button" onClick={onSettings}><Icon name="settings" size={14} /><span>Settings</span></Button>
      </aside>
      <main className="library-main">
        <header className="library-main-head"><div><div className="eyebrow">Workspace / Personal</div><h1>{title}</h1><p>{subtitle}</p></div><div className="library-main-tools"><Button className="soft-button" type="button" onClick={onSort}><Icon name="sort" size={14} /><span>{sortAscending ? 'Oldest' : 'Recent'}</span></Button><Button className="soft-button settings-fallback" type="button" onClick={onSettings}><Icon name="settings" size={14} /><span>Settings</span></Button><Button className="soft-button primary" type="button" onClick={onNew}><Icon name="plus" size={14} /><span>New document</span></Button></div></header>
        <div className="library-toolbar"><span className="library-count">{filteredDocs.length} {filteredDocs.length === 1 ? 'document' : 'documents'}</span><div className="library-controls"><div className="view-toggle" role="group" aria-label="Library view"><button className={viewMode === 'grid' ? 'active' : ''} type="button" aria-label="Grid view" aria-pressed={viewMode === 'grid'} onClick={() => onView('grid')}><Icon name="grid" size={14} /></button><button className={viewMode === 'list' ? 'active' : ''} type="button" aria-label="List view" aria-pressed={viewMode === 'list'} onClick={() => onView('list')}><Icon name="list" size={14} /></button></div><div className="density-toggle" role="group" aria-label="Grid density"><button className={density === 'comfortable' ? 'active' : ''} type="button" data-density="comfortable" aria-pressed={density === 'comfortable'} onClick={() => onDensity('comfortable')}>Comfortable</button><button className={density === 'compact' ? 'active' : ''} type="button" data-density="compact" aria-pressed={density === 'compact'} onClick={() => onDensity('compact')}>Compact</button></div></div></div>
        {/* Keyed on the view and density. React remounts the grid when the key
            changes, which is what replays the tile entrance -- so returning from a
            document fades the books back in rather than showing them already
            standing there. */}
        <div key={`${viewMode}:${density}`} className={`library-grid ${viewMode === 'list' ? 'list-view' : ''} ${density === 'compact' ? 'compact' : ''}`} aria-live="polite">
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
          {/* An empty filter says so.

              This branch used to render two skeleton tiles reading "Loading… /
              Preparing library" in the same voice as the boot screen. They never
              resolved, because the list was not loading -- it was genuinely
              empty -- so picking a collection with nothing in it left two fake
              books promising a library that was never coming, and no way out of
              the screen. The boot overlay already covers the first paint, so
              nothing here was ever the real loading state.

              The block is a plain element rather than a `.document-tile`: the
              grid's tiles are the documents, and an empty filter has none. */}
          {filteredDocs.length === 0 ? (
            <div className="library-empty">
              <p>No documents here yet.</p>
              <small>Pick another collection, or start something new.</small>
            </div>
          ) : (
            filteredDocs.map((doc) => { const tile = tiles.get(doc.id); const cover = tile.cover; return <article key={doc.id} className={`document-tile ${viewMode === 'list' ? 'list-tile' : ''}`} tabIndex="0" role="button" aria-label={`Open ${doc.title}`} onClick={() => onOpenDoc(doc.id)} onContextMenu={(event) => openContextMenu(event, doc)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenDoc(doc.id) } }}><div className={`document-cover ${cover.layout}`} style={coverStyle(cover)} aria-hidden="true"><span className="cover-ribbon" /><span className="cover-title">{doc.title}</span></div><div className="tile-copy"><strong>{doc.title}</strong><span>{doc.kind} · {tile?.words ?? 0} words</span></div></article> })
          )}
          <article key="new-document" className={`document-tile new-document-tile ${viewMode === 'list' ? 'list-tile' : ''}`} tabIndex="0" role="button" aria-label="Create a new document" onClick={onNew} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onNew() } }}><div className="new-cover"><Icon name="plus" size={18} /><span>New document</span></div><div className="tile-copy"><strong>New document</strong><span>Starts a blank draft</span></div></article>
        </div>
      </main>
    </div>
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
                if (typeof window !== 'undefined' && window.confirm?.(`Delete "${title}"?`)) onDelete(id)
              }}
            >
              Delete
            </button>
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
