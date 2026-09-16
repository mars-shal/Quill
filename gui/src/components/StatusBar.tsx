import { useStore, DRAFT_ID } from '../state/store'
import { BookOpen, FileText } from 'lucide-react'

export default function StatusBar() {
  const wsOnline = useStore((s) => s.wsOnline)
  const health = useStore((s) => s.health)
  const run = useStore((s) => s.run)
  const saveState = useStore((s) => s.saveState)
  const project = useStore((s) => s.project)
  const section = useStore((s) => s.section)
  const setBottomTab = useStore((s) => s.setBottomTab)
  const selectDraft = useStore((s) => s.selectDraft)
  const exitDraft = useStore((s) => s.exitDraft)

  const provider = health?.providers.find((p) => p.ready) || health?.providers[0]
  const isDraft = section?.section_id === DRAFT_ID
  const words = section?.text.split(/\s+/).filter(Boolean).length ?? 0

  return (
    <footer className="statusbar">
      <span className={`dot ${wsOnline ? 'ok' : 'bad'}`} />
      <span>{wsOnline ? 'engine connected' : 'engine offline'}</span>
      {health && (
        <>
          <span className="sep">·</span>
          <span>
            {provider ? `${provider.name}/${provider.model}` : 'no provider'}
          </span>
        </>
      )}
      <span className="spacer" />
      {section && project && (
        <>
          <button
            className="link view-toggle-bar"
            aria-label={isDraft ? 'Section view' : 'Whole document view'}
            title={
              isDraft
                ? 'Back to editing one section'
                : 'Scroll and edit the whole document in one page'
            }
            onClick={() => void (isDraft ? exitDraft() : selectDraft())}
          >
            {isDraft ? <FileText size={13} /> : <BookOpen size={13} />}
          </button>
          <span className={`chip status-${section.status}`}>{section.status}</span>
          <span className="sep">·</span>
          <span>{words.toLocaleString()} words</span>
          <span className="sep">·</span>
        </>
      )}
      {project && (
        <>
          <button className="link" onClick={() => setBottomTab('problems')}>
            {project.meta.blocked + project.meta.failed > 0
              ? `${project.meta.blocked + project.meta.failed} problem${project.meta.blocked + project.meta.failed > 1 ? 's' : ''}`
              : 'no problems'}
          </button>
          <span className="sep">·</span>
        </>
      )}
      <span>{run?.status === 'running' ? `${run.kind} · ${Math.round(run.ratio * 100)}%` : 'idle'}</span>
      <span className="sep">·</span>
      <span>{saveState === 'dirty' ? 'unsaved changes' : saveState === 'saving' ? 'saving…' : 'saved'}</span>
    </footer>
  )
}
