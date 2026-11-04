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
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../Icon.jsx'
import { hasWebGL2 } from '../platform/capabilities.js'
import { EffectBoundary } from '../ErrorBoundary.jsx'
import { getFastTransition, getMotionTransition } from './motion.js'
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
  cancelRun,
  chat,
  describeFailure,
  listProviderModels,
  onPipelineStatus,
  onRunEvent,
  pipelineStart,
  pipelineStatus,
  runStatus,
  startRun,
  streamRun,
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

const SUGGESTIONS = ['Summarize draft', 'Tighten intro', 'Suggest three titles']

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

// The Word defaults, requested wholesale, plus the app's own faces. These are
// applied as inline `font-family`, so whatever the system (or fontconfig's
// metric substitutes) provides renders -- the picker offers names, not files.
const READING_FONTS = [
  'Funnel Display',
  'Arial', 'Arial Black', 'Calibri', 'Calibri Light', 'Cambria', 'Comic Sans MS',
  'Consolas', 'Courier New', 'Franklin Gothic', 'Garamond', 'Georgia', 'Impact',
  'Lucida Sans', 'Palatino Linotype', 'Segoe UI', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana',
  'Inter', 'DM Mono',
]
const READING_SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '22', '24', '28', '32', '36', '48', '72']

/**
 * A thesis run, in the panel's own vocabulary.
 *
 * A run takes seven to twenty minutes, so the honest thing to show is the work
 * arriving rather than a progress bar: each event becomes one assistant message
 * in the transcript, and the assistant reads as the thing doing the writing.
 *
 * The Rust side sends the whole SSE record as the payload, so these fields sit at
 * the top level of it -- `payload.section`, not `payload.data.section`. The copy
 * is the panel's: sentence case, no exclamation, a plain report of what happened.
 */
const RUN_PHASE = {
  started: 'Getting started',
  entity: 'Resolving the subject',
  drift: 'Checking the sources',
  section: 'Writing',
  grounding: 'Checking the claims',
  write_gate: 'Assembling the document',
  finished: 'Done',
  blocked: 'Refused',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const RUN_TERMINAL = ['finished', 'failed', 'blocked', 'cancelled']

/** What the sidecar says about itself, as a word rather than a state name. */
const RUN_SIDECAR = {
  ready: 'Writing service ready',
  starting: 'Starting the writing service',
  stopped: 'Writing service stopped',
  unavailable: 'Writing service unavailable',
  failed: 'Writing service failed',
}

const RUN_STARTING_COPY = 'Starting the writing service'

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
 * One event as one assistant message.
 *
 * Every branch reads the payload rather than guessing: a run that says it was
 * refused, or that three claims could not be corroborated, has to be able to say
 * so in the reader's own transcript instead of behind a generic failure.
 */
function friendlyLogLine(line) {
  if (typeof line !== 'string') return line
  let trimmed = line.trim()
  if (!trimmed) return trimmed
  // Network errors
  if (/URLError|Connection refused|connect.*refused/i.test(trimmed)) {
    return 'Network connection failed'
  }
  if (/searxng failed/i.test(trimmed)) {
    return 'Search service unavailable'
  }
  if (/WARNING.*searxng/i.test(trimmed)) {
    return 'Search service unavailable'
  }
  // Parse timing lines
  if (/\|\s*INFO\s*\|.*timing/i.test(trimmed)) {
    const m = trimmed.match(/-\s+([^\s(]+)\s+took\s+([0-9.]+)s/i)
    if (m) {
      const name = m[1]
      const secs = parseFloat(m[2])
      const secLabel = secs < 0.001 ? `${Math.round(secs * 1000000)}μs` : secs < 1 ? `${(secs * 1000).toFixed(0)}ms` : `${secs.toFixed(2)}s`
      if (/parse_text/i.test(name)) return `Parsed document (${secLabel})`
      if (/set\b/i.test(name)) return `Saved state (${secLabel})`
      if (/get\b/i.test(name)) return `Loaded state (${secLabel})`
      if (/derive_name/i.test(name)) return `Derived session name (${secLabel})`
      if (/create\b/i.test(name)) return `Created session (${secLabel})`
      if (/_flatten/i.test(name)) return `Flattened concepts (${secLabel})`
      if (/estimate_tokens/i.test(name)) return `Estimated tokens (${secLabel})`
      if (/run_with_retry/i.test(name)) return `Retried request (${secLabel})`
      if (/wait_for/i.test(name)) return `Waited for budget (${secLabel})`
      if (/Agent\.model|model took/i.test(name) || /model took/i.test(trimmed)) return `Model response (${secLabel})`
      if (/Agent\./i.test(name)) return `Agent step (${secLabel})`
      if (/_prompt_concept/i.test(name)) return `Generated concept (${secLabel})`
      if (/TokenBudget/i.test(name)) return `Prepared request (${secLabel})`
      if (/_searxng/i.test(name)) return `Searched the web (${secLabel})`
      if (/ResearchEngine/i.test(name)) return `Researching (${secLabel})`
      if (/ConceptEngine/i.test(name)) return `Building concept map (${secLabel})`
      return `${name.replace(/_/g, ' ')} (${secLabel})`
    }
  }
  // Concept source lines
  if (/concept source:/i.test(trimmed)) {
    const cm = trimmed.match(/concept source:.*concept='([^']+)'/i)
    if (cm) return `Concept: ${cm[1]}`
    return 'Refining concept'
  }
  // Clean up long log lines
  if (trimmed.length > 150) {
    if (/model took/i.test(trimmed)) return 'Model thinking...'
    if (/searxng/i.test(trimmed)) return 'Searching web...'
    if (/ConceptEngine/i.test(trimmed)) return 'Building concept map...'
    if (/Agent/i.test(trimmed)) return 'Processing...'
    if (/URLError|Connection refused/i.test(trimmed)) return 'Network connection failed'
  }
  // If it contains pipe-separated log format, try to extract the message part
  if (trimmed.includes(' | ') && trimmed.includes(' - ')) {
    const parts = trimmed.split(' - ')
    if (parts.length > 1) {
      trimmed = parts.slice(1).join(' - ')
      // Re-apply cleaning
      if (/URLError|Connection refused/i.test(trimmed)) return 'Network connection failed'
      if (/searxng failed/i.test(trimmed)) return 'Search service unavailable'
      if (trimmed.length > 120) {
        if (/model took/i.test(trimmed)) return 'Model thinking...'
        if (/searxng/i.test(trimmed)) return 'Searching web...'
        if (/ConceptEngine/i.test(trimmed)) return 'Building concept map...'
        if (/Agent/i.test(trimmed)) return 'Processing...'
      }
    }
  }
  return trimmed
}

function runLine(payload) {
  const phase = RUN_PHASE[payload.event] || 'Writing'
  const unverified = payload.unverified ?? 0
  const placeholders = payload.placeholder ?? 0
  // If payload contains log/trace lines, use them (formatted)
  if (Array.isArray(payload.logs) && payload.logs.length) {
    return friendlyLogLine(payload.logs[payload.logs.length - 1])
  }
  if (Array.isArray(payload.thoughts) && payload.thoughts.length) {
    const last = payload.thoughts[payload.thoughts.length - 1]
    if (typeof last === 'string') return friendlyLogLine(last)
    if (last?.text) return friendlyLogLine(last.text)
  }
  if (typeof payload.log === 'string' && payload.log.trim()) {
    return friendlyLogLine(payload.log)
  }
  if (typeof payload.detail === 'string' && /INFO.*\|/i.test(payload.detail)) {
    return friendlyLogLine(payload.detail)
  }
  switch (payload.event) {
    case 'entity':
      return payload.detail || phase
    case 'drift':
      return `The sources describe a different period than the subject${payload.signal ? ` (${payload.signal})` : ''}`
    case 'section':
      return [payload.section, payload.verdict, payload.attempt > 1 ? `attempt ${payload.attempt}` : '']
        .filter(Boolean)
        .join(' · ')
    case 'grounding':
      return `${payload.section} · ${payload.corroborated ?? 0}/${payload.claims ?? 0} claims sourced${unverified ? `, ${unverified} softened` : ''}`
    case 'write_gate':
      return `${payload.written ?? 0} sections written · ${placeholders} left as placeholder${placeholders === 1 ? '' : 's'}`
    case 'finished':
      return 'The document is written.'
    case 'blocked':
    case 'failed':
      return payload.error || phase
    default:
      return phase
  }
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
 * The editor formatting bar.
 *
 * Modelled on a declarative tool list rather than hand-written buttons: each
 * entry knows its own pressed test, so the markup stays flat as tools are
 * added. Only commands the current schema supports appear here — StarterKit
 * plus TextStyle and Highlight. Alignment and tables would need extra
 * extensions and are deliberately not stubbed in.
 */
function FormatToolbar({ editor, runCommand, font, onFont, size, onSize, tagsOpen, onToggleTags, applyTag, onInsertImage, onInsertMath }) {
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

  // A family or size applied elsewhere can be absent from the fixed lists;
  // Radix renders a value with no matching item as blank, so the applied
  // value joins its own list instead of vanishing from the trigger.
  const fontOptions = [...READING_FONTS]
  if (font && !fontOptions.includes(font)) fontOptions.unshift(font)
  const sizeOptions = [...READING_SIZES]
  if (size && !sizeOptions.includes(size)) sizeOptions.unshift(size)

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

  return (
    <div className="format-toolbar-inner" role="toolbar" aria-label="Formatting">
      <div className="tool-selects">
        <Select value={font} onValueChange={onFont}>
          <SelectTrigger
            className="tool-select"
            aria-label="Font family"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fontOptions.map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={size} onValueChange={onSize}>
          <SelectTrigger
            className="tool-select"
            aria-label="Text size"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sizeOptions.map((value) => (
              <SelectItem key={value} value={value}>{value}</SelectItem>
            ))}
          </SelectContent>
        </Select>
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
          <input type="color" defaultValue="#3d7dff" aria-label="Choose text color" onChange={(event) => runCommand('setColor', event.target.value)} />
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

/** The message box, its controls and the send button. */
function ChatComposer({ input, setInput, send, mode, setMode, attachment, setAttachment, fileRef, sendButton, runOpen, setRunOpen }) {
  return (
    <div className="chat-box">
      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }}
        placeholder={mode === 'Ask' ? 'Ask about this draft…' : 'Suggest a revision…'}
        rows="1"
      />
      <div className="chat-controls">
        <div className="chat-control-left">
          <input ref={fileRef} type="file" hidden onChange={(event) => setAttachment(event.target.files?.[0]?.name || '')} />
          <button className="chat-control" type="button" aria-label="Attach a file" onClick={() => fileRef.current?.click()}><Icon name="attach" size={15} /></button>
          {/* The thesis run is a deliberate mode of its own, not a phrasing of
              chat: it commits the reader to twenty minutes of writing, so it is
              something they turn on rather than something they can trip over
              while asking a question. */}
          <button
            className={`chat-control ${runOpen ? 'active' : ''}`}
            type="button"
            aria-pressed={runOpen}
            aria-label="Write a thesis"
            title="Write a thesis"
            onClick={() => setRunOpen((value) => !value)}
          >
            <Icon name="draft" size={15} />
          </button>
          <button className={`chat-mode ${mode === 'Auto' ? 'active' : ''}`} type="button" aria-pressed={mode === 'Auto'} onClick={() => setMode((value) => value === 'Ask' ? 'Edit' : 'Ask')}>{mode} <Icon name="down" size={12} /></button>
        </div>
        {sendButton}
      </div>
    </div>
  )
}

/**
 * The closing report for a finished run.
 *
 * Read from the run's own snapshot rather than assembled from the event stream,
 * because the events stop at `write_gate` and the counts the reader cares about
 * are the ones the service settled on.
 */
function summaryLine(summary) {
  const written = summary?.written ?? 0
  const placeholders = summary?.placeholders ?? 0
  const parts = [`${written} written`, `${placeholders} placeholder${placeholders === 1 ? '' : 's'}`]
  if (summary?.eventCount) parts.push(`${summary.eventCount} events`)
  if (summary?.elapsed > 0) parts.push(`${Math.round(summary.elapsed)}s`)
  return parts.join(' · ')
}

/** A rejected command, as something a reader can be told. */
function reasonFor(error) {
  const message = String(error?.message ?? error ?? '').trim()
  return message || 'The run did not start.'
}

/** What kind of turn answered, as the line under the answer. */
function describeTransport(transport, task) {
  if (transport !== 'sidecar') return 'Answered directly by the provider'
  if (!task) return 'Answered by the writing service'
  const article = /^[AEIOU]/.test(task) ? 'An' : 'A'
  return `${article} ${task.toLowerCase()} turn, answered by the writing service`
}

function ChatPanel({ assistantReducedMotion, settings, theme, onSettingsChange, activeProvider, onSelectModel, onOpenSettings, rightOpen, effectsActive, getDraft, onWriteToDocument }) {
  const [messages, setMessages] = useState(() => {
    // Restored on mount so a refresh does not empty the conversation. Vite
    // defines `import.meta.env`; the test loader does not, and tests must not
    // leak transcripts between mounts, so persistence only exists in the app.
    if (import.meta.env) {
      try {
        const saved = JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || 'null')
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
      localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify({ messages }))
    } catch (error) {
      console.warn('Could not save the conversation', error)
    }
  }, [messages])

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

  const [attachment, setAttachment] = useState('')
  const [typing, setTyping] = useState(false)
  // Turns typed while one is thinking are held here, in order, and dispatch
  // when the composer goes idle (see the flush effect after `send`).
  const [queued, setQueued] = useState([])
  const dispatchRef = useRef(null)
  const [mode, setMode] = useState('Auto')
  const [liveModels, setLiveModels] = useState([])
  const [modelsState, setModelsState] = useState('idle')
  const [modelsError, setModelsError] = useState('')
  const [modelsRevision, setModelsRevision] = useState(0)
  const [runSteps, setRunSteps] = useState([])
  // The stages this turn has actually reported, in the order they happened.
  // Distinct from `runSteps`, which belongs to the thesis run: a question is not
  // a run, and the two can be on screen at once.
  const [turnSteps, setTurnSteps] = useState([])
  const [thoughtVerb, setThoughtVerb] = useState(THOUGHT_VERBS[0])
  const [shownCount, setShownCount] = useState(MESSAGE_WINDOW)
  // The thesis run: `{ state, runId, phase, error }`. Deliberately not the
  // sidecar's state -- a healthy service can still refuse a run, so the two are
  // reported apart.
  const [runOpen, setRunOpen] = useState(false)
  const [runPrompt, setRunPrompt] = useState('')
  const [run, setRun] = useState(null)
  const [sidecar, setSidecar] = useState(null)
  // Which run the listener belongs to. `quill://run-event` carries every run the
  // service has ever started, so an event is only progress if it names this one.
  const activeRunId = useRef('')
  const lastSeq = useRef(0)
  const releaseRunEvent = useRef(null)
  // Bumped whenever the reader cancels or starts again, so a sidecar that is
  // still coming up when they gave up cannot wake up later and start a run
  // nobody is waiting for.
  const runTicket = useRef(0)
  const scrollRef = useRef(null)
  const fileRef = useRef(null)
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

  // Whether the run is still owed output. The transient "Thinking" row is the
  // 850ms chat reply's own signal, so a run replaces it: two indicators of the
  // same assistant working would be one too many.
  const runActive = run?.state === 'starting' || run?.state === 'running'
  const runSettled = !!run && !runActive

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

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [messages, typing, runActive])

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

  useEffect(() => {
    if (!runActive) return undefined
    setThoughtVerb(THOUGHT_VERBS[0])
    const id = window.setInterval(() => {
      setThoughtVerb((current) => THOUGHT_VERBS[(THOUGHT_VERBS.indexOf(current) + 1) % THOUGHT_VERBS.length])
    }, 1200)
    return () => window.clearInterval(id)
  }, [runActive])

  /**
   * One event becomes one assistant message.
   *
   * Stable by construction -- refs and the message setter are the only things it
   * closes over -- so the subscription below can be made once per visible run
   * surface rather than on every render of a panel that gets new messages
   * constantly.
   */
  // The latest write-through callback, reachable from that stable handler
  // without breaking its contract: `appendToDocument` changes identity when the
  // editor mounts, and a stale capture would append into nothing.
  const writeDocumentRef = useRef(onWriteToDocument)
  useEffect(() => { writeDocumentRef.current = onWriteToDocument }, [onWriteToDocument])
  const handleRunEvent = useCallback((payload) => {
    if (!payload || payload.runId !== activeRunId.current) return
    // The stream is resumable, which means a reconnect replays everything after
    // the last sequence number it was given. Without this a resumed stream would
    // print sections the transcript already carries.
    if (typeof payload.seq === 'number') {
      if (payload.seq <= lastSeq.current) return
      lastSeq.current = payload.seq
    }
    setRunSteps((current) => {
      const pageSteps = payload.event === 'finished' && Array.isArray(payload.sources)
        ? payload.sources.map((source) => `Read ${source.title || source.url}`)
        : []
      const step = runLine(payload)
      // Also handle array of logs if present
      let extra = []
      if (Array.isArray(payload.logs)) {
        extra = payload.logs.map((l) => friendlyLogLine(l)).filter(Boolean)
      } else if (Array.isArray(payload.thoughts)) {
        extra = payload.thoughts
          .map((t) => (typeof t === 'string' ? friendlyLogLine(t) : t?.text ? friendlyLogLine(t.text) : null))
          .filter(Boolean)
      }
      if (typeof payload.log === 'string' && payload.log.trim()) {
        extra = [...extra, friendlyLogLine(payload.log)]
      }
      if (typeof payload.detail === 'string' && payload.detail.trim()) {
        const d = friendlyLogLine(payload.detail)
        if (d) extra = [...extra, d]
      }
      if (typeof payload.message === 'string' && payload.message.trim()) {
        extra = [...extra, friendlyLogLine(payload.message)]
      }
      if (typeof payload.text === 'string' && payload.text.trim() && /INFO|WARNING|URLError|timing|searxng/i.test(payload.text)) {
        extra = [...extra, friendlyLogLine(payload.text)]
      }
      const combined = [...current, step, ...extra, ...pageSteps].filter(Boolean)
      // Avoid duplicate consecutive steps
      const dedup = combined.filter((v, i, arr) => i === 0 || v !== arr[i - 1])
      return dedup.slice(-200)
    })
    setMessages((current) => [...current, {
      id: nextMessageId('ai'),
      role: 'ai',
      run: true,
      text: payload.event === 'finished'
        ? (payload.document_markdown ? 'The document is written into your open document.' : 'The document is written.')
        : runLine(payload),
      status: RUN_PHASE[payload.event] || 'Writing',
    }])
    if (!RUN_TERMINAL.includes(payload.event)) {
      setRun({ state: 'running', runId: payload.runId, phase: RUN_PHASE[payload.event] || 'Writing', error: '' })
      return
    }
    // The listener goes with the run. A subscription left behind keeps appending
    // to a conversation nobody is watching, and the next run's first event would
    // land in this one.
    releaseRunEvent.current?.()
    setRun({ state: payload.event === 'finished' ? 'done' : payload.event, runId: payload.runId, phase: '', error: payload.error || '' })
    const finishedId = payload.runId
    activeRunId.current = ''
    if (payload.event !== 'finished') return
    // The finished payload carries the written document itself, so it lands in
    // the open document through the same path a chat WRITE uses. Without this
    // the run's text stayed in the sidecar's store, where no reader could see
    // it (2026-11-01: a full report, invisible until imported by hand).
    if (payload.document_markdown) {
      writeDocumentRef.current?.(payload.document_markdown)
    }
    // `finished` carries no counts of its own; the run's snapshot has the ones
    // the reader cares about, and a missing snapshot must not swallow the news
    // that the document exists.
    runStatus(finishedId)
      .then((summary) => setMessages((current) => [...current, {
        id: nextMessageId('ai'), role: 'ai', run: true, text: summaryLine(summary), status: 'Done',
      }]))
      .catch(() => {})
  }, [])

  // Subscribed while the run surface is on screen, and torn down with it -- plus
  // at the terminal event above, so a run that ended while the card was open does
  // not hold a channel open against a service that has nothing left to say.
  useEffect(() => {
    if (!runOpen && !runActive) return undefined
    pipelineStatus().then(setSidecar).catch(() => {})
    const releaseStatus = onPipelineStatus((payload) => { if (payload) setSidecar(payload) })

    // The run stream, unlike the sidecar status, is only wanted between Start and
    // the terminal event: that handler releases it deliberately, and `runActive`
    // flipping false re-runs this effect, so subscribing again would leave a
    // channel nothing ever closes. The status above must keep refreshing with the
    // card open regardless -- a settled run means the reader may well have walked
    // away to Settings, and "ready" has to be re-checked when they come back.
    if (!runActive && runSettled) return () => { releaseStatus() }

    const releaseEvents = onRunEvent(handleRunEvent)
    releaseRunEvent.current = releaseEvents
    return () => {
      if (releaseRunEvent.current === releaseEvents) releaseRunEvent.current = null
      releaseEvents()
      releaseStatus()
    }
  }, [runOpen, runActive, runSettled, handleRunEvent])

  /**
   * Brings the writing service up if it is not already, and reports whether the
   * run may start. The poll is bounded because a sidecar that never becomes ready
   * is the reader's answer to get now, not a spinner that runs all evening.
   */
  const ensureSidecar = async (ticket) => {
    let state = await pipelineStatus()
    if (state?.state !== 'ready') state = await pipelineStart()
    setSidecar(state)
    for (let attempt = 0; state?.state === 'starting' && attempt < 30 && runTicket.current === ticket; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 700))
      state = await pipelineStatus()
      setSidecar(state)
    }
    if (state?.state === 'ready') return true
    setRun({ state: 'failed', runId: '', phase: '', error: state?.detail || 'The writing service is not running.' })
    return false
  }

  const beginRun = async () => {
    const subject = runPrompt.trim()
    if (!subject) return
    const ticket = (runTicket.current += 1)
    setMessages((current) => [...current, { id: nextMessageId('user'), role: 'user', text: subject }])
    setRunSteps([`${RUN_STARTING_COPY}…`])
    setRun({ state: 'starting', runId: '', phase: `${RUN_STARTING_COPY}…`, error: '' })
    if (!(await ensureSidecar(ticket))) return
    if (runTicket.current !== ticket) return
    try {
      const started = await startRun({ prompt: subject, conceptMode: 'reference' })
      if (!started?.runId) throw new Error('The writing service did not return a run.')
      activeRunId.current = started.runId
      lastSeq.current = 0
      setRun({ state: 'running', runId: started.runId, phase: RUN_PHASE.started, error: '' })
      // Opens the stream and resolves when the run ends, so it is started rather
      // than awaited; the progress itself arrives on the event channel.
      streamRun(started.runId).catch(() => {})
    } catch (error) {
      setRun({ state: 'failed', runId: '', phase: '', error: reasonFor(error) })
    }
  }

  const stopRun = async () => {
    const runId = activeRunId.current
    runTicket.current += 1
    if (!runId) {
      setRun(null)
      return
    }
    setRun((current) => (current ? { ...current, phase: 'Stopping' } : current))
    try {
      await cancelRun(runId)
    } catch (error) {
      setMessages((current) => [...current, {
        id: nextMessageId('ai'), role: 'ai', run: true, text: reasonFor(error), status: 'Cancelled',
      }])
    }
  }

  const selectModel = (value) => {
    onSelectModel?.(value)
  }

  const startNewChat = () => {
    setMessages([{ id: `welcome-${Date.now()}`, role: 'ai', text: 'New conversation. What would you like to work on?' }])
    // A new conversation starts from the default window rather than the reader's
    // widest one, so the bound holds without them having to think about it.
    setShownCount(MESSAGE_WINDOW)
    setInput('')
    setAttachment('')
    setTyping(false)
  }

  // A monotonic counter, not the clock. Two messages appended inside the same
  // millisecond used to share a `Date.now()` id, and these ids are React keys --
  // a collision reconciles the wrong node and leaves the transcript out of order.
  const messageSeq = useRef(0)
  const nextMessageId = (role) => `m${(messageSeq.current += 1)}-${role}`

  /**
   * One turn, with the composer values passed explicitly.
   *
   * `send` reads the composer; the queue dispatches a *held* turn whose values
   * were cleared from state when it was queued, so the core takes them as
   * arguments and `send` stays the zero-argument callback the button and the
   * Enter handler already use.
   */
  const dispatch = (value, att) => {
    if (!value && !att) return
    const text = [value, att ? `Attached: ${att}` : ''].filter(Boolean).join('\n')
    const userId = nextMessageId('user')
    setMessages((current) => [...current, { id: userId, role: 'user', text }])
    setInput('')
    setAttachment('')
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
      { id: userId, role: 'user', text },
    ].map((message) => ({
      role: message.role === 'ai' ? 'assistant' : 'user',
      content: message.text,
    }))

    setTurnSteps([])
    chat({
      messages: history,
      draft: typeof getDraft === 'function' ? getDraft() : '',
      // Each stage the sidecar reports is appended once. The sidecar already
      // drops a repeat of the stage it just emitted; this keeps a step that
      // legitimately happens twice from filling the list twice.
      onStage: ({ step }) => setTurnSteps((current) => (
        current.includes(step) ? current : [...current, step]
      )),
    })
      .then(({ reply, transport, task, sources, wroteDocument }) => {
        setTyping(false)
        // A turn that produced a document belongs in the document. WRITE is the
        // one task whose result is the piece itself; sending it to a bubble
        // leaves the reader with a second copy to paste by hand. REWRITE and
        // CRITIQUE stay in the bubble: one edits a document that is not there to
        // edit, the other is a judgement about one, neither is the piece.
        //
        // `wroteDocument` is the pipeline saying it actually wrote something.
        // A write whose evidence gate blocked every section returns a notice
        // explaining that instead of a document, and the notice stays here in
        // the bubble -- appending it would replace the reader's draft with a
        // warning. An older backend omits the flag, hence `!== false`.
        const wrote = task === 'WRITE' && wroteDocument !== false && typeof onWriteToDocument === 'function'
          ? onWriteToDocument(reply)
          : false
        appendReply({
          id: nextMessageId('ai'),
          role: 'ai',
          text: wrote ? 'Written to the document.' : (reply || 'The assistant returned an empty answer.'),
          status: describeTransport(transport, task),
          sources: Array.isArray(sources) ? sources : [],
          written: wrote,
        })
      })
      .catch((error) => {
        // A failure is reported as itself. Falling back to a canned reply is
        // exactly what made this panel unable to tell the reader anything was
        // ever wrong.
        setTyping(false)
        appendReply({
          id: nextMessageId('ai'),
          role: 'error',
          text: 'I could not answer that.',
          status: describeFailure(error),
        })
      })
  }

  const send = () => {
    const value = input.trim()
    if (!value && !attachment) return
    // A reply in flight holds the next turn instead of racing it: the queue
    // keeps order and the transcript never interleaves two turns. The composer
    // stays live -- typing here means "queued", and the chip above it says so.
    if (typing) {
      setQueued((q) => [...q, { value, attachment }])
      setInput('')
      setAttachment('')
      return
    }
    dispatch(value, attachment)
  }
  dispatchRef.current = dispatch

  // Flush one queued turn the moment the composer goes idle; the rest follow
  // as each turn settles, because dispatching sets `typing` again synchronously.
  useEffect(() => {
    if (typing) return
    const next = queued[0]
    if (!next) return
    setQueued((q) => q.slice(1))
    dispatchRef.current?.(next.value, next.attachment)
  }, [typing, queued])

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

  const plainSendButton = (
    <motion.button className="send-button" type="button" disabled={!input.trim() && !attachment} aria-label="Send message" onClick={send} whileTap={{ scale: 0.94 }} transition={spring}>
      <Icon name="send" size={15} />
    </motion.button>
  )
  // Chromatic at full strength is the Libraries.dev send-button recipe
  // (variant circle + innerShadow); silver at 0.62 was so quiet on the dark
  // theme it read as no effect at all (2026-11-02).
  const decoratedSendButton = canUseMetal ? (
    <MetalFx variant="circle" preset="chromatic" theme={effectTheme} strength={1} innerShadow borderRadius={9} paused={assistantReducedMotion}>
      {plainSendButton}
    </MetalFx>
  ) : (
    plainSendButton
  )

  const composerProps = { input, setInput, send, mode, setMode, attachment, setAttachment, fileRef, runOpen, setRunOpen }

  const runCard = (
    <div className="run-card" role="group" aria-label="Write a thesis">
      <div className="run-head">
        <span className="run-label">Write a thesis</span>
        <span className={`run-state run-${sidecar?.state ?? 'unknown'}`}>{RUN_SIDECAR[sidecar?.state] || 'Checking the writing service'}</span>
      </div>
      <textarea
        className="run-prompt"
        value={runPrompt}
        onChange={(event) => setRunPrompt(event.target.value)}
        aria-label="What the thesis should be about"
        placeholder="Describe the subject. A run takes about ten minutes."
        rows={2}
        disabled={runActive}
      />
      <div className="run-actions">
        <button className="soft-button primary" type="button" disabled={runActive || !runPrompt.trim()} onClick={beginRun}>
          {runActive ? 'Writing' : 'Start writing'}
        </button>
        {runActive && <button className="soft-button" type="button" onClick={stopRun}>Cancel</button>}
        <span className="run-phase" aria-live="polite">{run?.phase}</span>
      </div>
      {(runActive || runSteps.length > 0) && (
        <ThoughtLine
          className="run-thoughts"
          label={`${thoughtVerb}…`}
          doneLabel="Finished"
          steps={runSteps}
          working={runActive}
          fontSize={13}
          collapsible={true}
          collapseOnSettle={false}
          showTimer={true}
          glyph={runSteps.some((s) => /search|research|searxng|compass/i.test(s)) ? 'compass' : runSteps.some((s) => /write|document|build|assemble|section|draft/i.test(s)) ? 'blocks' : 'sparkle'}
        />
      )}
      {run?.error && <p className="run-error" role="alert">{run.error}</p>}
    </div>
  )

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
            <motion.div key={message.id} className={`chat-message ${message.role}${message.run ? ' is-run' : ''}${message.written ? ' is-written' : ''}`} initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={fast}>
              <div className="message-content">
                {message.role === 'ai' && effectsActive && (
                  <EffectBoundary fallback={null}>
                    <span className="message-avatar" aria-hidden="true">
                      <BotAvatar
                        type={message.id === 'welcome' ? 'clover' : 'star'}
                        size={26}
                        face="eyes"
                        state={(typing || runActive) && message.id === messages[messages.length - 1]?.id ? 'working' : 'default'}
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
                  {message.text.split('\n').map((line, index) => (
                    <span key={`${message.id}-${index}`}>{line}{index < message.text.split('\n').length - 1 && <br />}</span>
                  ))}
                </div>
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
          {typing && !runActive && (
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

        {runOpen && runCard}

        {queued.length > 0 && (
          <div className="queued-chip" role="status">
            <Icon name="sort" size={12} />
            <span>{queued.length} queued — sends when this reply finishes</span>
          </div>
        )}
        {attachment && (
          <div className="attachment-chip">
            <Icon name="file" size={12} />
            <span>{attachment}</span>
            <button type="button" aria-label={`Remove ${attachment}`} onClick={() => setAttachment('')}><Icon name="close" size={12} /></button>
          </div>
        )}

        {/* BorderBeam wraps the composer, so the fallback re-renders the same
            component without the beam. */}
        <EffectBoundary fallback={<ChatComposer {...composerProps} sendButton={plainSendButton} />}>
          <BorderBeam className="chat-beam" size="line" colorVariant={effectTheme === 'dark' ? 'ice' : 'ocean'} strength={0.55} active={typing && !assistantReducedMotion} theme={effectTheme} duration={3.2}>
            <ChatComposer {...composerProps} sendButton={decoratedSendButton} />
          </BorderBeam>
        </EffectBoundary>
      </div>
    </aside>
  )
}

export { ChatPanel, FormatToolbar, HIGHLIGHT_TAGS }
