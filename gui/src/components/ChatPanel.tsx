import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ListTree, Sparkles, RefreshCw, ArrowRight, MessageSquareQuote, Send, Square, ChevronDown } from 'lucide-react'
import { useStore, type RunState } from '../state/store'

type AssistMode = 'write' | 'rewrite' | 'continue' | 'critique' | 'structure'

const MODES: { id: AssistMode; icon: typeof Sparkles; label: string; desc: string; title: string }[] = [
  {
    id: 'write',
    icon: Sparkles,
    label: 'Write',
    desc: 'Draft the full document from your prompt',
    title: 'Generate the full document from your prompt'
  },
  {
    id: 'rewrite',
    icon: RefreshCw,
    label: 'Rewrite',
    desc: 'Rework the open section per your instructions',
    title: 'Rewrite the open section per your instructions'
  },
  {
    id: 'continue',
    icon: ArrowRight,
    label: 'Continue',
    desc: 'Keep writing the open section from where it ends',
    title: 'Continue writing the open section from where it ends'
  },
  {
    id: 'critique',
    icon: MessageSquareQuote,
    label: 'Critique',
    desc: 'Get concrete feedback on the open section',
    title: 'Get concrete feedback on the open section'
  },
  {
    id: 'structure',
    icon: ListTree,
    label: 'Structure',
    desc: 'Reorganize the document: create, rename, delete sections',
    title: 'Reorganize the document per your instructions'
  }
]

const CONTINUE_INSTRUCTION =
  'Continue writing this section from where it ends. Do not repeat existing text; pick up mid-flow.'
const CRITIQUE_INSTRUCTION =
  'Critique the current section: list its concrete weaknesses (structure, evidence, clarity, tone) and how to fix each one.'

const STEP_LABELS: Record<string, string> = {
  starting: 'Starting…',
  research: 'Researching sources…',
  searching: 'Searching the web…',
  researching: 'Building knowledge graph…',
  thinking: 'Thinking…',
  writing: 'Writing…',
  proofreading: 'Proofreading…',
  generating: 'Writing…',
  skipped: 'Skipping…',
  blocked: 'Blocked, needs evidence',
  failed: 'Failed',
  formatting: 'Formatting…',
  restructuring: 'Restructuring outline…',
  'stopping…': 'Stopping…'
}

function stepLabel(run: RunState): string {
  const [status, short] = (run.statusLabel || 'starting').split(' ')
  const label = STEP_LABELS[status] ?? status
  return short ? `${label} ${short}` : label
}

interface ModelEntry {
  name: string
  model: string
  models: string[]
  ready: boolean
  local: boolean
}

export default function ChatPanel() {
  const chat = useStore((s) => s.chat)
  const addChat = useStore((s) => s.addChat)
  const api = useStore((s) => s.api)
  const project = useStore((s) => s.project)
  const section = useStore((s) => s.section)
  const run = useStore((s) => s.run)
  const setRun = useStore((s) => s.setRun)
  const showToast = useStore((s) => s.showToast)

  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AssistMode>('write')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelOptions, setModelOptions] = useState<ModelEntry[] | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const toggleSettings = useStore((s) => s.toggleSettings)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [chat])

  const running = run?.status === 'running'
  const projectId = project?.meta.project_id
  const canTargetSection = section != null && section.section_id !== '__draft__'
  const provider = useStore((s) => s.health?.providers.find((p) => p.ready) ?? s.health?.providers[0] ?? null)
  const storeHealth = useStore((s) => s.health)
  const providerLabel = provider ? `${provider.name} · ${provider.model}` : 'no model'

  async function launch(kind: 'run' | 'rewrite' | 'restructure', instruction: string, sectionIds: string[]) {
    if (!api || !projectId) return
    try {
      const handle =
        kind === 'run'
          ? await api.startRun(projectId, instruction)
          : kind === 'rewrite'
            ? await api.startRewrite(projectId, instruction, sectionIds)
            : await api.startRestructure(projectId, instruction)
      setRun({
        runId: handle.run_id,
        kind: handle.kind,
        status: 'running',
        ratio: 0,
        sectionId: sectionIds[0] ?? null,
        statusLabel: 'starting'
      })
    } catch (error) {
      addChat('error', `Could not start: ${String(error)}`)
    }
  }

  async function cancel() {
    if (!run) return
    try {
      await api?.cancelRun(run.runId)
    } catch (error) {
      showToast(`Cancel failed: ${String(error)}`)
    }
  }

  function submit() {
    const text = input.trim()
    if (running) return

    if (mode === 'write') {
      if (!text) return
      addChat('user', text)
      setInput('')
      void launch('run', text, [])
      return
    }

    if (mode === 'structure') {
      if (!text) return
      addChat('user', text)
      setInput('')
      void launch('restructure', text, [])
      return
    }

    if (!canTargetSection) {
      addChat('error', 'Open a section first: this mode works on the section in the editor.')
      return
    }
    const instruction =
      mode === 'continue' ? CONTINUE_INSTRUCTION : mode === 'critique' ? CRITIQUE_INSTRUCTION : text
    if (mode !== 'rewrite' && text) {
      addChat('user', text)
      setInput('')
    } else if (text) {
      addChat('user', text)
      setInput('')
    }
    void launch('rewrite', instruction, [section!.section_id])
  }

  const placeholder =
    mode === 'write'
      ? 'Describe the document to write…'
      : mode === 'rewrite'
        ? 'How should this section change?'
        : mode === 'continue'
          ? 'Anything to emphasize? (optional)'
          : mode === 'structure'
            ? 'How should the document be reorganized?'
            : 'Anything specific to critique? (optional)'

  const currentMode = MODES.find((m) => m.id === mode)!

  return (
    <div className="chat-panel">
      <div className="chat-log" ref={scroller}>
        {chat.length === 0 && (
          <div className="chat-hint">
            Ask anything. “Write” drafts the whole document from a description; the other
            modes work on the section open in the editor, and the AI types its output
            live into the editor. Esc stops a run.
          </div>
        )}
        {chat.map((message) => (
          <motion.div
            key={message.id}
            className={`chat-msg ${message.role}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {message.text}
          </motion.div>
        ))}
        {running && run && (
          <div className="chat-msg system running shimmer">
            <span className="run-step">{stepLabel(run)}</span>
            <button className="ghost cancel" onClick={() => void cancel()}>
              Stop
            </button>
          </div>
        )}
      </div>
      {section?.status === 'blocked' && <EvidenceForm />}
      <div className="composer">
        <div className="composer-pill">
          <div className="mode-menu-wrap">
            <button
              className="composer-mode"
              title={`${currentMode.label} · ${currentMode.desc}`}
              aria-label={`Mode: ${currentMode.label}`}
              disabled={running}
              onClick={() => setModeMenuOpen((o) => !o)}
            >
              <span className="mode-icon"><currentMode.icon size={14} strokeWidth={2.2} /></span>
              <span className="mode-name">{currentMode.label}</span>
              <span className="mode-caret"><ChevronDown size={11} /></span>
            </button>
            {modeMenuOpen && (
              <div className="mode-menu" onMouseLeave={() => setModeMenuOpen(false)}>
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    title={m.title}
                    className={`mode-option ${mode === m.id ? 'active' : ''}`}
                    onClick={() => {
                      setMode(m.id)
                      setModeMenuOpen(false)
                    }}
                  >
                    <span className="mode-icon"><m.icon size={14} strokeWidth={2.2} /></span>
                    <span>
                      <span className="mode-option-label">{m.label}</span>
                      <span className="mode-option-desc">{m.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <textarea
            rows={1}
            placeholder={running ? 'Run in progress…' : placeholder}
            value={input}
            disabled={running}
            onChange={(e) => {
              setInput(e.target.value)
              const el = e.target as HTMLTextAreaElement
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          {running ? (
            <button className="composer-send stop" title="Stop (Esc)" onClick={() => void cancel()}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              className="composer-send"
              title="Send (Enter)"
              disabled={(mode === 'write' || mode === 'structure') && !input.trim()}
              onClick={submit}
            >
              <Send size={14} />
            </button>
          )}
        </div>
        <div className="composer-footer">
          <button
            className="composer-model"
            title="Switch model"
            onClick={async () => {
              if (!api || modelMenuOpen) {
                setModelMenuOpen(false)
                return
              }
              setModelMenuOpen(true)
              try {
                const out = await api.getModels()
                setModelOptions(out.providers)
              } catch {
                setModelOptions([])
              }
            }}
          >
            {providerLabel}
            <ChevronDown size={11} />
          </button>
          {modelMenuOpen && (
            <div className="model-menu" onMouseLeave={() => setModelMenuOpen(false)}>
              {(modelOptions ?? []).map((entry) => (
                <div key={entry.name} className="model-group">
                  <div className="model-group-label">
                    {entry.name}
                    {entry.local ? ' · local' : entry.ready ? '' : ' · no key'}
                  </div>
                  {entry.models.length > 0 && (
                    <select
                      className="model-select"
                      value={provider?.name === entry.name && entry.models.includes(provider.model) ? provider.model : ''}
                      disabled={!entry.ready}
                      onChange={async (e) => {
                        const model = e.target.value
                        if (!api || !model) return
                        try {
                          await api.selectModel(entry.name, model)
                          await useStore.getState().refreshHealth()
                          addChat('system', `Model set to ${entry.name} · ${model}.`)
                        } catch (error) {
                          showToast(`Could not switch model: ${String(error)}`)
                        }
                        setModelMenuOpen(false)
                      }}
                    >
                      <option value="" disabled>
                        {entry.ready ? (provider?.name === entry.name ? provider.model : `select ${entry.name} model…`) : 'no API key'}
                      </option>
                      {entry.models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
              {modelOptions === null && <div className="model-option muted">loading…</div>}
              <button
                className="model-option muted"
                title="Add or manage AI providers"
                onClick={() => toggleSettings()}
              >
                <span className="model-option-name">Configure providers…</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function EvidenceForm() {
  const section = useStore((s) => s.section)
  const api = useStore((s) => s.api)
  const project = useStore((s) => s.project)
  const showToast = useStore((s) => s.showToast)
  const addChat = useStore((s) => s.addChat)
  const [answers, setAnswers] = useState<Record<string, string>>({})

  if (!section || !project) return null
  const fields = section.missing_fields.filter(Boolean)
  if (fields.length === 0) return null

  return (
    <div className="evidence-form">
      <div className="evidence-title">Missing evidence · “{section.title}”</div>
      {fields.map((field) => (
        <label key={field}>
          <span>{humanize(field)}</span>
          <input
            value={answers[field] || ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [field]: e.target.value }))}
          />
        </label>
      ))}
      <button
        className="primary"
        onClick={async () => {
          if (!api) return
          try {
            await api.saveEvidence(project.meta.project_id, answers)
            addChat('system', 'Evidence saved. Run again to write the blocked sections.')
            setAnswers({})
          } catch (error) {
            showToast(`Could not save evidence: ${String(error)}`)
          }
        }}
      >
        Save answers
      </button>
    </div>
  )
}

function humanize(field: string): string {
  return field.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}
