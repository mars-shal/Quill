import { useStore } from '../state/store'
import type { SectionNode } from '../lib/api'

/** Bottom panel: document-wide problems (blocked/failed/warnings) + run log. */
export default function ProblemsPanel() {
  const tab = useStore((s) => s.bottomTab)
  const tree = useStore((s) => s.tree)
  const selectSection = useStore((s) => s.selectSection)
  const toggleBottom = useStore((s) => s.toggleBottom)
  const logs = useStore((s) => s.logs)

  const problems: { sectionId: string; title: string; kind: string; detail: string }[] = []
  const visit = (nodes: SectionNode[]): void => {
    for (const node of nodes) {
      if (node.status === 'blocked') {
        problems.push({ sectionId: node.section_id, title: node.title, kind: 'blocked', detail: 'missing evidence' })
      } else if (node.status === 'failed') {
        problems.push({ sectionId: node.section_id, title: node.title, kind: 'failed', detail: 'generation failed' })
      } else if (node.warning_count > 0) {
        problems.push({ sectionId: node.section_id, title: node.title, kind: 'warnings', detail: `${node.warning_count} warning${node.warning_count > 1 ? 's' : ''}` })
      }
      visit(node.children)
    }
  }
  visit(tree)

  if (tab === 'log') {
    return (
      <div className="problems-body log">
        {logs.length === 0 && <div className="muted">No events yet.</div>}
        {logs.map((line) => (
          <div key={line.id} className="log-line">
            {new Date(line.ts).toLocaleTimeString()} · {line.text}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="problems-body">
      {problems.length === 0 && <div className="muted">No problems. The document looks clean.</div>}
      {problems.map((problem) => (
        <button
          key={problem.sectionId}
          className="problem-row"
          onClick={() => {
            void selectSection(problem.sectionId)
            toggleBottom(false)
          }}
        >
          <span className={`problem-kind ${problem.kind}`}>{problem.kind}</span>
          <span className="problem-title">{problem.title}</span>
          <span className="problem-detail">{problem.detail}</span>
        </button>
      ))}
    </div>
  )
}
