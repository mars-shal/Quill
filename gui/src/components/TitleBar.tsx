import { useEffect, useState } from 'react'
import { Feather, Home, Focus, Settings } from 'lucide-react'
import IconButton from './IconButton'
import { useStore } from '../state/store'
import { pickSourceFile } from '../lib/native'

export default function TitleBar() {
  const project = useStore((s) => s.project)
  const api = useStore((s) => s.api)
  const openFilePath = useStore((s) => s.openFilePath)
  const newDoc = useStore((s) => s.newDoc)
  const exitToLibrary = useStore((s) => s.exitToLibrary)
  const showToast = useStore((s) => s.showToast)
  const toggleSettings = useStore((s) => s.toggleSettings)

  const [focus, setFocus] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  useEffect(() => {
    if (project) setFocus(false)
  }, [project])

  useEffect(() => {
    // Library is always zen (no IDE chrome); projects follow the user toggle.
    document.body.classList.toggle('focus-mode', focus || !project)
  }, [focus, project])

  async function exportDoc(fmt: 'md' | 'docx' | 'pdf') {
    if (!api || !project) return
    try {
      const path = await api.export(project.meta.project_id, fmt)
      showToast(`Exported → ${path}`)
    } catch (error) {
      showToast(`Export failed: ${String(error)}`)
    }
  }

  const EXPORT_FORMATS: { fmt: 'md' | 'docx' | 'pdf'; label: string }[] = [
    { fmt: 'md', label: 'Markdown' },
    { fmt: 'docx', label: 'DOCX' },
    { fmt: 'pdf', label: 'PDF' }
  ]

  return (
    <header className="titlebar">
      <button
        className="brand"
        title={project ? 'Back to library' : 'Library'}
        onClick={() => exitToLibrary()}
      >
        {project ? (
          <span className="brand-mark"><Home size={15} strokeWidth={2.2} /></span>
        ) : (
          <>
            <span className="brand-mark"><Feather size={15} strokeWidth={2.2} /></span> Quill
          </>
        )}
      </button>
      <div className="project-title">{project?.meta.title ?? ''}</div>
      <div className="titlebar-actions">
        <button
          onClick={async () => {
            const filePath = await pickSourceFile()
            if (filePath) await openFilePath(filePath)
          }}
        >
          Open…
        </button>
        <button onClick={() => void newDoc()}>New</button>
        <span className="divider" />
        <div className="font-settings">
          <button disabled={!project} onClick={() => setExportOpen((o) => !o)}>
            Export ▾
          </button>
          {exportOpen && (
            <div className="font-popover" onMouseLeave={() => setExportOpen(false)}>
              <div className="font-popover-label">Format</div>
              {EXPORT_FORMATS.map((f) => (
                <button
                  key={f.fmt}
                  className="font-option"
                  onClick={() => {
                    setExportOpen(false)
                    void exportDoc(f.fmt)
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="divider" />
        <IconButton
          icon={Settings}
          label="Settings"
          spinOnHover
          onClick={() => toggleSettings()}
          size={15}
        />
        <button
          className={`ghost mode-toggle ${focus ? 'active' : ''}`}
          title="Zen mode: hide everything but the page"
          aria-pressed={focus}
          onClick={() => setFocus((f) => !f)}
        >
          <Focus size={15} />
        </button>
      </div>
    </header>
  )
}