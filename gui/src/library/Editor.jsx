/**
 * The editor: the document surface, the outline panel, and the chrome around them.
 *
 * Extracted verbatim from `main.jsx`, which is now a shell: it owns the app's
 * state and nothing else renders inside it.
 *
 * This is the largest of the extractions and the least self-contained, because
 * the editor genuinely sits between everything -- it calls
 * `useCollaborativeDocument`, renders `DocumentEditor`, hosts `FormatToolbar`,
 * mounts `ChatPanel`, and opens the export dialog. The saving is that those are
 * now visible imports rather than ambient neighbours two hundred lines apart.
 *
 * One dependency is worth flagging: the highlight-tag list is exported from
 * `ChatPanel.jsx` rather than duplicated. The toolbar writes tags from it and the
 * popover below the toolbar reads them, so the two halves of one feature were
 * already sharing a constant -- it just used to be sharing a file.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../Icon.jsx'
import { ExportDialog } from '../ExportDialog.jsx'
import { DocumentEditor } from '../editor/DocumentEditor.jsx'
import { useCollaborativeDocument } from '../editor/useCollaborativeDocument.js'
import {
  collectHeadings,
  getParentId,
  hasChildren,
  pickActiveHeading,
  SECTION_LEVEL,
  sectionNumber,
} from '../editor/outline.js'
import { ChatPanel, FormatToolbar, HIGHLIGHT_TAGS } from './ChatPanel.jsx'
import { Mathematics } from '@tiptap/extension-mathematics'
import { Image } from '@tiptap/extension-image'

/**
 * How far below the top of the scroll container a section counts as current.
 *
 * It is the reading line: a heading that has scrolled above it is no longer the
 * one being read. The old scroll handler compared rects against this value and
 * the observer now uses it as a root margin, so it is named rather than
 * repeated.
 */
const ACTIVE_HEADING_OFFSET = 190

function EditableTitle({ title, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const inputRef = useRef(null)
  // Escape tears the input down, which fires blur. Without this the cancel
  // would be undone by the blur handler committing the draft a moment later.
  const cancelled = useRef(false)

  // Follow the document when it changes underneath, but never while the reader
  // is mid-edit.
  useEffect(() => {
    if (!editing) setDraft(title)
  }, [title, editing])

  useEffect(() => {
    if (!editing) return
    // Clear the cancel flag as the field opens. Escape tears the input down
    // before any blur can fire, so the flag used to survive into the next edit
    // and silently swallow it: press Escape, reopen the title, click away, and
    // the second rename was discarded.
    cancelled.current = false
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [editing])

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const next = draft.trim()
    setEditing(false)
    if (next && next !== title) onRename(next)
    else setDraft(title)
  }

  const cancel = () => {
    cancelled.current = true
    setDraft(title)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="document-title-input"
        value={draft}
        aria-label="Document title"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit() }
          if (event.key === 'Escape') { event.preventDefault(); cancel() }
        }}
        onBlur={commit}
      />
    )
  }

  return (
    <h1 className="document-title">
      <button type="button" className="document-title-button" onClick={() => setEditing(true)} title="Rename document">
        {title}
      </button>
    </h1>
  )
}

function Editor({ doc, stats, settings, theme, onSettingsChange, activeProvider, onSelectModel, onOpenSettings, onTitleChange, onBack, onPanel, leftOpen, rightOpen, zen, onZen, onDetails, onDelete, onContentSave, spring, fast, reducedMotion, assistantReducedMotion, onStatsChange, author, view, exportRequest }) {
  const editorRef = useRef(null)
  // The panels animate `width`, which re-runs layout each frame; a spring here
  // makes them visibly hunt as they settle.
  // Memoised for the same reason as `App`'s: a fresh object literal is a new
  // prop identity on every render, which re-arms the animation.
  const scrollRef = useRef(null)
  const lastRange = useRef(null)
  const [activeHeading, setActiveHeading] = useState(null)
  const [folded, setFolded] = useState({})
  const [bubble, setBubble] = useState(null)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  // A download requested from the library navigates here first and then opens
  // the same dialog the Export button opens. Keyed on the request counter so a
  // second download of the same document opens it again after a close.
  useEffect(() => { if (exportRequest) setExportOpen(true) }, [exportRequest])
  const [toolbarFont, setToolbarFont] = useState('Inter')
  const [toolbarSize, setToolbarSize] = useState('16')

  // The document body lives in a Yjs document, so the editor is collaborative
  // capable even though only local persistence is wired up so far.
  const {
    editor: tiptap,
    ydoc,
    ready: editorReady,
    setSpellcheck,
  } = useCollaborativeDocument({
    documentId: doc.id,
    legacyHtml: doc.content,
    onStatsChange,
  })

  // The outline is derived from the live editor state rather than by parsing
  // innerHTML, which is no longer the source of truth.
  const [outlineVersion, setOutlineVersion] = useState(0)
  useEffect(() => {
    if (!tiptap) return undefined
    const refresh = () => setOutlineVersion((value) => value + 1)
    tiptap.on('update', refresh)
    tiptap.on('create', refresh)
    return () => {
      tiptap.off('update', refresh)
      tiptap.off('create', refresh)
    }
  }, [tiptap])

  const headings = useMemo(() => {
    if (!tiptap) return []
    return collectHeadings(tiptap)
    // outlineVersion is the dependency that triggers recomputation.
  }, [tiptap, outlineVersion])

  useEffect(() => {
    setActiveHeading(null)
    setFolded({})
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [doc.id])

  useEffect(() => {
    setSpellcheck(settings.spellcheck)
  }, [settings.spellcheck, setSpellcheck])

  // Flush pending Yjs updates when leaving the document.
  useEffect(() => {
    return () => {
      ydoc?.flushNow().catch(() => {})
    }
  }, [ydoc])

  // Resolves a heading's document position to its DOM node so scrolling and
  // active-heading tracking work against the real rendered element.
  const headingElement = useCallback(
    (pos) => {
      if (!tiptap || typeof pos !== 'number') return null
      try {
        return tiptap.view.domAtPos(pos + 1)?.node || null
      } catch (_) {
        return null
      }
    },
    [tiptap],
  )

  /**
   * Tracks which section the reader is in, with an observer.
   *
   * This used to be a rAF-throttled scroll handler that, on every frame, called
   * `domAtPos` per heading -- a ProseMirror tree walk -- and then read
   * `getBoundingClientRect()` for each one. The first read forced layout and
   * every later read re-checked it, so scrolling the editor did synchronous
   * layout inside the scroll frame.
   *
   * The observer resolves the heading nodes once per outline change, which is
   * not a scroll path. A heading is "current" when it is the last one inside the
   * region below the reading line, and the 190 px offset that used to be a
   * manual threshold comparison is now that region's top margin.
   */
  useEffect(() => {
    const container = scrollRef.current
    // Every webview this ships in has an IntersectionObserver. The guard is
    // only so an unexpected engine degrades to a static outline instead of
    // throwing inside an effect.
    if (!container || typeof IntersectionObserver === 'undefined') return undefined

    const tracked = headings
      .map((heading) => ({ id: heading.id, node: headingElement(heading.pos) }))
      .filter((entry) => entry.node)
    if (!tracked.length) return undefined

    const byNode = new Map(tracked.map((entry) => [entry.node, entry.id]))
    const current = new Set()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = byNode.get(entry.target)
          if (!id) continue
          if (entry.isIntersecting) current.add(id)
          else current.delete(id)
        }
        const latest = pickActiveHeading(tracked, current)
        // A null here means nothing is in the region, not that nothing is
        // active, so the previous heading is kept rather than cleared.
        if (latest) setActiveHeading(latest)
      },
      {
        root: container,
        rootMargin: `-${ACTIVE_HEADING_OFFSET}px 0px 0px 0px`,
        threshold: 0,
      },
    )
    for (const entry of tracked) observer.observe(entry.node)
    return () => observer.disconnect()
  }, [headings, headingElement])

  const captureSelection = useCallback(() => {
    const view = tiptap?.view
    const selection = window.getSelection()
    if (!view || !selection || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!view.dom.contains(range.commonAncestorContainer) || range.collapsed) {
      setBubble(null)
      return
    }
    lastRange.current = range.cloneRange()
    const rect = range.getBoundingClientRect()
    setBubble({ left: Math.max(18, Math.min(window.innerWidth - 18, rect.left + rect.width / 2)), top: rect.top > 68 ? rect.top - 54 : rect.bottom + 10 })
  }, [tiptap])

  useEffect(() => {
    const handleSelection = () => captureSelection()
    document.addEventListener('selectionchange', handleSelection)
    return () => document.removeEventListener('selectionchange', handleSelection)
  }, [captureSelection])

  /**
   * Applies a formatting action through the editor's command API.
   *
   * The previous implementation used `document.execCommand`, which was
   * deprecated, bypassed the schema, and could not drive a ProseMirror-backed
   * surface. Commands now go through Tiptap so every change lands in the
   * document model and is persisted as a Yjs update.
   */
  const runCommand = useCallback((command, value = null) => {
    const editor = tiptap
    if (!editor) return
    editor.chain().focus()[command](value).run()
    updateToolbar()
  }, [tiptap])

  // Image insertion: a local file picker read into a data URL, so the picture
  // travels inside the document (Yjs carries it with the text -- no asset
  // server for a shared session to resolve, and no broken link later).
  const insertImage = useCallback(() => {
    if (!tiptap) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => tiptap.chain().focus().setImage({ src: String(reader.result), alt: file.name }).run()
      reader.readAsDataURL(file)
    }
    input.click()
  }, [tiptap])

  // Formula insertion: ask for LaTeX, drop an inline math node. The
  // Mathematics extension renders it through KaTeX (css imported in main.jsx).
  const insertMath = useCallback(() => {
    const latex = window.prompt('LaTeX formula', 'E = mc^2')
    if (latex?.trim()) runCommand('insertInlineMath', { latex: latex.trim() })
  }, [runCommand])

  const updateToolbar = useCallback(() => {
    if (!tiptap) return
    try {
      const font = tiptap.getAttributes('textStyle').fontFamily
      const normalized = String(font || '').match(/Inter|Georgia|DM Mono|JetBrains Mono/i)?.[0] || 'Inter'
      setToolbarFont(normalized === 'JetBrains Mono' ? 'DM Mono' : normalized)
      // Stored without units so it matches the <option value> list; the unit is
      // added back when the command runs.
      setToolbarSize(String(tiptap.getAttributes('textStyle').fontSize || '16').replace('px', ''))
    } catch (_) {
      setToolbarFont('Inter')
      setToolbarSize('16')
    }
  }, [])

  const goToHeading = useCallback((id) => {
    const heading = headings.find((item) => item.id === id)
    if (!heading) return
    // Mark the row the reader clicked straight away. The scroll-spy only moves
    // the highlight once the viewport settles on the heading, and in a short
    // document the jump can be a few dozen pixels -- so without this a click
    // that did scroll looked like a click that did nothing.
    setActiveHeading(id)
    const target = headingElement(heading.pos)
    const container = scrollRef.current
    if (!target || !container) return
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 106
    container.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' })
    target.classList.remove('section-flash')
    window.requestAnimationFrame(() => target.classList.add('section-flash'))
    window.setTimeout(() => target.classList.remove('section-flash'), 1700)
  }, [headings, headingElement, reducedMotion])

  const addSection = () => {
    const editor = tiptap
    if (!editor) return
    const end = editor.state.doc.content.size
    // The level the document already writes its sections at, not a fixed one.
    // A new section used to be inserted as `h1` whatever the page held, so in a
    // document whose sections are `h2` -- which is what the seeded essays use --
    // the addition landed one level ABOVE everything already there, and the
    // outline showed it as `1. New section` above a list of unnumbered ones.
    // Matching the first heading keeps a section a sibling of the sections
    // around it. A document with no headings yet falls back to SECTION_LEVEL.
    const level = Number(String(headings[0]?.level || SECTION_LEVEL).replace(/^h/, '')) || 1
    editor
      .chain()
      .focus()
      .insertContentAt(end, [
        { type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'New section' }] },
        { type: 'paragraph' },
      ])
      .run()
    // Place the caret in the paragraph that was just appended.
    window.setTimeout(() => editor.commands.focus('end'), 30)
  }

  /**
   * Builds the export payload for the chosen format.
   *
   * Markdown is serialised on the frontend by `@tiptap/markdown`, which maps
   * ProseMirror nodes and marks directly. Going JSON -> HTML -> Markdown would
   * lose node identity. Every other format needs the ProseMirror JSON, which the
   * Rust core renders itself.
   */
  const getExportPayload = useCallback(async (format) => {
    if (!tiptap) return { document: null, markdown: null }
    if (format === 'markdown') {
      return { document: null, markdown: tiptap.getMarkdown() }
    }
    return { document: tiptap.getJSON(), markdown: null }
  }, [tiptap])

  /**
   * The live draft, for the assistant.
   *
   * A callback rather than a value: the assistant reads it when a question is
   * sent, so a snapshot captured during render would send whatever the draft
   * looked like the last time this component re-rendered, not when it was asked.
   */
  const getDraft = useCallback(() => (tiptap ? tiptap.getMarkdown() : ''), [tiptap])

  /**
   * Appends the assistant's document to the end of the editor.
   *
   * The markdown is parsed through `@tiptap/markdown` rather than the HTML
   * path, so the produced document becomes the same nodes a hand-typed one
   * would. It goes at the end so a WRITE turn stands beside the draft it was
   * asked about instead of over it.
   */
  const appendToDocument = useCallback((markdown) => {
    const editor = tiptap
    const text = typeof markdown === 'string' ? markdown.trim() : ''
    if (!editor || !text) return false
    const end = editor.state.doc.content.size
    editor.commands.insertContentAt(end, text, { contentType: 'markdown' })
    // Generated text saves the moment it lands, not400ms later: this is the
    // exact content a reader has just watched appear, and a refresh in that
    // window must not take it back (2026-11-01 report).
    ydoc?.flushNow().catch((error) => console.warn('Could not flush the document', error))
    return true
  }, [tiptap, ydoc])

  /**
   * Autosave: the write-back from the Yjs body into the `content` column.
   *
   * The editor reads and writes Yjs, but the library tiles, their word counts
   * and every `content`-based reader read the row -- and a run that only wrote
   * Yjs left that column at its original stub (2026-11-02: a2090-word generated
   * book "disappeared" from the library because every reader of `content` still
   * saw the two words it started with). So the two are kept in step: debounced
   * on every edit, flushed on unmount (a doc switch), and written once on open
   * so a document whose truth was only ever in Yjs heals the moment it is
   * opened.
   */
  const persistTimer = useRef(null)
  /**
   * Hands one snapshot up. Returns whether the snapshot was taken.
   *
   * `getHTML()` needs an attached ProseMirror view: `immediatelyRender: false`
   * attaches it a beat after `ready`, and reading before that throws inside
   * `DOMSerializer.fromSchema` -- which the top boundary turns into the whole
   * app being the crash page (2026-11-02, found under the test suite's
   * flushSync). So: view present, try, and let callers retry rather than die.
   */
  const saveContent = useCallback((editor) => {
    if (typeof onContentSave !== 'function') return false
    if (!editor || editor.isDestroyed || !editor.view) return false
    let html
    try {
      html = editor.getHTML()
    } catch (error) {
      console.warn('Could not read document content yet', error)
      return false
    }
    onContentSave(doc.id, { content: html, contentFormat: 'html' })
    return true
  }, [doc.id, onContentSave])

  useEffect(() => {
    if (!tiptap) return undefined
    const onEdit = () => {
      clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(() => saveContent(tiptap), 1500)
    }
    tiptap.on('update', onEdit)
    return () => {
      tiptap.off('update', onEdit)
      clearTimeout(persistTimer.current)
      // The last state before the editor goes away (doc switch, unmount) is
      // the one that must not be lost.
      saveContent(tiptap)
    }
  }, [tiptap, saveContent])

  // One write on open: if `content` is a stub and Yjs holds the document, this
  // is what brings the library back (the recovery for a pre-autosave run).
  // Retried on a short interval because the view may attach a beat after ready.
  useEffect(() => {
    if (!editorReady || !tiptap) return undefined
    let tries = 0
    const id = setInterval(() => {
      tries += 1
      if (saveContent(tiptap) || tries >= 40) clearInterval(id)
    }, 250)
    return () => clearInterval(id)
  }, [editorReady, tiptap, saveContent])

  const applyTag = (color) => { runCommand('toggleHighlight', { color }); setTagsOpen(false) }

  return <main
    className="editor-shell"
    aria-label="Quill editor"
    // The two columns the panels sit in. See `.editor-shell` in styles.css: the
    // panels reserve their space rather than covering the editor, so the topbar's
    // own controls stay reachable with the Sections panel open.
    //
    // These were animated by framer-motion, one property write per frame, and it
    // was the single most visible source of jank in the app. The panels are
    // `position: absolute` and slide on the compositor via `x`, but these
    // columns feed `grid-template-columns`, which is layout: every frame
    // relaid out the grid, and with it the whole editor -- the ProseMirror
    // document included -- for a change that moved the centre column 282px.
    //
    // The transition is now CSS's, on the grid itself, which keeps the value out
    // of React's render loop entirely. Same curve, same duration.
    style={{
      '--shell-left': leftOpen ? '282px' : '0px',
      '--shell-right': rightOpen ? '348px' : '0px',
    }}
  ><aside className="editor-panel left-panel" inert={leftOpen ? undefined : ''} aria-label="Sections"><div className="panel-inner"><div className="panel-head"><span className="panel-mark"><img src="/quill-mark.png" width="185" height="194" alt="" /></span><button className="icon-button" type="button" aria-label="Collapse Sections panel" onClick={() => onPanel('left', false)}><Icon name="back" size={15} /></button></div><div className="panel-section outline-section"><div className="group-label">Sections</div><nav className="outline" aria-label="Document sections">{headings.length ? headings.map((heading, index) => { const parentId = getParentId(headings, index); const hidden = parentId && folded[parentId]; const number = heading.level === SECTION_LEVEL ? sectionNumber(headings, index) : null; return <div key={heading.id} className={`outline-item depth-${heading.level}`} style={{ pointerEvents: hidden ? 'none' : 'auto' }}><button className={`outline-row ${activeHeading === heading.id ? 'active' : ''}`} type="button" onClick={() => goToHeading(heading.id)}>{hasChildren(headings, index) ? <span className={`fold ${folded[heading.id] ? 'is-folded' : ''}`} onClick={(event) => { event.stopPropagation(); setFolded((current) => ({ ...current, [heading.id]: !current[heading.id] })) }}><Icon name="down" size={12} /></span> : heading.level === 'h3' ? <span className="child-dot" /> : <span className="fold-spacer" />}<span>{number ? `${number}. ` : ''}{heading.text}</span></button></div> }) : <div className="empty-outline">Add a heading to build your outline.</div>}</nav><button className="add-section" type="button" onClick={addSection}><Icon name="plus" size={14} /><span>Add section</span></button></div><div className="panel-section collaborators" hidden><div className="group-label">Collaborators</div><div className="collaborator"><span className="avatar orange">AM</span><span><strong>Ava Morgan</strong><small>Editor</small></span><i className="presence online" /></div><div className="collaborator"><span className="avatar green">JR</span><span><strong>Jon Reyes</strong><small>Writer</small></span><i className="presence away" /></div><div className="collaborator"><span className="avatar purple">SK</span><span><strong>Sora Kim</strong><small>Review</small></span><i className="presence online" /></div><button className="invite" type="button"><span><Icon name="plus" size={13} /></span>Invite people</button></div></div></aside><div className="editor-center"><header className="editor-topbar"><div className="topbar-left"><button className="icon-button" type="button" aria-label="Back to library" onClick={onBack}><Icon name="back" size={16} /></button><button className={`panel-toggle ${leftOpen ? 'on' : ''}`} type="button" aria-label="Toggle Sections panel" aria-pressed={leftOpen} onClick={() => onPanel('left', !leftOpen)}><Icon name="panel" size={15} /></button><div className="breadcrumb"><button type="button" onClick={onBack}>Library</button><span>›</span><button type="button" onClick={onBack}>{doc.cat}</button><span>›</span><strong>{doc.title}</strong><button className="details-button" type="button" aria-label="Edit document details" onClick={() => onDetails(doc.id)}><Icon name="details" size={14} /><span>Details</span></button></div></div><div className="topbar-right"><button className={`panel-toggle ${zen ? 'on' : ''}`} type="button" aria-label="Toggle Zen mode" aria-pressed={zen} onClick={onZen}><Icon name="expand" size={15} /></button><button className={`panel-toggle ${rightOpen ? 'on' : ''}`} type="button" aria-label="Toggle Conclave panel" aria-pressed={rightOpen} onClick={() => onPanel('right', !rightOpen)}><Icon name="sparkle" size={15} /></button><span className="topbar-divider" /><span className={`save-state ${settings.autosave ? '' : 'paused'}`}><Icon name="cloud" size={14} />{settings.autosave ? 'Saved' : 'Paused'}</span><button className="publish-button" type="button" onClick={() => setExportOpen(true)}><Icon name="draft" size={13} /><span>Export</span></button></div></header><div className="editor-scroll" ref={scrollRef}><div className="format-toolbar"><FormatToolbar editor={tiptap} runCommand={runCommand} font={toolbarFont} onFont={setToolbarFont} size={toolbarSize} onSize={setToolbarSize} tagsOpen={tagsOpen} onToggleTags={() => setTagsOpen((value) => !value)} applyTag={applyTag} onInsertImage={insertImage} onInsertMath={insertMath} /></div><article className="editor-page" ref={editorRef} onMouseUp={captureSelection} onKeyUp={captureSelection}><EditableTitle title={doc.title} onRename={onTitleChange} /><div className="document-meta">{doc.cat} · {stats.words.toLocaleString()} words · Edited {doc.edited}</div><DocumentEditor editor={tiptap} ready={editorReady} /></article></div><footer className="editor-status"><div>{settings.wordCount && <><span>{stats.words.toLocaleString()} words</span><span>·</span><span>{stats.chars.toLocaleString()} characters</span><span>·</span><span>{stats.paragraphs} paragraphs</span><span>·</span><span>{stats.read} min read</span><span>·</span></>}<span>{settings.autosave ? 'Saved' : 'Paused'}</span></div><div className="status-hints"><button type="button" onClick={() => onPanel('left', !leftOpen)}><kbd>⌘\</kbd> Sections</button><button type="button" onClick={() => onPanel('right', !rightOpen)}><kbd>⌘J</kbd> Assistant</button></div></footer></div><aside className="editor-panel right-panel" inert={rightOpen ? undefined : ''}><ChatPanel assistantReducedMotion={assistantReducedMotion} settings={settings} theme={theme} onSettingsChange={onSettingsChange} activeProvider={activeProvider} onSelectModel={onSelectModel} onOpenSettings={onOpenSettings} rightOpen={rightOpen} effectsActive={view === 'editor'} getDraft={getDraft} onWriteToDocument={appendToDocument} /></aside>{bubble && <div className="selection-bubble" role="toolbar" aria-label="Selected text formatting" style={{ left: bubble.left, top: bubble.top }} onMouseDown={(event) => event.preventDefault()}><button type="button" onClick={() => runCommand('toggleBold')}><strong>B</strong></button><button type="button" onClick={() => runCommand('toggleItalic')}><em>I</em></button><button type="button" onClick={() => runCommand('toggleHighlight', { color: '#fff3a3' })}><Icon name="tag" size={14} /></button><span /><button type="button" onClick={() => runCommand('undo')}><Icon name="undo" size={14} /></button></div>}{tagsOpen && <div className="tag-popover" role="menu"><div className="tag-popover-head">Highlight a thought</div>{HIGHLIGHT_TAGS.map((tag) => <button key={tag.name} type="button" role="menuitem" onClick={() => applyTag(tag.color)}><span className="tag-swatch" style={{ background: tag.color }} />{tag.name}<kbd>⌘{tag.key}</kbd></button>)}</div>}{exportOpen && <ExportDialog key="export-dialog" document={doc} getPayload={getExportPayload} author={author} onClose={() => setExportOpen(false)} reducedMotion={reducedMotion} />}</main>
}

export { Editor }
