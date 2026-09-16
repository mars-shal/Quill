import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import CharacterCount from '@tiptap/extension-character-count'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import { Markdown } from 'tiptap-markdown'
import { useStore, DRAFT_ID } from '../state/store'
import {
  Highlighter, Eraser, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, Quote, Code2, Minus, Undo2, Redo2, CornerDownLeft, X,
  Table2, Columns2, Rows2, Trash2
} from 'lucide-react'

const AUTOSAVE_MS = 800

const QUILL_ASCII = String.raw`______   __    __  ______  __        __       
 /      \ |  \  |  \|      \|  \      |  \      
|  $$$$$$\| $$  | $$ \$$$$$$| $$      | $$      
| $$  | $$| $$  | $$  | $$  | $$      | $$      
| $$  | $$| $$  | $$  | $$  | $$      | $$      
| $$ _| $$| $$  | $$  | $$  | $$      | $$      
| $$/ \ $$| $$__/ $$ _| $$_ | $$_____ | $$_____ 
 \$$ $$ $$ \$$    $$|   $$ \| $$     \| $$     \
  \$$$$$$\  \$$$$$$  \$$$$$$ \$$$$$$$$ \$$$$$$$$
      \$$$ `

const HIGHLIGHT_COLORS = [
  { color: '#fef08a', name: 'yellow' },
  { color: '#bbf7d0', name: 'green' },
  { color: '#bfdbfe', name: 'blue' },
  { color: '#fbcfe8', name: 'pink' }
]

export default function EditorPane() {
  const section = useStore((s) => s.section)
  const liveText = useStore((s) => s.liveText)
  const saveState = useStore((s) => s.saveState)
  const selectedId = useStore((s) => s.selectedId)
  const setSaveState = useStore((s) => s.setSaveState)
  const saveSectionText = useStore((s) => s.saveSectionText)
  const suggestion = useStore((s) => s.suggestion)
  const requestSuggestion = useStore((s) => s.requestSuggestion)
  const clearSuggestion = useStore((s) => s.clearSuggestion)
  const renameSectionAction = useStore((s) => s.renameSection)
  const renameProjectAction = useStore((s) => s.renameProject)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const lastLoadedRef = useRef<string | null>(null)
  const suppressUpdate = useRef(false)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: true }),
      CharacterCount,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown
    ],
    content: '',
    editorProps: {
      attributes: { class: 'prose-editor', spellcheck: 'true' }
    },
    onUpdate({ editor }) {
      if (!editor || suppressUpdate.current) return
      dirtyRef.current = true
      setSaveState('dirty')
      clearSuggestion()
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void saveSectionText(editor.storage.markdown.getMarkdown())
      }, AUTOSAVE_MS)

      // Idle → ask the sidecar for a one-sentence continuation.
      const { selection, doc } = editor.state
      if (!selection.empty) return
      const before = doc.textBetween(Math.max(0, selection.from - 2000), selection.from, '\n', ' ')
      const after = doc.textBetween(selection.to, Math.min(doc.content.size, selection.to + 400), '\n', ' ')
      requestSuggestion(before, after)
    }
  })

  // When a run finishes, the AI's fresh text wins: drop the dirty guard so
  // the refreshed section (typed in live during the run) loads into the editor.
  const runStatus = useStore((s) => s.run?.status ?? null)
  const prevRunStatus = useRef<string | null>(null)
  useEffect(() => {
    if (runStatus && runStatus !== 'running' && prevRunStatus.current === 'running') {
      dirtyRef.current = false
      lastLoadedRef.current = null
    }
    prevRunStatus.current = runStatus
  }, [runStatus])

  // Accept the ghost suggestion with Tab.
  useEffect(() => {
    if (!editor) return
    ;(window as unknown as Record<string, unknown>).__quillEditor = editor
    const dom = editor.view.dom
    const onKeyDown = (event: KeyboardEvent) => {
      const current = useStore.getState().suggestion
      if (event.key === 'Tab' && current) {
        event.preventDefault()
        editor.chain().focus().insertContent(current + ' ').run()
        clearSuggestion()
      }
    }
    dom.addEventListener('keydown', onKeyDown, true)
    return () => dom.removeEventListener('keydown', onKeyDown, true)
  }, [editor, clearSuggestion])

  // Load a section's text when the selection (or streamed text) changes.
  useEffect(() => {
    if (!editor || !section) return
    const streamed = liveText[section.section_id]
    const target = streamed ?? section.text ?? ''
    if (dirtyRef.current && selectedId === section.section_id) return // user edits win
    if (target === lastLoadedRef.current) return
    suppressUpdate.current = true
    editor.commands.setContent(target)
    lastLoadedRef.current = target
    dirtyRef.current = false
    setSaveState('clean')
    // setTimeout, NOT requestAnimationFrame: rAF never fires in background
    // tabs/windows, which would leave the suppress flag stuck on forever.
    setTimeout(() => {
      suppressUpdate.current = false
    }, 0)
  }, [editor, section, selectedId, liveText, setSaveState])

  // Reset edit-tracking when switching sections.
  useEffect(() => {
    dirtyRef.current = false
    lastLoadedRef.current = null
  }, [selectedId])

  if (!section) {
    return (
      <div className="editor-empty">
        <pre className="quill-art" aria-hidden="true">{QUILL_ASCII}</pre>
        <p>Ready when you are.</p>
        <div className="editor-empty-actions">
          <button
            className="primary"
            disabled={!editor && !useStore.getState().tree.length}
            onClick={() => void useStore.getState().autoSelectWritingSpot()}
          >
            Start writing
          </button>
          <button onClick={() => void useStore.getState().selectDraft()}>Open whole document</button>
        </div>
      </div>
    )
  }

  return (
    <div className="editor-pane">
      {editor && <EditorToolbar editor={editor} />}
      {suggestion && (
        <div className="suggestion-chip" role="status">
          <span className="suggestion-ghost" title={suggestion}>
            {suggestion}
          </span>
          <span className="suggestion-hint">Tab ↹</span>
          <button
            className="row-action"
            title="Insert suggestion"
            onClick={() => {
              editor?.chain().focus().insertContent(suggestion + ' ').run()
              clearSuggestion()
            }}
          >
            <CornerDownLeft size={13} />
          </button>
          <button className="row-action" title="Dismiss" onClick={clearSuggestion}>
            <X size={13} />
          </button>
        </div>
      )}
      <div className="editor-header">
        <EditableTitle
          title={section.title}
          isDraft={section.section_id === DRAFT_ID}
          onRename={(title) =>
            section.section_id === DRAFT_ID
              ? void renameProjectAction(title)
              : void renameSectionAction(section.section_id, title)
          }
        />
        <div className="editor-meta">
          {section.model && section.model !== 'manual' && <span className="chip">{section.model}</span>}
          <span className={`save-state ${saveState}`}>
            {saveState === 'saving'
              ? 'saving…'
              : saveState === 'dirty'
                ? 'unsaved'
                : saveState === 'saved'
                  ? 'saved'
                  : ''}
          </span>
        </div>
      </div>
      {section.description && <p className="editor-brief">{section.description}</p>}
      <EditorContent editor={editor} className="editor-scroll" />
    </div>
  )
}

type ToolIcon = typeof Highlighter
type Tool =
  | { kind: 'command'; label?: string; icon?: ToolIcon; title: string; active?: () => boolean; run: () => void; colorKey?: string; iconColor?: string }
  | { kind: 'sep' }

function buildTools(editor: Editor): Tool[] {
  const cmd = (
    label: string,
    title: string,
    run: () => void,
    active?: () => boolean
  ): Tool => ({ kind: 'command', label, title, run, active })

  const highlightColors: Tool[] = HIGHLIGHT_COLORS.map((c) => ({
    kind: 'command',
    label: '●',
    title: `Highlight ${c.name}`,
    colorKey: c.color,
    active: () => editor.isActive('highlight', { color: c.color }),
    run: () => editor.chain().focus().toggleHighlight({ color: c.color }).run()
  }))

  return [
    cmd('H1', 'Heading 1', () => editor.chain().focus().toggleHeading({ level: 1 }).run(), () =>
      editor.isActive('heading', { level: 1 })
    ),
    cmd('H2', 'Heading 2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), () =>
      editor.isActive('heading', { level: 2 })
    ),
    cmd('H3', 'Heading 3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), () =>
      editor.isActive('heading', { level: 3 })
    ),
    { kind: 'sep' },
    cmd('B', 'Bold (Ctrl+B)', () => editor.chain().focus().toggleBold().run(), () => editor.isActive('bold')),
    cmd('I', 'Italic (Ctrl+I)', () => editor.chain().focus().toggleItalic().run(), () => editor.isActive('italic')),
    cmd('U', 'Underline (Ctrl+U)', () => editor.chain().focus().toggleUnderline().run(), () =>
      editor.isActive('underline')
    ),
    cmd('S', 'Strikethrough', () => editor.chain().focus().toggleStrike().run(), () => editor.isActive('strike')),
    { kind: 'sep' },
    { kind: 'command', icon: Highlighter, title: 'Highlight', active: () => editor.isActive('highlight'), run: () => editor.chain().focus().toggleHighlight().run() },
    ...highlightColors,
    { kind: 'command', icon: Eraser, title: 'Remove highlight', run: () => editor.chain().focus().unsetHighlight().run() },
    { kind: 'sep' },
    { kind: 'command', icon: AlignLeft, title: 'Align left', active: () => editor.isActive({ textAlign: 'left' }), run: () => editor.chain().focus().setTextAlign('left').run() },
    { kind: 'command', icon: AlignCenter, title: 'Align center', active: () => editor.isActive({ textAlign: 'center' }), run: () => editor.chain().focus().setTextAlign('center').run() },
    { kind: 'command', icon: AlignRight, title: 'Align right', active: () => editor.isActive({ textAlign: 'right' }), run: () => editor.chain().focus().setTextAlign('right').run() },
    { kind: 'command', icon: AlignJustify, title: 'Justify', active: () => editor.isActive({ textAlign: 'justify' }), run: () => editor.chain().focus().setTextAlign('justify').run() },
    { kind: 'sep' },
    { kind: 'command', icon: List, title: 'Bullet list', active: () => editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { kind: 'command', icon: ListOrdered, title: 'Numbered list', active: () => editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
    { kind: 'command', icon: Quote, title: 'Blockquote', active: () => editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
    { kind: 'command', icon: Code2, title: 'Code block', active: () => editor.isActive('codeBlock'), run: () => editor.chain().focus().toggleCodeBlock().run() },
    { kind: 'command', icon: Minus, title: 'Horizontal rule', run: () => editor.chain().focus().setHorizontalRule().run() },
    { kind: 'sep' },
    { kind: 'command', icon: Table2, title: 'Insert table', run: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { kind: 'command', icon: Columns2, title: 'Add column after', run: () => editor.chain().focus().addColumnAfter().run() },
    { kind: 'command', icon: Rows2, title: 'Add row after', run: () => editor.chain().focus().addRowAfter().run() },
    cmd('c−', 'Delete column', () => editor.chain().focus().deleteColumn().run()),
    cmd('r−', 'Delete row', () => editor.chain().focus().deleteRow().run()),
    { kind: 'command', icon: Table2, title: 'Toggle header row', active: () => editor.isActive('tableHeader'), run: () => editor.chain().focus().toggleHeaderRow().run() },
    { kind: 'command', icon: Trash2, title: 'Delete table', run: () => editor.chain().focus().deleteTable().run() },
    { kind: 'sep' },
    { kind: 'command', icon: Undo2, title: 'Undo (Ctrl+Z)', run: () => editor.chain().focus().undo().run() },
    { kind: 'command', icon: Redo2, title: 'Redo (Ctrl+Shift+Z)', run: () => editor.chain().focus().redo().run() }
  ]
}

function EditorToolbar({ editor }: { editor: Editor }) {
  const tools = buildTools(editor)
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
      {tools.map((tool, i) =>
        tool.kind === 'sep' ? (
          <span key={i} className="toolbar-sep" />
        ) : (
          <button
            key={i}
            className={`toolbar-btn ${tool.active?.() ? 'active' : ''}`}
            title={tool.title}
            aria-label={tool.title}
            aria-pressed={tool.active?.() ?? false}
            onMouseDown={(e) => e.preventDefault()} // keep text selection
            onClick={tool.run}
          >
            {tool.icon ? <tool.icon size={14} strokeWidth={2.2} /> : tool.colorKey
              ? <span className="color-dot" style={{ background: tool.colorKey }} />
              : tool.label}
          </button>
        )
      )}
    </div>
  )
}

function EditableTitle({
  title,
  isDraft,
  onRename
}: {
  title: string
  isDraft: boolean
  onRename: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)

  function commit() {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed && trimmed !== title) onRename(trimmed)
    else setValue(title)
  }

  if (editing) {
    return (
      <input
        autoFocus
        className="editor-title-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setValue(title)
            setEditing(false)
          }
        }}
        onBlur={commit}
      />
    )
  }

  return (
    <h2
      className="editor-title"
      title={isDraft ? 'Click to rename the document' : 'Click to rename this section'}
      onClick={() => {
        setValue(title.replace(/ \(draft\)$/, ''))
        setEditing(true)
      }}
    >
      {title}
    </h2>
  )
}

function StatusChip({ status }: { status: string }) {
  return <span className={`chip status-${status}`}>{status}</span>
}
