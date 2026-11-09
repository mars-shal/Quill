import React, { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Icon } from './Icon.jsx'
import { PROVIDER_PRESETS } from './library/SettingsPage.jsx'

/**
 * The first-run sequence.
 *
 * A release install starts with an empty library, so this is the first thing a
 * reader sees. It is a full-window surface rather than a card over the library:
 * the theme choice changes the whole room, and the model choice is a decision
 * about the app, not a dialog over a document.
 *
 * The three steps are deliberate:
 *
 *   1. the mark, and one way in
 *   2. what the room looks like
 *   3. what answers when the reader asks it to write
 *
 * Everything is skippable. A local-first editor is a perfectly good offline
 * editor, and a first-run flow that traps someone without a model is worse than
 * no flow at all. `completed` is written only when the reader actually leaves,
 * and "Add an API key" opens Settings without marking the flow complete; when
 * Settings closes, this surface is still here.
 */

const STEPS = 3

const THEME_FACE = { light: 'Sun', paper: 'Paper', night: 'Moon' }
const THEME_NOTE = { light: 'Bright room', paper: 'Warm paper', night: 'Low light' }

function themeFace(option) {
  return THEME_FACE[option.id] || option.name
}

function themeNote(option) {
  return THEME_NOTE[option.id] || (option.mode === 'dark' ? 'Low light' : 'Bright room')
}

/** The feather strokes itself when the welcome step mounts. */
function DrawnQuill({ reduced }) {
  const draw = (delay) => ({
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: reduced
        ? { duration: 0 }
        : { pathLength: { duration: 0.18, delay, ease: 'easeInOut' }, opacity: { duration: 0.12, delay } },
    },
  })

  return (
    <svg className="onboarding-v2-quill" viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <motion.path
        d="M11 61C21 43 35 24 62 10C58 34 45 52 24 58"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        variants={draw(0.12)}
        initial="hidden"
        animate="visible"
      />
      <motion.path
        d="M11 61L4 68"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        variants={draw(0.42)}
        initial="hidden"
        animate="visible"
      />
      <motion.path
        d="M24 58L39 39"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        variants={draw(0.55)}
        initial="hidden"
        animate="visible"
      />
      <motion.path
        d="M39 39L51 23"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        variants={draw(0.68)}
        initial="hidden"
        animate="visible"
      />
    </svg>
  )
}

function Wordmark({ top = false }) {
  return (
    <img
      className={`onboarding-v2-wordmark${top ? ' is-top' : ''}`}
      src="/quill-brand.png"
      width="1680"
      height="759"
      alt="Quill"
    />
  )
}

/** A miniature writing surface, painted by the theme tokens around it. */
function ThemePreview({ themeId }) {
  return (
    <motion.div
      key={themeId}
      className="onboarding-v2-preview"
      aria-hidden="true"
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.985 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="onboarding-v2-preview-rail">
        <span className="onboarding-v2-preview-mark">Q</span>
        <span /><span /><span />
      </div>
      <div className="onboarding-v2-preview-sheet">
        <div className="onboarding-v2-preview-kicker">Chapter one</div>
        <div className="onboarding-v2-preview-title">A quiet place</div>
        <div className="onboarding-v2-preview-lines">
          <span /><span /><span /><span /><span /><span />
        </div>
        <div className="onboarding-v2-preview-cursor" />
      </div>
    </motion.div>
  )
}

function BackButton({ onClick }) {
  return (
    <button className="onboarding-v2-back" type="button" onClick={onClick}>
      <Icon name="back" size={14} />
      <span>Back</span>
    </button>
  )
}

function Progress({ step }) {
  return (
    <div className="onboarding-v2-progress" aria-hidden="true">
      {Array.from({ length: STEPS }, (_, index) => (
        <span key={index} data-on={index <= step ? '' : undefined} />
      ))}
    </div>
  )
}

export function OnboardingFlow({
  themes = [],
  themeId = '',
  onPickTheme,
  tools = [],
  toolsLoading = false,
  providerReady = false,
  activeProvider = null,
  providers = [],
  onAdoptTool,
  onTestTool,
  onSaveKey,
  onCreateProvider,
  onFinish,
  obscured = false,
}) {
  const reduced = useReducedMotion()
  const [step, setStep] = useState(0)
  const [adopting, setAdopting] = useState(false)
  const [error, setError] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [testState, setTestState] = useState('idle')
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyProvider, setKeyProvider] = useState(() => activeProvider?.id || providers[0]?.id || `preset:${PROVIDER_PRESETS[0].key}`)
  const [keyValue, setKeyValue] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const [keyError, setKeyError] = useState('')

  const modelOptions = useMemo(() => {
    const options = []
    for (const tool of tools) {
      const models = Array.isArray(tool.models) ? tool.models : []
      if (models.length) {
        for (const model of models) {
          options.push({
            key: `${tool.id}:${model}`,
            tool,
            model,
            title: model,
            note: tool.label,
            count: models.length,
          })
        }
      } else if (tool.exec) {
        // A CLI tool has no model list; its own id is the model the provider
        // stores, so it is still a real choice.
        options.push({
          key: tool.id,
          tool,
          model: tool.id,
          title: tool.label,
          note: 'Command-line model',
          count: 1,
        })
      }
    }
    return options
  }, [tools])

  const selected = modelOptions.find((option) => option.key === selectedKey) || null

  useEffect(() => {
    if (!modelOptions.length) {
      if (selectedKey) setSelectedKey('')
      return
    }
    if (!modelOptions.some((option) => option.key === selectedKey)) {
      setSelectedKey(modelOptions[0].key)
    }
  }, [modelOptions, selectedKey])

  useEffect(() => {
    setTestState('idle')
  }, [selectedKey])

  const next = () => setStep((value) => Math.min(value + 1, STEPS - 1))
  const back = () => setStep((value) => Math.max(value - 1, 0))

  const connect = async () => {
    if (keySaved || (providerReady && !selected)) {
      onFinish?.()
      return
    }
    if (!selected) return
    setAdopting(true)
    setError('')
    const ok = await onAdoptTool?.(selected.tool, selected.model)
    setAdopting(false)
    if (!ok) {
      setError(`Could not connect to ${selected.tool.label}. Start the server and try again.`)
      return
    }
    onFinish?.()
  }

  const test = async () => {
    if (!selected || !onTestTool) return
    setTestState('testing')
    const ok = await onTestTool(selected.tool, selected.model)
    setTestState(ok ? 'ok' : 'fail')
  }

  const providerChoices = [
    ...providers.map((provider) => ({ id: provider.id, label: provider.label || provider.id, preset: null })),
    ...PROVIDER_PRESETS.map((preset) => ({ id: `preset:${preset.key}`, label: preset.label, preset })),
  ]

  const saveKey = async () => {
    const secret = keyValue.trim()
    if (!secret) return
    setKeySaving(true)
    setKeyError('')
    let providerId = keyProvider
    if (keyProvider.startsWith('preset:')) {
      const preset = PROVIDER_PRESETS.find((entry) => `preset:${entry.key}` === keyProvider)
      const row = preset
        ? await onCreateProvider?.({
            id: preset.key,
            label: preset.label,
            vendor: 'compatible',
            protocol: 'openai_chat',
            baseUrl: preset.baseUrl,
            defaultModel: preset.model,
            models: [],
          })
        : null
      if (!row) {
        setKeySaving(false)
        setKeyError('Could not create that provider. Try another one.')
        return
      }
      providerId = row.id
    }
    const ok = await onSaveKey?.(secret, providerId)
    setKeySaving(false)
    if (!ok) {
      setKeyError('That key was not accepted. Check it and try again.')
      return
    }
    setKeySaved(true)
    setKeyValue('')
  }

  const stage = {
    initial: { opacity: 0, y: reduced ? 0 : 14 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: reduced ? 0 : -10 },
    transition: { duration: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] },
  }

  return (
    <div
      className={`onboarding-layer onboarding-v2${obscured ? ' is-obscured' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Quill"
      aria-hidden={obscured || undefined}
    >
      {step > 0 && <BackButton onClick={back} />}
      <AnimatePresence mode="wait" initial={false}>
        {step === 0 && (
          <motion.div key="welcome" className="onboarding-v2-stage onboarding-v2-welcome" {...stage}>
            <DrawnQuill reduced={reduced} />
            <motion.div
              initial={{ opacity: 0, y: reduced ? 0 : 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduced ? 0 : 0.18, delay: reduced ? 0 : 0.38 }}
            >
              <Wordmark />
            </motion.div>
            <motion.button
              className="onboarding-v2-primary onboarding-next onboarding-v2-start"
              type="button"
              onClick={next}
              whileHover={reduced ? undefined : { y: -2 }}
              whileTap={reduced ? undefined : { scale: 0.985 }}
              transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            >
              <span>Get Started</span>
              <span className="onboarding-v2-arrow" aria-hidden="true">→</span>
            </motion.button>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div key="look" className="onboarding-v2-stage onboarding-v2-look" {...stage}>
            <div className="onboarding-v2-top-brand"><Wordmark top /></div>
            <div className="onboarding-v2-look-grid">
              <div className="onboarding-v2-look-left">
                <h1>Pick a Look</h1>
                <div className="onboarding-v2-look-options" role="radiogroup" aria-label="Theme">
                  {themes.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={option.id === themeId}
                      className="onboarding-theme onboarding-v2-look-option"
                      data-on={option.id === themeId ? '' : undefined}
                      onClick={() => onPickTheme?.(option.id)}
                    >
                      <span className="onboarding-v2-look-dot" aria-hidden="true">
                        <i style={{ background: option.tokens?.['--main'] }} />
                        <i style={{ background: option.tokens?.['--text-1'] }} />
                      </span>
                      <span className="onboarding-v2-look-copy">
                        <strong>{themeFace(option)}</strong>
                        <small>{themeNote(option)}</small>
                      </span>
                      <span className="onboarding-v2-look-check" aria-hidden="true">
                        {option.id === themeId ? <Icon name="check" size={14} /> : null}
                      </span>
                    </button>
                  ))}
                </div>
                <motion.button
                  className="onboarding-v2-primary onboarding-next"
                  type="button"
                  onClick={next}
                  whileHover={reduced ? undefined : { y: -2 }}
                  whileTap={reduced ? undefined : { scale: 0.985 }}
                >
                  Continue
                </motion.button>
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <ThemePreview key={themeId} themeId={themeId} />
              </AnimatePresence>
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="model" className="onboarding-v2-stage onboarding-v2-model" {...stage}>
            <div className="onboarding-v2-top-brand"><Wordmark top /></div>
            <div className="onboarding-v2-model-inner">
              <h1>Pick a Model</h1>
              <p className="onboarding-v2-lede">
                This is what reads your draft when you ask it to write. It runs on
                this machine unless you add a provider key later.
              </p>

              {toolsLoading ? (
                <div className="onboarding-v2-model-list" aria-label="Looking for local models" aria-busy="true">
                  {Array.from({ length: 5 }, (_, index) => (
                    <div className="onboarding-v2-model onboarding-v2-model--skeleton" key={index}>
                      <span />
                    </div>
                  ))}
                </div>
              ) : modelOptions.length ? (
                <div className="onboarding-v2-model-list" role="radiogroup" aria-label="Model">
                  {modelOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      role="radio"
                      aria-checked={option.key === selectedKey}
                      className="onboarding-tool onboarding-v2-model"
                      data-on={option.key === selectedKey ? '' : undefined}
                      onClick={() => { setSelectedKey(option.key); setKeySaved(false) }}
                    >
                      <span className="onboarding-v2-model-copy">
                        <strong>{option.title}</strong>
                        <small>{option.note}{option.count > 1 ? ` · ${option.count} models` : ''}</small>
                      </span>
                      <span className="onboarding-v2-model-check" aria-hidden="true">
                        {option.key === selectedKey ? <Icon name="check" size={14} /> : null}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="onboarding-v2-empty">
                  No local model server is running. Start Ollama or LM Studio and
                  reopen this step, or add a provider key.
                </p>
              )}

              {selected && onTestTool && (
                <div className="onboarding-v2-testrow">
                  <button className="onboarding-v2-test" type="button" onClick={test} disabled={testState === 'testing'}>
                    {testState === 'testing' ? 'Testing…' : 'Test connection'}
                  </button>
                  {testState === 'ok' && <span className="onboarding-v2-test-ok">Reachable</span>}
                  {testState === 'fail' && <span className="onboarding-v2-test-fail">No answer</span>}
                </div>
              )}

              {error && <p className="onboarding-v2-error" role="alert">{error}</p>}

              <motion.button
                className="onboarding-v2-primary onboarding-next"
                type="button"
                disabled={adopting || (!selected && !providerReady)}
                onClick={connect}
                whileHover={reduced || (!selected && !providerReady) ? undefined : { y: -2 }}
                whileTap={reduced || (!selected && !providerReady) ? undefined : { scale: 0.985 }}
              >
                {adopting ? 'Connecting…' : providerReady && !selected ? 'Continue' : 'Continue'}
              </motion.button>

              {keyOpen && (
                <div className="onboarding-v2-keyform">
                  <label htmlFor="onboarding-provider">Provider</label>
                  <select
                    id="onboarding-provider"
                    value={keyProvider}
                    onChange={(event) => { setKeyProvider(event.target.value); setKeySaved(false); setKeyError('') }}
                  >
                    {providerChoices.map((choice) => (
                      <option key={choice.id} value={choice.id}>{choice.label}</option>
                    ))}
                  </select>
                  <label htmlFor="onboarding-api-key">API key</label>
                  <div className="onboarding-v2-keyrow">
                    <input
                      id="onboarding-api-key"
                      type="password"
                      autoComplete="off"
                      spellCheck="false"
                      placeholder="sk-…"
                      value={keyValue}
                      onChange={(event) => { setKeyValue(event.target.value); setKeyError('') }}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveKey() } }}
                    />
                    <button type="button" onClick={saveKey} disabled={!keyValue.trim() || keySaving}>
                      {keySaving ? 'Saving…' : keySaved ? 'Saved' : 'Connect'}
                    </button>
                  </div>
                  {keySaved ? (
                    <p className="onboarding-v2-keyok" role="status">Key saved. Continue to finish.</p>
                  ) : keyError ? (
                    <p className="onboarding-v2-error" role="alert">{keyError}</p>
                  ) : (
                    <p className="onboarding-v2-keynote">
                      Stored in the local credential vault. It never goes into the document.
                    </p>
                  )}
                </div>
              )}

              <div className="onboarding-v2-alt-actions">
                <button type="button" onClick={() => setKeyOpen((value) => !value)}>
                  {keyOpen ? 'Hide API key' : 'Add an API key'}
                </button>
                <button type="button" onClick={() => onFinish?.()}>Continue without an assistant</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Progress step={step} />
    </div>
  )
}
