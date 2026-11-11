/**
 * The Conclave panel: the assistant sidebar, its composer, and the formatting
 * toolbar that lives in the editor but belongs to this family of controls.
 *
 * Extracted verbatim from `main.jsx`, which held the whole application in one
 * file. The panel is the most self-contained thing in there -- it takes five
 * props, owns all of its own state, and shares nothing with the shell except the
 * reduced-motion flag and the theme -- so it was the natural first thing to move.
 *
 * Two things moved with it that are worth knowing about:
 *
 *  - `MESSAGE_WINDOW` came along because it is only ever read here. It is how many
 *    messages the transcript grows by when it hits the older end, and it had no
 *    other reader even when it lived in the shell.
 *
 *  - `getFastTransition` did not; it is shared with the library, the boot layer
 *    and the editor, so it went to `library/motion.js` instead of being copied.
 *    `motion.test.mjs` asserts each transition helper is defined exactly once, so
 *    a second copy would have failed rather than quietly diverged.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../Icon.jsx'
import { hasWebGL2 } from '../platform/capabilities.js'
import { EffectBoundary } from '../ErrorBoundary.jsx'
import { getFastTransition, getMotionTransition } from './motion.js'
import { renderChatMarkdown } from './chatMarkdown.js'
import { startWavRecording } from './audioRecorder.js'
import { notify } from './toast.js'
import { VoiceBeam, useMicrophone } from 'voice-glow'
import { readTableSize, resizeTable, tableSizes } from '../editor/tableSize.js'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.jsx'
import { BorderBeam, BotAvatar, Liquid, LiquidItem, MetalFx, ThinkingOrb } from './chat-effects.js'
import ThoughtLine from './ui/ThoughtLine.jsx'
import {
  chat,
  describeFailure,
  listProviderModels,
  questionnaire,
  cancelChat,
  transcribeAudio,
  pickDocumentPaths,
  convertDocument,
  runtime,
} from '../platform/store.js'

/**
 * How many chat messages stay mounted at once.
 *
 * `messages` is append-only for the life of a conversation and every AI message
 * mounts a `BotAvatar` canvas, so rendering the whole transcript ties the number
 * of live canvases to the length of the session. `bot-avatars` keeps one
 * module-level rAF over every registered avatar and one canvas per instance, so
 * that is an unbounded cost in a long session -- and it is paid for messages
 * that are scrolled out of view.
 *
 * The window only grows when the reader asks for more, so the bound holds by
 * default and the transcript is still reachable.
 */
const MESSAGE_WINDOW = 40

/** The conversation, so a refresh opens the thread the reader was in. */
const TRANSCRIPT_KEY = 'quill:chat-transcript:v1'

/**
 * The conversation belongs to the document it is about, not to the window.
 *
 * One global transcript meant a question about one draft was still on screen
 * when a different draft was opened, and the assistant looked as though it had
 * read the new book. The document id in the key gives each draft its own
 * conversation; switching documents mounts its panel fresh, so the transcript
 * and the run state start where that document left them.
 */
const transcriptKey = (documentId) => `${TRANSCRIPT_KEY}:${documentId}`

const SUGGESTIONS = ['Summarize draft', 'Tighten intro', 'Suggest three titles']

/**
 * Model variants, in the sense the model catalog uses the word: the same model
 * asked to spend a different amount of effort. They are not different models,
 * so the picker above still names the model; this only sets the budget.
 */
const VARIANTS = [
  { id: 'fast', label: 'Fast', hint: 'Short answers, minimal research. Best for quick edits.' },
  { id: 'balanced', label: 'Balanced', hint: 'The normal mix of research and writing.' },
  { id: 'deep', label: 'Deep', hint: 'More reasoning and longer drafts. Uses more tokens.' },
]

/**
 * The model picker is a hand-built listbox (2026-11-01, by design request).
 *
 * It replaced a native `<select>`: the reference designs want model rows with
 * a badge, a selection dot and card styling the OS popup cannot be given. The
 * things the native control gave for free are the contract this picker now
 * keeps itself: `role="listbox"`/`role="option"` with `aria-selected`, focus
 * lands on the first option when it opens, Arrow keys walk the rows, Escape
 * closes and returns focus to the trigger, and a press outside closes it.
 * "Connect a provider…" and "Retry reading models" are rows in the listbox
 * rather than magic select values -- the old `__`-prefixed sentinel values
 * existed only because a select cannot host a button.
 */

/**
 * Highlight tag palette.
 *
 * Shared by the toolbar swatches and the tag popover so a colour always means
 * the same thing in both places. These are stored as inline `background-color`
 * on the mark, which is why the dark theme keeps a light swatch with dark ink
 * rather than inverting it — an inline style outranks the stylesheet.
 */
const HIGHLIGHT_TAGS = [
  { color: '#fde68a', name: 'Idea', key: '1' },
  { color: '#bfdbfe', name: 'To research', key: '2' },
  { color: '#e9d5ff', name: 'Quote', key: '3' },
  { color: '#fecaca', name: 'Cut later', key: '4' },
]

// The Word defaults, requested wholesale, plus the app's own faces. Each name
// has a bundled face of its own (see `fonts.css`), so a family renders the same
// way on every machine instead of collapsing into whatever fontconfig picks for
// an unavailable Windows font.
const READING_FONTS = [
  'Funnel Display',
  'Arial', 'Arial Black', 'Calibri', 'Calibri Light', 'Cambria', 'Comic Sans MS',
  'Consolas', 'Courier New', 'Franklin Gothic', 'Garamond', 'Georgia', 'Impact',
  'Lucida Sans', 'Palatino Linotype', 'Segoe UI', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana',
  'Inter', 'DM Mono',
]
// Point sizes, the unit the toolbar applies, so the list matches a word
// processor rather than a CSS pixel ruler.
const READING_SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '22', '24', '28', '32', '36', '48', '72']

// The document defaults. A paragraph with no explicit mark is set in Arial at
// 12pt by `.editor-page`/`.document-prose`, so the toolbar reports those values
// instead of showing an empty picker that looks like nothing has been decided.
const DEFAULT_FONT = 'Arial'
const DEFAULT_SIZE = '12'

const THOUGHT_VERBS = ['Thinking', 'Conspiring', 'Evaluating', 'Grounding', 'Sleuthing', 'Drafting']

/**
 * Which of the ThinkingOrb's nine states matches the newest step.
 *
 * The orb beside the label and the label's own shimmering text tell the same
 * story -- a searching orb over "Sleuthing: …", a composing orb over "Writing
 * a section" -- so the state derives from the step instead of parking on
 * "breathing" (orb states: working / searching / solving / listening /
 * connecting / weaving / composing / breathing / shaping).
 */
function orbStateFor(steps) {
  const last = (steps[steps.length - 1] || '').toLowerCase()
  if (!last) return 'breathing'
  if (/sleuth|search|searxng|the web|source/.test(last)) return 'searching'
  if (/writ|draft|assembl/.test(last)) return 'composing'
  if (/check|plagiar|ground|coheren/.test(last)) return 'solving'
  if (/plan|lay out|outline|section/.test(last)) return 'weaving'
  if (/subject|concept|thinking it/.test(last)) return 'shaping'
  return 'working'
}

/**
 * Re-renders the toolbar as the selection moves.
 *
 * Button highlighting depends on where the caret is, and Tiptap only mutates
 * the document on a command. Subscribing to selection updates and transactions
 * is what keeps the pressed state honest when the reader moves the caret with
 * the arrow keys or selects a whole line.
 */
function useSelectionTick(editor) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!editor) return undefined
    const bump = () => setTick((value) => value + 1)
    editor.on('selectionUpdate', bump)
    editor.on('transaction', bump)
    return () => {
      editor.off('selectionUpdate', bump)
      editor.off('transaction', bump)
    }
  }, [editor])
  return tick
}

/**
 * A listbox shaped like the assistant's model picker.
 *
 * The editor toolbar's font and size controls used to be Radix selects. The
 * reference designs want the same card, rows and selection dot as the model
 * picker, and a font list is only useful if each row is set in its own face, so
 * this is hand-built: a content-fit trigger plus a portalled popover.
 *
 * It is portalled rather than absolutely positioned because the toolbar's inner
 * row scrolls horizontally (`overflow-x: auto`), and a scrolling box clips a
 * child that reaches below it. Fixed coordinates from the trigger's rect keep
 * the popover above the page no matter how far the toolbar is scrolled.
 *
 * The contract the native control used to provide lives here: `role="listbox"`
 * and `role="option"` with `aria-selected`, `aria-haspopup`/`aria-expanded`, the
 * first (or selected) row focused on open, Arrow/Home/End movement, Escape to
 * close back to the trigger, and a press outside to dismiss.
 */
function ToolbarSelect({
  label,
  value,
  placeholder,
  options,
  onChange,
  optionStyle,
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined

    const place = () => {
      const box = triggerRef.current?.getBoundingClientRect()
      if (!box) return
      // Keep the card on screen when the toolbar is scrolled and the control sits
      // near the right edge; the popover is wider than its trigger on purpose.
      const width = Math.max(box.width, 168)
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8))
      setRect({ left, top: box.bottom + 6, width: box.width })
    }
    place()

    const frame = requestAnimationFrame(() => {
      const list = popoverRef.current
      const selected = list?.querySelector('[role="option"][aria-selected="true"]')
      ;(selected || list?.querySelector('[role="option"]'))?.focus()
    })

    const onPointerDown = (event) => {
      if (popoverRef.current?.contains(event.target)) return
      if (triggerRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }

    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /** Arrow keys walk the rows, Home/End jump, wrapping at both ends. */
  const moveFocus = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = [...(popoverRef.current?.querySelectorAll('[role="option"]') || [])]
    if (!rows.length) return
    event.preventDefault()
    const current = rows.indexOf(document.activeElement)
    let next
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % rows.length
    else next = current <= 0 ? rows.length - 1 : current - 1
    rows[next]?.focus()
  }

  const choose = (next) => {
    setOpen(false)
    onChange(next)
  }

  const shown = value || placeholder

  return (
    <div className="tool-listbox" data-open={open ? '' : undefined}>
      <button
        type="button"
        ref={triggerRef}
        className={`tool-listbox-trigger${value ? '' : ' is-placeholder'}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value ? undefined : `${placeholder} — document default`}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <span className="tool-listbox-name">{shown}</span>
      </button>
      <Icon name="down" size={11} />
      {open && rect && createPortal(
        <div
          className="tool-listbox-popover"
          role="listbox"
          aria-label={label}
          ref={popoverRef}
          style={{ left: rect.left, top: rect.top, minWidth: Math.max(rect.width, 168) }}
          onKeyDown={moveFocus}
        >
          {options.map((option) => {
            const selected = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`tool-listbox-option${selected ? ' is-selected' : ''}`}
                style={optionStyle ? optionStyle(option.value) : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.value)}
              >
                <span className="tool-listbox-option-name">{option.label}</span>
                {selected && <i className="tool-listbox-dot" aria-hidden="true" />}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * The editor formatting bar.
 *
 * Modelled on a declarative tool list rather than hand-written buttons: each
 * entry knows its own pressed test, so the markup stays flat as tools are
 * added. Only commands the current schema supports appear here — StarterKit
 * plus TextStyle and Highlight. Alignment and tables would need extra
 * extensions and are deliberately not stubbed in.
 */
function FormatToolbar({ editor, runCommand, onFont, onSize, defaultFont = DEFAULT_FONT, tagsOpen, onToggleTags, applyTag, onInsertImage, onInsertMath }) {
  useSelectionTick(editor)
  // Before the early return: hooks must run unconditionally.
  const [insertChoice, setInsertChoice] = useState('')

  if (!editor) return null

  const keepSelection = (event) => event.preventDefault()

  // The menus that read their value straight off the document, so the toolbar
  // shows what the selection actually has rather than the last thing clicked.
  const ALIGNMENTS = ['left', 'center', 'right', 'justify']
  const currentAlign = ALIGNMENTS.find((a) => editor.isActive({ textAlign: a })) || 'left'
  const currentLineHeight = String(
    (editor.isActive('heading')
      ? editor.getAttributes('heading').lineHeight
      : editor.getAttributes('paragraph').lineHeight) || '',
  )
  const currentLetterSpacing = String(editor.getAttributes('textStyle').letterSpacing || '')
  const spacingValue = currentLineHeight
    ? `lh-${currentLineHeight}`
    : currentLetterSpacing
      ? `ls-${currentLetterSpacing}`
      : ''

  // Read the family and size straight off the caret, the same way alignment
  // and spacing are read. Keeping them in local state meant the picker showed
  // whatever was last applied (and "Inter"/"16" before anything was). When no
  // mark is present the document default is reported instead: Arial at 12pt,
  // which is what `.editor-page` actually paints.
  const textStyle = editor.getAttributes('textStyle')
  const currentFont = String(textStyle.fontFamily || defaultFont || DEFAULT_FONT)
    .replace(/["']/g, '')
    .split(',')[0]
    .trim()
  // Stored without units so it matches the fixed list; the unit is added back
  // when the command runs. Older documents may still carry pixels, so both
  // units are stripped and the number is what the picker compares.
  const currentSize = String(textStyle.fontSize || `${DEFAULT_SIZE}pt`).replace(/(?:px|pt)$/i, '').trim()

  // A family or size applied elsewhere can be absent from the fixed lists; the
  // applied value joins its own list instead of being blank in the trigger.
  const fontOptions = [...READING_FONTS]
  if (currentFont && !fontOptions.includes(currentFont)) fontOptions.unshift(currentFont)
  const sizeOptions = [...READING_SIZES]
  if (currentSize && !sizeOptions.includes(currentSize)) sizeOptions.unshift(currentSize)

  const tools = [
    { kind: 'group', label: 'Heading', items: [1, 2, 3].map((level) => ({
      key: `h${level}`,
      label: `H${level}`,
      title: `Heading ${level}`,
      text: `H${level}`,
      active: editor.isActive('heading', { level }),
      run: () => runCommand('toggleHeading', { level }),
    })) },
    { kind: 'group', label: 'Text', items: [
      { key: 'bold', label: 'Bold', text: <strong>B</strong>, active: editor.isActive('bold'), run: () => runCommand('toggleBold') },
      { key: 'italic', label: 'Italic', text: <em>I</em>, active: editor.isActive('italic'), run: () => runCommand('toggleItalic') },
      { key: 'underline', label: 'Underline', text: <u>U</u>, active: editor.isActive('underline'), run: () => runCommand('toggleUnderline') },
      { key: 'strike', label: 'Strikethrough', text: <s>S</s>, active: editor.isActive('strike'), run: () => runCommand('toggleStrike') },
    ] },
    { kind: 'group', label: 'Blocks', items: [
      { key: 'bullet', label: 'Bulleted list', icon: 'list', active: editor.isActive('bulletList'), run: () => runCommand('toggleBulletList') },
      { key: 'ordered', label: 'Numbered list', icon: 'sort', active: editor.isActive('orderedList'), run: () => runCommand('toggleOrderedList') },
      { key: 'quote', label: 'Blockquote', icon: 'revise', active: editor.isActive('blockquote'), run: () => runCommand('toggleBlockquote') },
      { key: 'code', label: 'Code block', icon: 'draft', active: editor.isActive('codeBlock'), run: () => runCommand('toggleCodeBlock') },
      { key: 'rule', label: 'Horizontal rule', icon: 'minus', run: () => runCommand('setHorizontalRule') },
    ] },
    { kind: 'group', label: 'History', items: [
      { key: 'undo', label: 'Undo', icon: 'undo', run: () => runCommand('undo'), enabled: editor.can().undo() },
      { key: 'redo', label: 'Redo', icon: 'redo', run: () => runCommand('redo'), enabled: editor.can().redo() },
    ] },
  ]

  // Table editing, only while the cursor is inside one. A grid is inserted at a
  // fixed 3x3, and without these the reader had no way to shrink it to 3x2, 2x2
  // or 1x1 or remove it again -- the shape had to be right on the first try.
  // Rows and columns are separate actions because they are separate dimensions:
  // "delete row" cannot answer "make it two columns".
  const tableSize = readTableSize(editor)
  if (editor.isActive('table')) {
    tools.push({ kind: 'group', label: 'Table', items: [
      { key: 'row-after', label: 'Add row below', title: 'Add row below', icon: 'plus', run: () => runCommand('addRowAfter') },
      { key: 'col-after', label: 'Add column right', title: 'Add column right', icon: 'plus', run: () => runCommand('addColumnAfter') },
      { key: 'row-del', label: 'Delete row', title: 'Delete row', icon: 'minus', run: () => runCommand('deleteRow') },
      { key: 'col-del', label: 'Delete column', title: 'Delete column', icon: 'minus', run: () => runCommand('deleteColumn') },
      { key: 'table-del', label: 'Delete table', title: 'Delete table', icon: 'trash', run: () => runCommand('deleteTable') },
    ] })
  }

  return (
    <div className="format-toolbar-inner" role="toolbar" aria-label="Formatting">
      <div className="tool-selects">
        <ToolbarSelect
          label="Font family"
          value={currentFont}
          placeholder="Font"
          options={fontOptions.map((name) => ({ value: name, label: name }))}
          onChange={onFont}
          // Each row is set in its own face, so the list is a specimen rather
          // than a column of names that all look alike.
          optionStyle={(name) => ({ fontFamily: `'${name}', sans-serif` })}
        />
        <ToolbarSelect
          label="Text size"
          value={currentSize}
          placeholder="Size"
          options={sizeOptions.map((value) => ({ value, label: value }))}
          onChange={onSize}
        />
        <Select value={currentAlign} onValueChange={(value) => runCommand('setTextAlign', value)}>
          <SelectTrigger
            className="tool-select"
            aria-label="Alignment"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="center">Center</SelectItem>
            <SelectItem value="right">Right</SelectItem>
            <SelectItem value="justify">Justify</SelectItem>
          </SelectContent>
        </Select>
        <Select value={spacingValue} onValueChange={(value) => {
          if (value.startsWith('lh-')) runCommand('setLineHeight', value.slice(3))
          else if (value === 'ls-normal') runCommand('unsetLetterSpacing')
          else if (value.startsWith('ls-')) runCommand('setLetterSpacing', value.slice(3))
        }}>
          <SelectTrigger
            className="tool-select"
            aria-label="Line and letter spacing"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <SelectValue placeholder="Spacing" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lh-1">Single spacing</SelectItem>
            <SelectItem value="lh-1.15">Spacing 1.15</SelectItem>
            <SelectItem value="lh-1.5">Spacing 1.5</SelectItem>
            <SelectItem value="lh-2">Double spacing</SelectItem>
            <SelectItem value="ls-normal">Normal letters</SelectItem>
            <SelectItem value="ls--0.02em">Tight letters</SelectItem>
            <SelectItem value="ls-0.06em">Wide letters</SelectItem>
            <SelectItem value="ls-0.12em">Wider letters</SelectItem>
          </SelectContent>
        </Select>
        <Select value={insertChoice} onValueChange={(value) => {
          // Reset immediately: a controlled Select only fires when its value
          // changes, so without this the same item could not be chosen twice.
          setInsertChoice('')
          if (value === 'image') onInsertImage?.()
          else if (value === 'math') onInsertMath?.()
          else if (value === 'table') runCommand('insertTable', { rows: 3, cols: 3, withHeaderRow: true })
        }}>
          <SelectTrigger
            className="tool-select"
            aria-label="Insert"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <SelectValue placeholder="Insert" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="image">Image…</SelectItem>
            <SelectItem value="math">Formula…</SelectItem>
            <SelectItem value="table">Table (3 × 3)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {tools.map((group) => (
        <div className="tool-group" key={group.label} role="group" aria-label={group.label}>
          {group.items.map((tool) => (
            <button
              key={tool.key}
              type="button"
              className={`format-button ${tool.text ? 'letter' : ''} ${tool.active ? 'active' : ''}`}
              title={tool.title || tool.label}
              aria-label={tool.label}
              aria-pressed={tool.active ?? false}
              disabled={tool.enabled === false}
              onMouseDown={keepSelection}
              onClick={tool.run}
            >
              {tool.text ?? <Icon name={tool.icon} size={15} />}
            </button>
          ))}
        </div>
      ))}

      {tableSize && (
        <div className="tool-group table-size" role="group" aria-label="Table size">
          <span className="table-size-label">Rows</span>
          <ToolbarSelect
            label="Table rows"
            value={String(tableSize.rows)}
            placeholder="Rows"
            options={tableSizes(tableSize.rows).map((count) => ({ value: String(count), label: String(count) }))}
            onChange={(value) => resizeTable(editor, value, tableSize.cols)}
          />
          <span className="table-size-label">Cols</span>
          <ToolbarSelect
            label="Table columns"
            value={String(tableSize.cols)}
            placeholder="Cols"
            options={tableSizes(tableSize.cols).map((count) => ({ value: String(count), label: String(count) }))}
            onChange={(value) => resizeTable(editor, tableSize.rows, value)}
          />
        </div>
      )}

      <div className="tool-group" role="group" aria-label="Highlight">
        {HIGHLIGHT_TAGS.map((tag) => (
          <button
            key={tag.name}
            type="button"
            className={`swatch-button ${editor.isActive('highlight', { color: tag.color }) ? 'active' : ''}`}
            title={`Highlight ${tag.name.toLowerCase()}`}
            aria-label={`Highlight ${tag.name.toLowerCase()}`}
            aria-pressed={editor.isActive('highlight', { color: tag.color })}
            onMouseDown={keepSelection}
            onClick={() => applyTag(tag.color)}
          >
            <span className="tag-swatch" style={{ background: tag.color }} />
          </button>
        ))}
        <button
          type="button"
          className="format-button"
          title="More highlight tags"
          aria-label="More highlight tags"
          aria-expanded={tagsOpen}
          onClick={onToggleTags}
        >
          <Icon name="tag" size={15} />
        </button>
      </div>

      <div className="tool-group" role="group" aria-label="Text colour">
        <label className="color-control" title="Text colour">
          <span className="color-dot" />
          <input type="color" defaultValue="#1A1A1A" aria-label="Choose text color" onChange={(event) => runCommand('setColor', event.target.value)} />
        </label>
      </div>
    </div>
  )
}

/**
 * The three one-tap shortcuts above the composer.
 *
 * `gooey` renders each label as a `Liquid.Item` so the SVG goo filter can merge
 * them on hover. The markup is identical either way, which is what lets the
 * EffectBoundary fall back to the plain row without losing the shortcuts.
 */
function SuggestionRow({ onPick, gooey = false, transition }) {
  const label = (suggestion) => (
    <button className="chat-suggestion" type="button" onClick={() => onPick(suggestion)}>
      {suggestion}
    </button>
  )
  if (!gooey) {
    // `label` returns the button, and a function cannot put a key on it, so the
    // key goes on a Fragment around it. A Fragment adds no element: the plain
    // row and the gooey row have the same DOM. This branch is the fallback for
    // every machine where the gooey effect fails, so a missing key here was
    // warning in the app, not only in a test.
    return <div className="chat-suggestions">{SUGGESTIONS.map((suggestion) => <React.Fragment key={suggestion}>{label(suggestion)}</React.Fragment>)}</div>
  }
  return (
    <div className="chat-suggestion-items">
      {SUGGESTIONS.map((suggestion) => (
        <LiquidItem key={suggestion} transition={transition}>{label(suggestion)}</LiquidItem>
      ))}
    </div>
  )
}

/**
 * What a reader can attach to a turn.
 *
 * The panel can only hand the provider text, so the picker offers the formats
 * that are genuinely text: prose, notes, data and source files. The cap keeps a
 * long attachment from swallowing the per-model token budget; the turn says so
 * when it truncates rather than silently dropping the rest.
 */
const MAX_ATTACHMENT_CHARS = 12000
// A UTF-8 character is at most four bytes, so this is enough to fill the
// character cap. Slicing before `text()` matters: a reader can pick a log file
// far larger than the token budget, and reading all of it just to throw 99% away
// would freeze the panel.
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_CHARS * 4
const TEXT_FILE = /\.(?:txt|text|md|markdown|mdx|csv|tsv|json|ndjson|html?|xml|rtf|tex|ya?ml|toml|ini|cfg|log|rst|org|jsx?|tsx?|py|rs|go|c|cc|cpp|h|hpp|css|scss|sass|sql|sh|bash|zsh|rb|java|kt|swift|php|lua|r)$/i

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Reads one picked file into the shape the composer and the turn use. */
async function readAttachment(file) {
  if (!file.type.startsWith('text/') && !TEXT_FILE.test(file.name)) {
    throw new Error('Quill can read text files such as .txt, .md, .csv, .json or code.')
  }
  const raw = await file.slice(0, MAX_ATTACHMENT_BYTES).text()
  if (raw.includes('\u0000')) throw new Error('That file is not plain text.')
  const text = raw.trim()
  if (!text) throw new Error('That file is empty.')
  return {
    name: file.name,
    size: file.size,
    text: text.slice(0, MAX_ATTACHMENT_CHARS),
    truncated: file.size > MAX_ATTACHMENT_BYTES || text.length > MAX_ATTACHMENT_CHARS,
  }
}

/** How an attachment is quoted into the prompt the model reads. */
function attachmentPrompt(attachment) {
  if (!attachment) return ''
  if (attachment.error) return `Attached file: ${attachment.name} (could not be read: ${attachment.error})`
  return [
    `Attached file: ${attachment.name}${attachment.truncated ? ' (truncated)' : ''}`,
    '',
    attachment.text,
    '',
    `--- end of ${attachment.name} ---`,
  ].join('\n')
}

/** The message box, its controls and the send button. */
function ChatComposer({ input, setInput, send, mode, setMode, variant, setVariant, interview, setInterview, attachment, setAttachment, fileRef, sendButton, voiceState, voiceError, onVoiceStart, onVoiceStop, busy = false }) {
  // The desktop picker goes through MarkItDown, which covers PDF, DOCX,
  // PPTX, XLSX, HTML and more. The hidden input remains the browser fallback.
  const pickDocument = async () => {
    if (!runtime.isTauri) {
      fileRef.current?.click()
      return
    }
    try {
      const [path] = await pickDocumentPaths()
      if (!path) return
      const markdown = await convertDocument(path)
      const name = String(path).split(/[\\/]/).pop() || String(path)
      setAttachment({
        name,
        size: markdown.length,
        text: markdown.slice(0, MAX_ATTACHMENT_CHARS),
        truncated: markdown.length > MAX_ATTACHMENT_CHARS,
      })
    } catch (error) {
      const message = reasonFor(error)
      setAttachment({ name: 'Document', size: 0, error: message })
      notify(message)
    }
  }

  // The input is cleared before the read so picking the same file twice fires
  // change again; the File object itself stays valid after the reset.
  const pickFile = async (event) => {
    const inputElement = event.currentTarget
    const file = inputElement.files?.[0]
    inputElement.value = ''
    if (!file) return
    try {
      setAttachment(await readAttachment(file))
    } catch (error) {
      setAttachment({ name: file.name, size: file.size, error: reasonFor(error) })
    }
  }

  return (
    <div className="chat-box" data-ready={input.trim() || attachment?.text ? '' : undefined}>
      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }}
        placeholder={busy ? 'Working…' : mode === 'Ask' ? 'Ask about this draft…' : 'Suggest a revision…'}
        rows="1"
        disabled={busy}
      />
      <div className="chat-controls">
        <div className="chat-control-left">
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".txt,.text,.md,.markdown,.mdx,.csv,.tsv,.json,.ndjson,.html,.htm,.xml,.rtf,.tex,.yaml,.yml,.toml,.ini,.cfg,.log,.rst,.org,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.cc,.cpp,.h,.hpp,.css,.scss,.sass,.sql,.sh,.bash,.zsh,.rb,.java,.kt,.swift,.php,.lua,.r,text/*"
            onChange={pickFile}
          />
          <button className="chat-control" type="button" aria-label="Attach a document" title="Attach a document (PDF, DOCX, Markdown, text…)" onClick={pickDocument}><Icon name="attach" size={15} /></button>
          <button
            className={`chat-control chat-voice${voiceState === 'recording' ? ' is-recording' : ''}`}
            type="button"
            aria-label={voiceState === 'recording' ? 'Stop recording' : 'Record a voice note'}
            aria-pressed={voiceState === 'recording'}
            title={voiceState === 'recording' ? 'Stop and transcribe' : 'Record a voice note'}
            onClick={voiceState === 'recording' ? onVoiceStop : onVoiceStart}
            disabled={busy || voiceState === 'transcribing'}
          >
            <Icon name={voiceState === 'recording' ? 'mic-off' : 'mic'} size={15} />
          </button>
          {voiceState !== 'idle' && (
            <span className="chat-voice-status" role="status">
              {voiceState === 'recording' ? 'Listening…' : voiceState === 'transcribing' ? 'Transcribing…' : voiceError || 'Microphone'}
            </span>
          )}
          <button
            className="chat-mode chat-variant"
            type="button"
            title={VARIANTS.find((entry) => entry.id === variant)?.hint || 'Model effort'}
            aria-label={`Model variant: ${VARIANTS.find((entry) => entry.id === variant)?.label || 'Balanced'}`}
            onClick={() => {
              const at = VARIANTS.findIndex((entry) => entry.id === variant)
              setVariant(VARIANTS[(at + 1) % VARIANTS.length].id)
            }}
          >
            {VARIANTS.find((entry) => entry.id === variant)?.label || 'Balanced'} <Icon name="down" size={12} />
          </button>
        </div>
        {sendButton}
      </div>
    </div>
  )
}

/** A rejected command, as something a reader can be told. */
function reasonFor(error) {
  const message = String(error?.message ?? error ?? '').trim()
  return message || 'That did not work.'
}

/** What kind of turn answered, as the line under the answer. */
function describeTransport(transport, task) {
  if (transport !== 'sidecar') return 'Answered directly by the provider'
  if (!task) return 'Answered by the writing service'
  const article = /^[AEIOU]/.test(task) ? 'An' : 'A'
  return `${article} ${task.toLowerCase()} turn, answered by the writing service`
}

/** One assistant answer, rendered as Markdown instead of literal asterisks. */
function ChatMarkdown({ text }) {
  const html = useMemo(() => renderChatMarkdown(text), [text])
  return <div className="message-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * A Claude-style clarifying questionnaire.
 *
 * One question at a time, with numbered answers, a free-text “something else”
 * row and a step counter. The card is deliberately compact: it is a short
 * interview before a write, not a form that pushes the conversation away.
 */
function QuestionnaireCard({ questions, answered, answers, onSubmit }) {
  const [step, setStep] = useState(0)
  const [chosen, setChosen] = useState({})
  const [custom, setCustom] = useState({})
  const total = questions.length
  const question = questions[Math.min(step, total - 1)]

  const collectedFrom = (extra = {}) => questions.map((entry, index) => {
    const typed = String(extra[index]?.custom ?? custom[index] ?? '').trim()
    const picked = [...(extra[index]?.chosen ?? chosen[index] ?? [])]
    if (typed) picked.push(typed)
    return { header: entry.header, question: entry.question, answers: picked }
  })

  const finish = (extra) => onSubmit(collectedFrom(extra))
  const advance = (extra) => {
    if (step + 1 < total) setStep(step + 1)
    else finish(extra)
  }

  const choose = (label) => {
    if (question.multiSelect) {
      setChosen((current) => {
        const list = current[step] || []
        return {
          ...current,
          [step]: list.includes(label) ? list.filter((entry) => entry !== label) : [...list, label],
        }
      })
      return
    }
    const nextChosen = { ...chosen, [step]: [label] }
    setChosen(nextChosen)
    // Let the chosen row paint before the next question replaces it.
    window.setTimeout(() => advance({ [step]: { chosen: [label] } }), 140)
  }

  if (answered) {
    return (
      <div className="questionnaire is-answered">
        <span className="questionnaire-done"><Icon name="check" size={12} /> Answers sent</span>
        {(answers || []).filter((entry) => entry.answers.length).map((entry) => (
          <p key={entry.header}><strong>{entry.header}</strong> {entry.answers.join('; ')}</p>
        ))}
      </div>
    )
  }

  const list = chosen[step] || []
  return (
    <div className="questionnaire">
      <div className="questionnaire-head">
        <span>{question.header}</span>
        <span className="questionnaire-progress">{step + 1} of {total}</span>
      </div>
      <p className="questionnaire-title">{question.question}</p>
      <div className="questionnaire-options" role={question.multiSelect ? 'group' : 'radiogroup'}>
        {question.options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            className={`questionnaire-option${list.includes(option.label) ? ' is-chosen' : ''}`}
            aria-pressed={list.includes(option.label)}
            onClick={() => choose(option.label)}
          >
            <span className="questionnaire-index" aria-hidden="true">{index + 1}</span>
            <span className="questionnaire-option-copy">
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
            {list.includes(option.label) && <Icon name="check" size={13} />}
          </button>
        ))}
        <label className="questionnaire-other">
          <span className="questionnaire-index" aria-hidden="true">+</span>
          <input
            type="text"
            value={custom[step] || ''}
            placeholder="Something else"
            onChange={(event) => setCustom((current) => ({ ...current, [step]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              advance({ [step]: { custom: event.currentTarget.value } })
            }}
          />
        </label>
      </div>
      <div className="questionnaire-actions">
        <button className="questionnaire-skip" type="button" onClick={() => advance()}>
          Skip
        </button>
        {question.multiSelect && (
          <button className="questionnaire-submit" type="button" onClick={() => advance()}>
            {step + 1 < total ? 'Next' : 'Finish'}
          </button>
        )}
      </div>
    </div>
  )
}

function ChatPanel({ documentId, assistantReducedMotion, settings, theme, onSettingsChange, activeProvider, onSelectModel, onOpenSettings, rightOpen, effectsActive, getDraft, onWriteToDocument }) {
  const [messages, setMessages] = useState(() => {
    // Restored on mount so a refresh does not empty the conversation. Vite
    // defines `import.meta.env`; the test loader does not, and tests must not
    // leak transcripts between mounts, so persistence only exists in the app.
    if (import.meta.env) {
      try {
        const key = documentId ? transcriptKey(documentId) : TRANSCRIPT_KEY
        let saved = JSON.parse(localStorage.getItem(key) || 'null')
        // The first version kept one window-wide transcript. Preserve it by
        // handing it to the first document opened after the upgrade, rather
        // than leaving that conversation stranded under a key nothing reads.
        if (!saved?.messages && documentId) {
          const legacy = localStorage.getItem(TRANSCRIPT_KEY)
          if (legacy) {
            const previous = JSON.parse(legacy)
            localStorage.setItem(key, legacy)
            localStorage.removeItem(TRANSCRIPT_KEY)
            saved = previous
          }
        }
        if (Array.isArray(saved?.messages) && saved.messages.length) return saved.messages
      } catch (error) {
        console.warn('Could not restore the conversation', error)
      }
    }
    return [{ id: 'welcome', role: 'ai', text: 'I’m here when you want a second pair of eyes. I can summarize, tighten, or find a pattern in the draft.' }]
  })
  const [input, setInput] = useState('')
  // The conversation is part of the reader's work: a refresh must not empty it.
  // Written straight through rather than debounced -- messages are small, and a
  // debounce only trades a lost refresh for a lost tab close. Gated on
  // `import.meta.env` for the same reason as the restore above.
  useEffect(() => {
    if (!import.meta.env) return
    try {
      const key = documentId ? transcriptKey(documentId) : TRANSCRIPT_KEY
      localStorage.setItem(key, JSON.stringify({ messages }))
    } catch (error) {
      console.warn('Could not save the conversation', error)
    }
  }, [messages, documentId])

  // Declared before the effect below reads them: the dependency array
  // evaluates during render, so a state born further down is a TDZ crash.
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerTriggerRef = useRef(null)
  const pickerPopoverRef = useRef(null)

  // The listbox closes the two ways a menu should (a press outside, Escape)
  // and keeps the focus contract: the first option takes focus when it opens,
  // and Escape hands it back to the trigger.
  useEffect(() => {
    if (!pickerOpen) return undefined
    const frame = requestAnimationFrame(() => {
      pickerPopoverRef.current?.querySelector('[role="option"]')?.focus()
    })
    const onPointerDown = (event) => {
      if (pickerPopoverRef.current?.contains(event.target)) return
      if (pickerTriggerRef.current?.contains(event.target)) return
      setPickerOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      setPickerOpen(false)
      pickerTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [pickerOpen])

  /** Arrow keys walk the rows, wrapping at both ends. */
  const movePickerFocus = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const rows = [...event.currentTarget.querySelectorAll('[role="option"]')]
    const current = rows.indexOf(document.activeElement)
    const next = event.key === 'ArrowDown'
      ? (current + 1) % rows.length
      : (current <= 0 ? rows.length - 1 : current - 1)
    rows[next]?.focus()
  }

  const chooseModel = (value) => {
    setPickerOpen(false)
    if (value) selectModel(value)
  }

  const [attachment, setAttachment] = useState(null)
  const [typing, setTyping] = useState(false)
  // Turns typed while one is thinking are held here, in order, and dispatch
  // when the composer goes idle (see the flush effect after `send`).
  const [mode, setMode] = useState('Auto')
  // `reference` blends the prompt with the document; `survey` extracts a
  // concept per selected section. The mode only reaches a WRITE-shaped turn;
  // answers and research ignore it, but the choice is kept for the next one.
  const [conceptMode, setConceptMode] = useState(() => {
    try {
      return localStorage.getItem('quill:concept-mode') === 'survey' ? 'survey' : 'reference'
    } catch {
      return 'reference'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('quill:concept-mode', conceptMode)
    } catch {
      // A disabled storage quota must not break the composer.
    }
  }, [conceptMode])
  const [variant, setVariant] = useState(() => {
    try {
      const saved = localStorage.getItem('quill:model-variant')
      return VARIANTS.some((entry) => entry.id === saved) ? saved : 'balanced'
    } catch {
      return 'balanced'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('quill:model-variant', variant)
    } catch {
      // Storage is a convenience; a disabled quota must not break the panel.
    }
  }, [variant])
  // Interview is a one-shot mode: it asks the questionnaire for the next turn,
  // then turns itself off so the answers can be written without another round.
  const [interview, setInterview] = useState(false)
  const task = 'auto'
  const [liveModels, setLiveModels] = useState([])
  const [modelsState, setModelsState] = useState('idle')
  const [modelsError, setModelsError] = useState('')
  const [modelsRevision, setModelsRevision] = useState(0)
  // The stages this turn has actually reported, in the order they happened.
  const [turnSteps, setTurnSteps] = useState([])
  const [thoughtVerb, setThoughtVerb] = useState(THOUGHT_VERBS[0])
  const [shownCount, setShownCount] = useState(MESSAGE_WINDOW)
  const scrollRef = useRef(null)
  const fileRef = useRef(null)
  const mic = useMicrophone()
  const micRef = useRef(mic)
  micRef.current = mic
  const recorderRef = useRef(null)
  const wavRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const [voiceState, setVoiceState] = useState('idle')
  const [voiceError, setVoiceError] = useState('')

  const transcribeBlob = useCallback(async (blob) => {
    setVoiceState('transcribing')
    setVoiceError('')
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      const isWav = String(blob.type).includes('wav')
      const result = await transcribeAudio({
        audio: window.btoa(binary),
        mime: blob.type || 'audio/webm',
        filename: isWav ? 'quill-voice.wav' : 'quill-voice.webm',
      })
      const text = String(result?.text || '').trim()
      if (text) {
        setInput((current) => (current.trim() ? `${current.trim()} ${text}` : text))
      } else {
        setVoiceError('No speech was detected.')
      }
    } catch (error) {
      const message = error?.message || 'The recording could not be transcribed.'
      setVoiceError(message)
      notify(message)
    } finally {
      setVoiceState('idle')
    }
  }, [setInput])

  const startVoice = useCallback(async () => {
    const microphone = micRef.current
    if (!microphone?.supported) {
      setVoiceError('This webview has no microphone support.')
      setVoiceState('error')
      return
    }
    try {
      const stream = await microphone.start()
      if (!stream) {
        setVoiceError(microphone.error?.message || 'Microphone permission was not granted.')
        setVoiceState('error')
        return
      }

      // WebKitGTK can provide getUserMedia and Web Audio without
      // MediaRecorder. Capture PCM and send a WAV instead of failing.
      if (typeof window.MediaRecorder !== 'function') {
        wavRecorderRef.current = startWavRecording(stream)
        setVoiceError('')
        setVoiceState('recording')
        return
      }

      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']
      const mimeType = candidates.find((type) => window.MediaRecorder.isTypeSupported?.(type)) || ''
      const recorder = mimeType ? new window.MediaRecorder(stream, { mimeType }) : new window.MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data)
      }
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        chunksRef.current = []
        await transcribeBlob(blob)
      }
      recorder.start()
      recorderRef.current = recorder
      setVoiceError('')
      setVoiceState('recording')
    } catch (error) {
      const message = error?.message || 'The microphone could not be started.'
      setVoiceError(message)
      notify(message)
      setVoiceState('error')
    }
  }, [setInput, transcribeBlob])

  const stopVoice = useCallback(() => {
    const wav = wavRecorderRef.current
    wavRecorderRef.current = null
    if (wav) {
      wav.stop()
        .then(transcribeBlob)
        .catch((error) => {
          const message = error?.message || 'The recording could not be stopped.'
          setVoiceError(message)
          notify(message)
          setVoiceState('idle')
        })
      micRef.current?.stop?.()
      return
    }
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    micRef.current?.stop?.()
  }, [transcribeBlob])

  // Every effect below is decorative motion, so a reduced-motion request has to
  // freeze all of them, not just the CSS transitions.
  //
  // The request that reaches HERE is the OS one alone. The in-app toggle stops at
  // the rest of the app, which is why this panel's root carries
  // `reduce-motion-exempt` for the CSS half: a reader who quiets the workspace
  // still gets a Conclave that visibly thinks. Under `prefers-reduced-motion`
  // this is frozen exactly as before.
  const spring = getMotionTransition(assistantReducedMotion)
  const fast = getFastTransition(assistantReducedMotion)
  // The registry owns provider/model now (the flat settings triple is gone),
  // so the picker reads the active provider: the old `settings.model` fallback
  // was dead *and* vendor-specific -- it named a hardcoded model for a Groq row.
  const model = activeProvider?.defaultModel || ''
  // With no provider row there is no model to name and nothing the menu could
  // offer, so the trigger says which of those it is and its click opens the page
  // that fixes it. It used to read "No model" inside a disabled button, which is
  // indistinguishable from a selector that is broken.
  const providerConfigured = Boolean(activeProvider)
  // What the trigger says: the model when there is one, otherwise the state
  // that explains its own absence (loading, error, or no provider at all --
  // in which case the click opens Settings instead of a listbox).
  const triggerLabel = !providerConfigured
    ? 'Set up a provider…'
    : model || (modelsState === 'loading' ? 'Reading models…' : modelsState === 'error' ? 'Models unavailable' : 'No models')
  // The provider's own list plus what is selected, so the menu can't offer a
  // model belonging to a different provider. Groq's /models lists every model
  // on the account -- whisper transcription, the orpheus voices, the prompt
  // guard classifiers -- and a chat turn cannot use any of them: offering
  // them made "pick a model" a way to break the next run. The selected id is
  // always kept so the trigger can never render blank.
  const NON_CHAT_MODEL = /whisper|orpheus|prompt-guard/i
  const modelOptions = Array.from(new Set([model, ...(liveModels.length ? liveModels : activeProvider?.models || [])]
    .filter((option) => option && (option === model || !NON_CHAT_MODEL.test(option)))))
  // Both canvas effects read `data-theme="dark|light"` when left on "auto", and
  // Quill names its dark theme "night", so auto-detection would light them. The
  // mode comes from the *resolved* theme rather than from `settings.theme`: a
  // custom dark theme is called whatever its author called it, and asking
  // whether it is named "night" answers the wrong question.
  const effectTheme = theme?.mode === 'dark' ? 'dark' : 'light'
  // Every effect here is decorative motion, so the Reduce motion setting has to
  // freeze all of them, not just the CSS transitions.
  const still = assistantReducedMotion ? { paused: true } : {}
  // The editor layer stays mounted behind the library at `opacity: 0`, and a
  // fully transparent element still intersects, so nothing in here stopped
  // while the reader was looking at the library: MetalFx's shared WebGL2 context
  // and rAF loop, a BotAvatar canvas per AI message, the ThinkingOrb, and the
  // Liquid SVG goo filter. Unmounting is the only thing that releases a canvas
  // or a context, so this gates the components themselves rather than passing
  // `paused` -- `bot-avatars` runs one module-level rAF over every *registered*
  // avatar, and a paused-but-mounted one is still registered.
  //
  // Chat state lives above these conditionals, so a trip to the library and back
  // keeps the conversation; only the canvases go away.
  const live = Boolean(effectsActive) && Boolean(rightOpen)

  // The rendered slice. The full list stays in state, so this is a cap on what
  // is mounted rather than a truncation of the conversation.
  const hiddenCount = Math.max(0, messages.length - shownCount)
  const visibleMessages = useMemo(
    () => (hiddenCount > 0 ? messages.slice(-shownCount) : messages),
    [messages, shownCount, hiddenCount],
  )

  /**
   * Widens the window and keeps the reader where they were.
   *
   * The earlier messages are inserted above the current scroll position, which
   * would otherwise push the message being read off the bottom of the viewport.
   * Measuring around the state change is the only way to compensate, since the
   * height of the prepended messages is not known before they render.
   */
  const showEarlier = () => {
    const container = scrollRef.current
    const before = container ? container.scrollHeight : 0
    setShownCount((count) => count + MESSAGE_WINDOW)
    window.requestAnimationFrame(() => {
      if (!container) return
      container.scrollTop += container.scrollHeight - before
    })
  }

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [messages, typing])

  // The document-level Escape listener that only ever closed the Share popover
  // went with the popover; the panel's own Escape handling lives elsewhere.

  useEffect(() => {
    const id = activeProvider?.id
    if (!id) {
      setLiveModels([])
      setModelsState('idle')
      setModelsError('')
      return undefined
    }
    let cancelled = false
    setLiveModels([])
    setModelsState('loading')
    setModelsError('')
    listProviderModels(id)
      .then((models) => {
        if (cancelled) return
        setLiveModels(Array.isArray(models) ? models : [])
        setModelsState('idle')
      })
      .catch((error) => {
        if (cancelled) return
        setLiveModels([])
        setModelsState('error')
        setModelsError(reasonFor(error))
      })
    return () => { cancelled = true }
  }, [activeProvider?.id, modelsRevision])

  const selectModel = (value) => {
    onSelectModel?.(value)
  }

  const startNewChat = () => {
    setMessages([{ id: `welcome-${Date.now()}`, role: 'ai', text: 'New conversation. What would you like to work on?' }])
    // A new conversation starts from the default window rather than the reader's
    // widest one, so the bound holds without them having to think about it.
    setShownCount(MESSAGE_WINDOW)
    setInput('')
    setAttachment(null)
    setTyping(false)
  }

  // A monotonic counter, not the clock. Two messages appended inside the same
  // millisecond used to share a `Date.now()` id, and these ids are React keys --
  // a collision reconciles the wrong node and leaves the transcript out of order.
  const messageSeq = useRef(0)
  const turnSeq = useRef(0)
  // Restored transcripts already contain ids like `m1-user`. A fresh mount must
  // not restart the counter at 1 and collide with them, or React reconciles the
  // wrong message and AnimatePresence warns about duplicate keys.
  const nextMessageId = (role) => (
    `m${(messageSeq.current += 1)}-${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  )

  /**
   * One turn, with the composer values passed explicitly.
   *
   * `send` reads the composer and passes the values explicitly, so `send` stays
   * the zero-argument callback the button and the Enter handler already use.
   */
  const dispatch = (value, att) => {
    if (!value && !att) return
    const attachmentText = attachmentPrompt(att)
    const prompt = [value, attachmentText].filter(Boolean).join('\n\n')
    const text = [value, att ? `Attached: ${att.name}` : ''].filter(Boolean).join('\n')
    const turn = ++turnSeq.current
    const userId = nextMessageId('user')
    setMessages((current) => [...current, {
      id: userId,
      role: 'user',
      text,
      // The transcript shows the file's name; the provider gets its contents.
      // Keeping them apart is what stops a 12k-character attachment from
      // filling the reader's own bubble.
      prompt: prompt === text ? undefined : prompt,
    }])
    setInput('')
    setAttachment(null)
    setTyping(true)

    // After the question it answers, not at the end of the transcript. The
    // composer stays live while a reply is pending, so a follow-up typed in the
    // meantime used to push the answer below itself and the transcript read out
    // of order. Appending keeps the pair together wherever it lands.
    const appendReply = (reply) => {
      setMessages((current) => {
        const at = current.findIndex((message) => message.id === userId)
        if (at < 0) return [...current, reply]
        return [...current.slice(0, at + 1), reply, ...current.slice(at + 1)]
      })
    }

    // The transcript as the provider speaks it. The welcome line is dropped
    // because it is this panel's own greeting: sent back as an assistant turn it
    // makes the model continue the greeting instead of answering the question.
    //
    // Failures are dropped too. A `role: 'error'` turn is this panel reporting
    // that something broke, not something anyone said, and the mapping below has
    // no provider role for it -- so it lands as `user` and the model answers our
    // own error text as if the reader had typed it.
    const history = [
      ...messages.filter((message) => message.id !== 'welcome' && message.role !== 'error'),
      { id: userId, role: 'user', text, prompt: prompt === text ? undefined : prompt },
    ].map((message) => ({
      role: message.role === 'ai' ? 'assistant' : 'user',
      content: message.prompt || message.text,
    }))

    setTurnSteps([])
    chat({
      messages: history,
      draft: typeof getDraft === 'function' ? getDraft() : '',
      conceptMode: task === 'survey' ? 'survey' : 'reference',
      task,
      variant,
      tokenSaving: Boolean(settings?.tokenSaving),
      naturalVoice: Boolean(settings?.naturalVoice),
      writingProfile: (() => {
        try {
          return JSON.parse(settings?.writingProfile || 'null')?.prompt || ''
        } catch {
          return ''
        }
      })(),
      // Each stage the sidecar reports is appended once. The sidecar already
      // drops a repeat of the stage it just emitted; this keeps a step that
      // legitimately happens twice from filling the list twice.
      onStage: ({ step }) => setTurnSteps((current) => (
        current.includes(step) ? current : [...current, step]
      )),
    })
      .then(({ reply, transport, task, sources, wroteDocument }) => {
        if (turn !== turnSeq.current) return
        setTyping(false)
        // A turn that produced a document belongs in the document. WRITE and
        // REWRITE both return the piece itself -- a rewrite is the draft after
        // the reader's instruction, not a comment about it -- so sending either
        // to a bubble leaves the reader with a second copy to paste by hand.
        // CRITIQUE stays in the bubble: it is a judgement about a document, not
        // the document.
        //
        // `wroteDocument` is the pipeline saying it actually wrote something.
        // A write whose evidence gate blocked every section returns a notice
        // explaining that instead of a document, and the notice stays here in
        // the bubble -- appending it would replace the reader's draft with a
        // warning. An older backend omits the flag, hence `!== false`.
        const writesDocument = task === 'WRITE' || task === 'REWRITE' || task === 'FORMAT'
        const wrote = writesDocument && wroteDocument !== false && typeof onWriteToDocument === 'function'
          ? onWriteToDocument(reply, { replace: task === 'FORMAT' })
          : false
        appendReply({
          id: nextMessageId('ai'),
          role: 'ai',
          text: wrote ? 'Written to the document.' : (reply || 'The assistant returned an empty answer.'),
          status: describeTransport(transport, task),
          task,
          sources: Array.isArray(sources) ? sources : [],
          written: wrote,
        })
      })
      .catch((error) => {
        if (turn !== turnSeq.current) return
        // A failure is reported as itself. Falling back to a canned reply is
        // exactly what made this panel unable to tell the reader anything was
        // ever wrong.
        notify(describeFailure(error))
        setTyping(false)
        appendReply({
          id: nextMessageId('ai'),
          role: 'error',
          text: 'I could not answer that.',
          status: describeFailure(error),
        })
      })
  }

  /**
   * The interview turn. It asks the same history the chat would see, but the
   * answer is a questionnaire rather than prose, so the reader settles the
   * brief before any tokens go into a draft.
   */
  const askQuestions = (value, att) => {
    const attachmentText = attachmentPrompt(att)
    const prompt = [value, attachmentText].filter(Boolean).join('\n\n')
    const text = [value, att ? `Attached: ${att.name}` : ''].filter(Boolean).join('\n')
    const userId = nextMessageId('user')
    setMessages((current) => [...current, {
      id: userId,
      role: 'user',
      text,
      prompt: prompt === text ? undefined : prompt,
    }])
    setInput('')
    setAttachment(null)
    setTyping(true)

    const appendReply = (reply) => {
      setMessages((current) => {
        const at = current.findIndex((message) => message.id === userId)
        if (at < 0) return [...current, reply]
        return [...current.slice(0, at + 1), reply, ...current.slice(at + 1)]
      })
    }
    const history = [
      ...messages.filter((message) => message.id !== 'welcome' && message.role !== 'error'),
      { id: userId, role: 'user', text, prompt: prompt === text ? undefined : prompt },
    ].map((message) => ({
      role: message.role === 'ai' ? 'assistant' : 'user',
      content: message.prompt || message.text,
    }))

    questionnaire({
      messages: history,
      draft: typeof getDraft === 'function' ? getDraft() : '',
      tokenSaving: Boolean(settings?.tokenSaving),
    })
      .then((questions) => {
        setTyping(false)
        appendReply({
          id: nextMessageId('ai'),
          role: 'ai',
          text: 'A few decisions will change the result. Pick the closest answers, or type your own.',
          questions,
          status: 'Interview',
        })
      })
      .catch((error) => {
        notify(describeFailure(error))
        setTyping(false)
        appendReply({
          id: nextMessageId('ai'),
          role: 'error',
          text: 'I could not prepare the questions.',
          status: describeFailure(error),
        })
      })
  }

  const answerQuestionnaire = (messageId, answers) => {
    setMessages((current) => current.map((message) => (
      message.id === messageId ? { ...message, answered: true, answers } : message
    )))
    setInterview(false)
    const lines = (answers || [])
      .filter((entry) => entry.answers.length)
      .map((entry) => `- ${entry.header}: ${entry.answers.join('; ')}`)
    dispatch(
      lines.length
        ? ['Interview answers:', ...lines].join('\n')
        : 'Continue with the request as written; no further details.',
      null,
    )
  }

  const send = () => {
    const value = input.trim()
    if (!value && !attachment?.text) return
    // One turn at a time. A second send while the assistant is working is
    // refused rather than queued: the reader asked for a run, and racing it
    // with another one makes both answers harder to trust.
    if (typing) return
    if (interview) {
      askQuestions(value, attachment)
      return
    }
    dispatch(value, attachment)
  }

  // metal-fx throws during render when WebGL2 is missing, and WebKitGTK does
  // not always provide it, so the effect is only mounted when a real context is
  // available. The plain button is the fallback in all three directions: a
  // missing context, a collapsed panel, or a shader failure caught by the
  // EffectBoundary.
  //
  // `hasWebGL2()` is a capability probe, not a liveness check -- it caches and
  // returns true on essentially every desktop -- so on its own it kept the
  // WebGL context and its rAF loop alive for as long as the editor existed, even
  // with the panel collapsed to `width: 0`. Liveness is part of the condition
  // here, which is what actually releases the context.
  // `border-beam` has no `paused` prop the way the canvas effects do, so reduce
  // motion has to come through `active` instead. Without this the beam kept
  // travelling while the reader asked for stillness.
  const canUseMetal = hasWebGL2() && live

  const stopTurn = () => {
    turnSeq.current += 1
    setTyping(false)
    setTurnSteps([])
    cancelChat().catch(() => {})
  }

  const plainSendButton = typing ? (
    <motion.button className="send-button is-stop" style={{ pointerEvents: 'auto' }} type="button" aria-label="Stop the assistant" title="Stop" onClick={stopTurn} whileTap={{ scale: 0.94 }} transition={spring}>
      <Icon name="stop" size={14} />
    </motion.button>
  ) : (
    <motion.button className="send-button" style={{ pointerEvents: 'auto' }} type="button" disabled={typing || (!input.trim() && !attachment?.text)} aria-label="Send message" onClick={send} whileTap={{ scale: 0.94 }} transition={spring}>
      <Icon name="send" size={15} />
    </motion.button>
  )
  // Chromatic at full strength is the Libraries.dev send-button recipe
  // (variant circle + innerShadow); silver at 0.62 was so quiet on the dark
  // theme it read as no effect at all (2026-11-02).
  const decoratedSendButton = canUseMetal ? (
    <MetalFx variant="circle" preset="chromatic" theme={effectTheme} strength={1} innerShadow borderRadius={9} paused={assistantReducedMotion} style={{ pointerEvents: 'none' }}>
      {plainSendButton}
    </MetalFx>
  ) : (
    plainSendButton
  )

  const composerProps = {
    input, setInput, send, mode, setMode, conceptMode, setConceptMode,
    variant, setVariant, interview, setInterview,
    attachment, setAttachment,
    fileRef, busy: typing, voiceState, voiceError, onVoiceStart: startVoice,
    onVoiceStop: stopVoice,
  }

  return (
    <aside className="assistant-panel reduce-motion-exempt" aria-label="Conclave assistant">
      <div className="assistant-head">
        <div className="assistant-head-actions">
          <div className="model-picker" data-open={pickerOpen ? '' : undefined}>
            {/* The trigger half of the listbox -- the comment on the listbox
                above (near the constants) is the design argument. The field
                hugs its content: no badge in front of the id, and the chevron
                sits in the right padding rather than at the end of a row
                that is wider than its own text. */}
            <button
              type="button"
              className="model-trigger"
              // Inline as belt and braces: the stylesheet says the same, but a
              // stale CSS tag in a long-lived dev window kept painting the old
              // `--sidebar` face while the JS hot-updated around it. Inline
              // styles ride the module path that is demonstrably live.
              style={{ background: 'transparent', appearance: 'none', WebkitAppearance: 'none' }}
              ref={pickerTriggerRef}
              aria-label={providerConfigured ? `AI model: ${triggerLabel}` : 'Connect a provider'}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              title={modelsState === 'error' ? modelsError : undefined}
              onClick={() => {
                if (!providerConfigured) { onOpenSettings?.(); return }
                setPickerOpen((open) => !open)
              }}
            >
              <span className="model-trigger-label">{triggerLabel}</span>
            </button>
            <Icon name="down" size={12} />
          </div>
          <button
            className={`assistant-head-action${interview ? ' is-on' : ''}`}
            type="button"
            aria-label={interview ? 'Clarifying questions on' : 'Ask clarifying questions'}
            aria-pressed={interview}
            title="Ask a few clarifying questions before the next write"
            onClick={() => setInterview((value) => !value)}
          >
            <Icon name="details" size={15} />
          </button>
          <button className="assistant-head-action" type="button" aria-label="New chat" onClick={startNewChat}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        {pickerOpen && (
          <div
            className="model-popover"
            role="listbox"
            aria-label="AI model"
            ref={pickerPopoverRef}
            onKeyDown={movePickerFocus}
          >
            {modelOptions.map((option) => {
              const selected = option === model
              return (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`model-option${selected ? ' is-selected' : ''}`}
                  onClick={() => chooseModel(option)}
                >
                  <span className="model-option-badge" aria-hidden="true"><Icon name="sparkle" size={11} /></span>
                  <span className="model-option-name">{option}</span>
                  {selected && <i className="model-option-dot" aria-hidden="true" />}
                </button>
              )
            })}
            {modelsState === 'error' && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="model-option model-option-action"
                onClick={() => { setModelsRevision((count) => count + 1); setPickerOpen(false) }}
              >
                <span className="model-option-badge model-option-badge--muted" aria-hidden="true"><Icon name="sort" size={11} /></span>
                <span className="model-option-name">Retry reading models</span>
              </button>
            )}
            <div className="model-popover-sep" />
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="model-option model-option-action"
              onClick={() => { setPickerOpen(false); onOpenSettings?.() }}
            >
              <span className="model-option-badge model-option-badge--muted" aria-hidden="true"><Icon name="settings" size={11} /></span>
              <span className="model-option-name">Connect a provider…</span>
            </button>
          </div>
        )}
      </div>

      <div className="chat-scroll" ref={scrollRef} aria-live="polite">
        {hiddenCount > 0 && (
          <button className="show-earlier" type="button" onClick={showEarlier}>
            Show {hiddenCount} earlier {hiddenCount === 1 ? 'message' : 'messages'}
          </button>
        )}
        <AnimatePresence initial={false}>
          {visibleMessages.map((message) => (
            <motion.div key={message.id} className={`chat-message ${message.role}${message.written ? ' is-written' : ''}`} initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={fast}>
              <div className="message-content">
                {message.role === 'ai' && effectsActive && (
                  <EffectBoundary fallback={null}>
                    <span className="message-avatar" aria-hidden="true">
                      <BotAvatar
                        type={message.id === 'welcome' ? 'clover' : 'star'}
                        size={26}
                        face="eyes"
                        state={typing && message.id === messages[messages.length - 1]?.id ? 'working' : 'default'}
                        theme={effectTheme}
                        interactive={false}
                        speed={0.8}
                        {...still}
                      />
                    </span>
                  </EffectBoundary>
                )}
                <div className="message-body">
                  {message.written && <Icon name="check" size={13} />}
                  {message.role === 'ai'
                    ? <ChatMarkdown text={message.text} />
                    : message.text.split('\n').map((line, index) => (
                      <span key={`${message.id}-${index}`}>{line}{index < message.text.split('\n').length - 1 && <br />}</span>
                    ))}
                  {message.questions?.length > 0 && (
                    <QuestionnaireCard
                      questions={message.questions}
                      answered={message.answered}
                      answers={message.answers}
                      onSubmit={(answers) => answerQuestionnaire(message.id, answers)}
                    />
                  )}
                </div>
                {message.sources?.length > 0 && message.task === 'RESEARCH' && (
                  <button
                    className="message-pull"
                    type="button"
                    onClick={() => {
                      const markdown = [
                        '## Sources',
                        ...message.sources.map((source, index) => `${index + 1}. [${source.title || source.url}](${source.url})`),
                      ].join('\n')
                      onWriteToDocument?.(markdown)
                    }}
                  >
                    <Icon name="download" size={12} /> Pull sources into the document
                  </button>
                )}
                {message.sources?.length > 0 && (
                  <details className="message-sources">
                    <summary>
                      <Icon name="chevron" size={12} />
                      {message.sources.length} {message.sources.length === 1 ? 'source' : 'sources'}
                    </summary>
                    <ul>
                      {message.sources.map((source, index) => (
                        <li key={`${message.id}-source-${index}`}>
                          <a href={source.url} target="_blank" rel="noreferrer noopener">{source.title || source.url}</a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {(message.role === 'ai' || message.role === 'error') && (
                  <div className="message-status">
                    {/* A failed turn carries its reason here. Without that, the
                        reader gets "I could not answer that" and no way to find
                        out why -- which is the state this panel was already in. */}
                    <span>{message.status ?? (message.id === 'welcome' ? 'Ready when you are' : 'Draft context ready')}</span>
                    {/* A run row names its own phase, so the chevron that invites
                        a reply under an answer would be claiming the wrong thing.
                        A failure is not an answer, so it invites nothing. */}
                    {message.role === 'ai' && message.id !== 'welcome' && !message.run && <Icon name="down" size={12} />}
                  </div>
                )}
              </div>
            </motion.div>
          ))}
          {typing && (
            <motion.div className="chat-message ai is-pending" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={fast}>
              <div className="message-content">
                <div className="message-status typing-status">
                  {/* The 64 preset is the free way to get a larger orb: the
                      canvas backing store is sized from `size`, so CSS-scaling a
                      20px orb up would blur it. Displaying 64 down at 28px keeps
                      every dot crisp. The adjacent "Thinking" text already says
                      what is happening, so the canvas is hidden from readers. */}
                  {effectsActive && <EffectBoundary fallback={null}>
                    <ThinkingOrb
                      state={orbStateFor(turnSteps)}
                      size={64}
                      theme={effectTheme}
                      aria-hidden="true"
                      style={{ width: 28, height: 28 }}
                      {...still}
                    />
                  </EffectBoundary>}
                  {/* The waiting line is the shared ThoughtLine, not a bare
                      word. That component was only ever mounted inside the
                      thesis-run card, so a normal question -- the thing this
                      panel is for -- never used it: the assistant showed an orb
                      and the literal text "Thinking", with no timer and no
                      motion. `glyph="none"` is what makes the two compose: the
                      orb above is the visual, so the line contributes only the
                      breathing label and the elapsed count.

                      It is short-lived by construction. The block is gated on
                      `typing`, so the line never settles here -- it unmounts
                      the moment the reply lands, which is the right ending for
                      a wait that is over. */}
                  <ThoughtLine
                    glyph="none"
                    label="Thinking…"
                    working
                    showTimer
                    fontSize={12.5}
                    steps={turnSteps}
                    className="typing-thoughts"
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="chat-footer">
        {/* Liquid draws one merged silhouette from its items, so the plain row
            is a faithful fallback rather than a different control. */}
        <EffectBoundary fallback={<SuggestionRow onPick={setInput} />}>
          {live ? <Liquid className="chat-suggestions" blur={5} contrast={17} fill="var(--chat)" waviness={1.6}>
            {/* Both values are real liquid-gooey presets. It defines exactly
                three: snappy, smooth, bouncy. This used to say 'sharp', which
                is not one of them, so `resolveTransition` read
                `presets['sharp'].stiffness` and threw a TypeError during render
                -- on the reduced-motion path, so the setting that was supposed
                to calm this row was the one that broke it. `smooth` is the
                calmest of the three and the library's own default. Note the
                library reads the OS query itself and collapses to a zero
                duration on its own; the value here only carries the in-app
                setting, which it cannot see. */}
            <SuggestionRow onPick={setInput} gooey transition={assistantReducedMotion ? 'smooth' : 'bouncy'} />
          </Liquid> : <SuggestionRow onPick={setInput} />}
        </EffectBoundary>

        {attachment && (
          <div className={`attachment-chip${attachment.error ? ' is-error' : ''}`} role={attachment.error ? 'alert' : undefined}>
            <Icon name="file" size={12} />
            <span title={attachment.error || attachment.name}>
              {attachment.name}
              {attachment.error ? ` — ${attachment.error}` : attachment.size ? ` · ${formatBytes(attachment.size)}` : ''}
              {attachment.truncated ? ' · first 12,000 characters' : ''}
            </span>
            <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachment(null)}><Icon name="close" size={12} /></button>
          </div>
        )}

        {/* BorderBeam wraps the composer, so the fallback re-renders the same
            component without the beam. */}
        <EffectBoundary fallback={<ChatComposer {...composerProps} sendButton={plainSendButton} />}>
          {voiceState === 'idle' ? (
            <BorderBeam className="chat-beam" size="line" colorVariant={effectTheme === 'dark' ? 'ice' : 'ocean'} strength={0.55} active={typing && !assistantReducedMotion} theme={effectTheme} duration={3.2}>
              <ChatComposer {...composerProps} sendButton={decoratedSendButton} />
            </BorderBeam>
          ) : (
            <VoiceBeam
              stream={mic.stream}
              processing={voiceState === 'transcribing'}
              theme={effectTheme}
              paused={assistantReducedMotion}
            >
              <ChatComposer {...composerProps} sendButton={decoratedSendButton} />
            </VoiceBeam>
          )}
        </EffectBoundary>
      </div>
    </aside>
  )
}

export { ChatPanel, FormatToolbar, HIGHLIGHT_TAGS }
