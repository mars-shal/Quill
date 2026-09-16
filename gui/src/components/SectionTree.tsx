import { useState } from 'react'
import { Plus, Pencil, X, PenLine, FolderOpen, ChevronLeft } from 'lucide-react'
import IconButton from './IconButton'
import { useStore } from '../state/store'
import type { SectionNode as Node } from '../lib/api'
import { Circle, CircleDashed, Ban, XCircle } from 'lucide-react'
import { pickSourceFile } from '../lib/native'

const STATUS_GLYPH: Record<Node['status'], typeof Circle> = {
  generated: Circle,
  pending: CircleDashed,
  blocked: Ban,
  failed: XCircle
}

export default function SectionTree() {
  const tree = useStore((s) => s.tree)
  const project = useStore((s) => s.project)
  const projects = useStore((s) => s.projects)
  const selectedId = useStore((s) => s.selectedId)
  const selectSection = useStore((s) => s.selectSection)
  const selectDraft = useStore((s) => s.selectDraft)
  const openProject = useStore((s) => s.openProject)
  const openFilePath = useStore((s) => s.openFilePath)
  const addSection = useStore((s) => s.addSection)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  async function openSourceFile() {
    const filePath = await pickSourceFile()
    if (filePath) await openFilePath(filePath)
  }

  if (!project) {
    return (
      <div className="tree-empty">
        <button className="doc-open" onClick={() => void openSourceFile()}>
          <FolderOpen size={14} /> Open source file…
        </button>
        <div className="pane-label">Documents</div>
        {projects.map((p) => (
          <button key={p.project_id} className="doc-item" onClick={() => void openProject(p.project_id)}>
            {p.title}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="tree">
      <div className="pane-label-row">
        <div className="pane-label">{project.meta.title}</div>
        <IconButton icon={ChevronLeft} label="Collapse sections" spinOnHover onClick={() => toggleSidebar(true)} size={13} />
      </div>
      <ProgressRow />
      <div className="tree-items">
        {tree.map((node) => (
          <TreeItem
            key={node.section_id}
            node={node}
            depth={0}
            selectedId={selectedId}
            onSelect={selectSection}
            lastRootId={tree[tree.length - 1]?.section_id ?? null}
          />
        ))}
      </div>
      <div className="tree-actions">
        <button className="tree-add" onClick={() => void addSection(null, null, 'New section')}>
          <Plus size={14} /> Section
        </button>
        <button
          className={`tree-add ${selectedId === '__draft__' ? 'active' : ''}`}
          onClick={() => void selectDraft()}
          title="Write the whole document as plain text. Headings stay text"
        >
          <PenLine size={14} /> Draft
        </button>
      </div>
    </div>
  )
}

function ProgressRow() {
  const project = useStore((s) => s.project)
  if (!project) return null
  const { meta } = project
  const done = meta.generated + meta.blocked + meta.failed
  const ratio = meta.section_count ? done / meta.section_count : 0
  return (
    <div className="progress-row">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <div className="progress-caption">
        {done}/{meta.section_count} sections · {meta.total_words.toLocaleString()} words
      </div>
    </div>
  )
}

function TreeItem({
  node,
  depth,
  selectedId,
  onSelect,
  lastRootId
}: {
  node: Node
  depth: number
  selectedId: string | null
  onSelect: (id: string) => void
  lastRootId: string | null
}) {
  const addSection = useStore((s) => s.addSection)
  const renameSection = useStore((s) => s.renameSection)
  const deleteSection = useStore((s) => s.deleteSection)
  const [editing, setEditing] = useState<null | 'rename' | 'child'>(null)
  const [draftTitle, setDraftTitle] = useState('')

  function commit(kind: 'rename' | 'child') {
    const value = draftTitle.trim()
    setEditing(null)
    setDraftTitle('')
    if (!value) return
    if (kind === 'rename') void renameSection(node.section_id, value)
    else void addSection(node.section_id, null, value)
  }

  if (editing !== null) {
    return (
      <div className="tree-branch">
        <div className="tree-item editing" style={{ paddingLeft: 8 + depth * 14 }}>
          <input
            autoFocus
            className="tree-rename-input"
            value={draftTitle}
            placeholder={editing === 'rename' ? node.title : 'New sub-section…'}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(editing)
              if (e.key === 'Escape') {
                setEditing(null)
                setDraftTitle('')
              }
            }}
            onBlur={() => commit(editing)}
          />
        </div>
        {node.children.map((child) => (
          <TreeItem
            key={child.section_id}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            onSelect={onSelect}
            lastRootId={lastRootId}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="tree-branch">
      <div
        className={`tree-row ${selectedId === node.section_id ? 'selected' : ''}`}
        onClick={() => onSelect(node.section_id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSelect(node.section_id)
        }}
      >
        <span className="tree-item" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className={`glyph ${node.status}`}>
            {(() => {
              const Glyph = STATUS_GLYPH[node.status]
              return <Glyph size={11} strokeWidth={2.4} />
            })()}
          </span>
          <span className="tree-item-title">{node.title}</span>
          {node.warning_count > 0 && <span className="warn-badge">{node.warning_count}</span>}
        </span>
        <span className="tree-row-actions">
          <button
            className="row-action"
            title="Add sub-section"
            onClick={(e) => {
              e.stopPropagation()
              setDraftTitle('')
              setEditing('child')
            }}
          >
            <Plus size={13} />
          </button>
          <button
            className="row-action"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation()
              setDraftTitle(node.title)
              setEditing('rename')
            }}
          >
            <Pencil size={13} />
          </button>
          <button
            className="row-action danger"
            title="Delete section"
            onClick={(e) => {
              e.stopPropagation()
              if (window.confirm(`Delete “${node.title}”?`)) void deleteSection(node.section_id)
            }}
          >
            <X size={13} />
          </button>
        </span>
      </div>
      {node.children.map((child) => (
        <TreeItem
          key={child.section_id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          lastRootId={lastRootId}
        />
      ))}
      {depth === 0 && lastRootId !== null && node.section_id === lastRootId && (
        <button
          className="tree-insert"
          style={{ marginLeft: 8 + depth * 14 + 22 }}
          onClick={() => void addSection(null, lastRootId, 'New section')}
          title="Add a chapter after this one"
        >
          <Plus size={14} /> chapter
        </button>
      )}
    </div>
  )
}
