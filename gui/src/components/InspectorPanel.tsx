import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { useStore } from '../state/store'
import type { SectionNode } from '../lib/api'
import { TriangleAlert, Wand2 } from 'lucide-react'

/** Shosho-style readability/stats panel for the open section. */
export default function InspectorPanel() {
  const section = useStore((s) => s.section)
  const project = useStore((s) => s.project)
  const api = useStore((s) => s.api)
  const showToast = useStore((s) => s.showToast)
  const setRun = useStore((s) => s.setRun)
  const run = useStore((s) => s.run)
  const [history, setHistory] = useState<
    { ts: number; label: string; sections: { section_id: string; title: string; model: string }[] }[]
  >([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [formatBusy, setFormatBusy] = useState(false)

  async function autoFormat() {
    if (!api || !project) return
    setFormatBusy(true)
    try {
      const handle = await api.startFormat(project.meta.project_id)
      setRun({
        runId: handle.run_id,
        kind: handle.kind,
        status: 'running',
        ratio: 0,
        sectionId: null,
        statusLabel: 'formatting'
      })
      setFormatBusy(false)
    } catch (error) {
      setFormatBusy(false)
      showToast(`Could not start format: ${String(error)}`)
    }
  }

  const formatting = run?.kind === 'format' && run.status === 'running'

  async function loadHistory() {
    if (!api || !project) return
    try {
      setHistory(await api.getHistory(project.meta.project_id))
    } catch {
      setHistory([])
    }
  }

  useEffect(() => {
    if (historyOpen) void loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, project?.meta.project_id])

  const stats = useMemo(() => {
    const text = section?.text || ''
    const words = text.split(/\s+/).filter(Boolean)
    const sentences = text
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.split(/\s+/).filter(Boolean).length > 0)
    const syllables = words.reduce((total, word) => total + countSyllables(word), 0)
    const wordCount = words.length
    const sentenceCount = Math.max(1, sentences.length)
    const flesch = readability(wordCount, sentenceCount, syllables)
    return {
      words: wordCount,
      sentences: sentences.length,
      chars: text.length,
      readMinutes: Math.max(1, Math.round(wordCount / 200)),
      flesch,
      grade: fleschLabel(flesch),
      longest: sentences.reduce((longest, s) => (s.length > longest.length ? s : longest), '')
    }
  }, [section?.text])

  if (!section || !project) {
    return <div className="inspector-empty">Open a section to see its stats.</div>
  }

  const target = project.tree.length ? findTarget(project.tree, section.section_id) : 0

  return (
    <div className="inspector">
      <div className="inspector-grid">
        <Stat label="Words" value={stats.words.toLocaleString()} />
        <Stat label="Target" value={target ? `${target} w` : '·'} />
        <Stat label="Reading" value={`${stats.readMinutes} min`} />
        <Stat label="Sentences" value={String(stats.sentences)} />
        <Stat label="Characters" value={stats.chars.toLocaleString()} />
        <Stat label="Model" value={section.model || 'manual'} />
      </div>

      <div className="readability">
        <div className="readability-head">
          <span>Readability</span>
          <span className={`readability-grade ${fleschClass(stats.flesch)}`}>{stats.grade}</span>
        </div>
        <div className="readability-bar">
          <div className="readability-fill" style={{ width: `${Math.round(stats.flesch * 100)}%` }} />
        </div>
        {stats.longest.split(/\s+/).length > 35 && (
          <div className="readability-note">
            <TriangleAlert size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            Longest sentence runs {stats.longest.split(/\s+/).length} words. Consider splitting.</div>
        )}
        <button
          className={`auto-format ${formatting ? 'busy' : ''}`}
          onClick={() => void autoFormat()}
          disabled={Boolean(formatting) || formatBusy}
          title="Reformat every section in place with the current model (content-preserving)"
        >
          <motion.span
            className="auto-format-icon"
            animate={formatting ? { rotate: 360 } : { rotate: 0 }}
            transition={formatting ? { repeat: Infinity, duration: 0.9, ease: 'linear' } : { duration: 0.2 }}
          >
            <Wand2 size={13} />
          </motion.span>
          {formatting ? 'Formatting…' : 'Auto format'}
        </button>
      </div>

      {section.status === 'blocked' && (
        <div className="inspector-section">
          <h4>Blocked</h4>
          <div className="check-card warn">
            <span>
              Missing required evidence: {section.missing_fields.join(', ') || 'unknown'}.
              Answer in the Assistant panel, then run again.
            </span>
          </div>
        </div>
      )}
      <div className="inspector-section">
        <h4>Checks ({section.warnings.length})</h4>
        {section.warnings.length === 0 && <div className="muted">No issues in this section.</div>}
        {section.warnings.map((warning, i) => (
          <div key={i} className={`check-card ${severity(warning.code)}`}>
            <span className="check-code">{warning.code}</span>
            <span>{warning.message}</span>
          </div>
        ))}
      </div>

      <div className="inspector-section">
        <h4>
          <button className="link" onClick={() => setHistoryOpen((o) => !o)}>
            History {history.length > 0 && `(${history.length})`} {historyOpen ? '▾' : '▸'}
          </button>
        </h4>
        {historyOpen && (
          <>
            {history.length === 0 && <div className="muted">No restore points yet. One is saved before each AI run and manual overwrite.</div>}
            {history.map((entry) => (
              <div key={entry.ts} className="check-card info">
                <span className="check-code">{new Date(entry.ts * 1000).toLocaleTimeString()}</span>
                <span className="history-meta">
                  {entry.label} · {entry.sections.length} sections
                </span>
                <button
                  className="row-action"
                  title="Restore this snapshot"
                  onClick={async () => {
                    if (!api || !project) return
                    try {
                      const out = await api.restoreHistory(project.meta.project_id, entry.ts)
                      useStore.setState({ project: out, tree: out.tree })
                      showToast('Snapshot restored')
                    } catch (error) {
                      showToast(`Restore failed: ${String(error)}`)
                    }
                  }}
                >
                  restore
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {section.sources.length > 0 && (
        <div className="inspector-section">
          <h4>Sources ({section.sources.length})</h4>
          {section.sources.map((source, i) => (
            <div key={i} className="source-row">
              <span className={`source-kind ${source.kind}`}>{source.kind || 'ref'}</span>
              <span className="source-title" title={source.url}>
                {source.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function findTarget(nodes: SectionNode[], id: string): number {
  for (const node of nodes) {
    if (node.section_id === id) return node.target_words
    const found = findTarget(node.children, id)
    if (found) return found
  }
  return 0
}

function countSyllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!clean) return 0
  const groups = clean.replace(/e$/, '').match(/[aeiouy]+/g)
  return Math.max(1, groups ? groups.length : 1)
}

/** Flesch reading ease normalized to 0..1. */
function readability(words: number, sentences: number, syllables: number): number {
  if (!words) return 0
  const score = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words)
  return Math.min(1, Math.max(0, score / 100))
}

function fleschLabel(score: number): string {
  if (score > 0.7) return 'Easy'
  if (score > 0.5) return 'Standard'
  if (score > 0.3) return 'Difficult'
  return 'Very difficult'
}

function fleschClass(score: number): string {
  if (score > 0.7) return 'good'
  if (score > 0.5) return 'ok'
  return 'bad'
}

function severity(code: string): string {
  if (code === 'too_short' || code === 'placeholder') return 'warn'
  if (code === 'verbatim_copy' || code === 'failed') return 'severe'
  return 'info'
}
