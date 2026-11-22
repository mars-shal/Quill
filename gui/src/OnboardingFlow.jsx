import React, { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Icon } from './Icon.jsx'
import { PROVIDER_PRESETS } from './library/SettingsPage.jsx'
import { openExternal } from './platform/store.js'

/**
 * The first-run sequence.
 *
 * A release install starts with an empty library, so this is the first thing a
 * reader sees. It is a full-window surface rather than a card over the library:
 * the theme choice changes the whole room, and the model choice is a decision
 * about the app, not a dialog over a document.
 *
 * The four steps are deliberate:
 *
 *   1. the mark, and one way in
 *   2. what the room looks like
 *   3. the tools and accounts Quill can use
 *   4. which of those models handles thinking and which handles prose
 *
 * Everything is skippable. A local-first editor is a perfectly good offline
 * editor, and a first-run flow that traps someone without a model is worse than
 * no flow at all. `completed` is written only when the reader actually leaves;
 * a key typed here stays in the flow and is stored in the same vault Settings
 * uses.
 */

const STEPS = 4

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
  activeProvider = null,
  providers = [],
  onAdoptTool,
  onSaveKey,
  onCreateProvider,
  onConnectOpenRouter,
  onSaveProvider,
  onFinish,
  obscured = false,
}) {
  const reduced = useReducedMotion()
  const [step, setStep] = useState(0)
  const [adopting, setAdopting] = useState(false)
  const [error, setError] = useState('')
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyProvider, setKeyProvider] = useState(() => activeProvider?.id || providers[0]?.id || `preset:${PROVIDER_PRESETS[0].key}`)
  const [keyValue, setKeyValue] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [openRouterState, setOpenRouterState] = useState('idle')
  const [thinkingModel, setThinkingModel] = useState('')
  const [writingModel, setWritingModel] = useState('')

  // The role selectors are built from what the chosen provider actually has.
  // A local tool contributed its model list when it was adopted; a key path
  // stored one on the provider row.
  const roleModels = useMemo(() => {
    const providerModels = Array.isArray(activeProvider?.models) ? activeProvider.models : []
    return Array.from(new Set([
      activeProvider?.defaultModel,
      ...providerModels,
    ].filter(Boolean)))
  }, [activeProvider])

  // Entering the role step starts from whatever the provider already stores,
  // so reopening the tour does not silently reset a deliberate split.
  useEffect(() => {
    if (step !== 3) return
    setThinkingModel(activeProvider?.thinkingModel || '')
    setWritingModel(activeProvider?.writingModel || '')
  }, [step, activeProvider?.id, activeProvider?.thinkingModel, activeProvider?.writingModel])

  const next = () => setStep((value) => Math.min(value + 1, STEPS - 1))
  const back = () => setStep((value) => Math.max(value - 1, 0))

  // Connecting a tool does not ask which of its models to use. That question
  // belongs in Settings, where the reader can search a 143-model CLI list; here
  // one click has to be enough. The tool's own namespace wins when it has one,
  // then its first model.
  const adoptTool = async (tool) => {
    if (!tool?.id) return
    const models = Array.isArray(tool.models) ? tool.models : []
    const model = models.find((entry) => entry.startsWith(`${tool.id}/`)) || models[0] || tool.id
    setAdopting(true)
    setError('')
    const ok = await onAdoptTool?.(tool, model)
    setAdopting(false)
    if (!ok) {
      setError(`Could not connect to ${tool.label}. Start the server and try again.`)
    }
  }

  const finish = async () => {
    if (activeProvider && onSaveProvider) {
      const patch = {}
      if ((activeProvider.thinkingModel || '') !== thinkingModel) patch.thinkingModel = thinkingModel
      if ((activeProvider.writingModel || '') !== writingModel) patch.writingModel = writingModel
      if (Object.keys(patch).length) await onSaveProvider(patch)
    }
    onFinish?.()
  }

  const usePuter = () => {
    setKeyProvider('preset:puter')
    setKeyOpen(true)
  }

  const providerChoices = [
    ...providers.map((provider) => ({ id: provider.id, label: provider.label || provider.id, preset: null })),
    ...PROVIDER_PRESETS.map((preset) => ({ id: `preset:${preset.key}`, label: preset.label, preset })),
  ]
  const keyChoice = providerChoices.find((choice) => choice.id === keyProvider)
  const keyBaseUrl = keyChoice?.preset?.baseUrl
    || providers.find((provider) => provider.id === keyProvider)?.baseUrl
    || ''
  const keyIsOpenRouter = /openrouter\.ai/i.test(keyBaseUrl)
  const keyIsPuter = /api\.puter\.com\/puterai\/openai\/v1/i.test(keyBaseUrl)

  const connectOpenRouter = async () => {
    setOpenRouterState('waiting')
    setKeyError('')
    try {
      await onConnectOpenRouter?.()
      setKeySaved(true)
      setOpenRouterState('ready')
    } catch (failure) {
      setKeyError(failure?.message || 'OpenRouter sign-in failed.')
      setOpenRouterState('error')
    }
  }

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
            models: preset.models ?? [],
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
          <motion.div key="connectors" className="onboarding-v2-stage onboarding-v2-connectors" {...stage}>
            <div className="onboarding-v2-top-brand"><Wordmark top /></div>
            <div className="onboarding-v2-model-inner">
              <h1>Connect your tools</h1>
              <p className="onboarding-v2-lede">
                Pick a CLI agent or local server Quill can use, or connect a hosted
                account. You can change the exact model later in Settings.
              </p>

              {toolsLoading ? (
                <div className="onboarding-v2-model-list" aria-label="Looking for local tools" aria-busy="true">
                  {Array.from({ length: 5 }, (_, index) => (
                    <div className="onboarding-v2-model onboarding-v2-model--skeleton" key={index}>
                      <span />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="onboarding-v2-model-list" aria-label="Available connectors">
                  {tools.length ? tools.map((tool) => {
                    const active = activeProvider?.id === tool.id
                    const modelCount = Array.isArray(tool.models) ? tool.models.length : 0
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        className="onboarding-tool onboarding-v2-model"
                        data-on={active ? '' : undefined}
                        disabled={adopting}
                        onClick={() => adoptTool(tool)}
                      >
                        <span className="onboarding-v2-model-copy">
                          <strong>{tool.label}</strong>
                          <small>
                            {modelCount
                              ? `${modelCount} ${modelCount === 1 ? 'model' : 'models'} · change later in Settings`
                              : tool.exec
                                ? 'Command-line model'
                                : 'Local server'}
                          </small>
                        </span>
                        <span className="onboarding-v2-model-check" aria-hidden="true">
                          {active ? <Icon name="check" size={14} /> : null}
                        </span>
                      </button>
                    )
                  }) : (
                    <p className="onboarding-v2-empty">
                      No local tools found. You can add one later in Settings.
                    </p>
                  )}
                  <div className="onboarding-v2-model onboarding-v2-connector-row">
                    <span className="onboarding-v2-model-copy">
                      <strong>OpenRouter</strong>
                      <small>Hosted models on your own OpenRouter account</small>
                    </span>
                    <div className="onboarding-v2-connector-actions">
                      <button
                        className="onboarding-v2-test"
                        type="button"
                        onClick={connectOpenRouter}
                        disabled={openRouterState === 'waiting' || openRouterState === 'ready'}
                      >
                        {openRouterState === 'waiting' ? 'Waiting…' : openRouterState === 'ready' ? 'Connected' : 'Connect'}
                      </button>
                      <button
                        className="onboarding-v2-test"
                        type="button"
                        onClick={() => { setKeyProvider('preset:openrouter'); setKeyOpen(true) }}
                      >
                        Use a key
                      </button>
                    </div>
                  </div>
                  <div className="onboarding-v2-model onboarding-v2-connector-row">
                    <span className="onboarding-v2-model-copy">
                      <strong>Puter</strong>
                      <small>500+ models, billed to your Puter account</small>
                    </span>
                    <div className="onboarding-v2-connector-actions">
                      <button
                        className="onboarding-v2-test"
                        type="button"
                        onClick={() => openExternal('https://puter.com/dashboard#account')}
                      >
                        Token
                      </button>
                      <button className="onboarding-v2-test" type="button" onClick={usePuter}>
                        Use Puter
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {activeProvider && (
                <p className="onboarding-v2-keynote">
                  Chat model: {activeProvider.defaultModel || activeProvider.id}. Change it
                  any time in Settings.
                </p>
              )}

              {error && <p className="onboarding-v2-error" role="alert">{error}</p>}

              <motion.button
                className="onboarding-v2-primary onboarding-next"
                type="button"
                disabled={adopting || (!activeProvider && !keySaved)}
                onClick={next}
                whileHover={reduced || adopting || (!activeProvider && !keySaved) ? undefined : { y: -2 }}
                whileTap={reduced || adopting || (!activeProvider && !keySaved) ? undefined : { scale: 0.985 }}
              >
                {adopting ? 'Connecting…' : 'Continue'}
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
                  {keyIsOpenRouter && (
                    <button
                      type="button"
                      className="onboarding-v2-openrouter"
                      onClick={connectOpenRouter}
                      disabled={openRouterState === 'waiting' || keySaved}
                    >
                      <Icon name="sparkle" size={14} />
                      {openRouterState === 'waiting'
                        ? 'Waiting for your browser…'
                        : keySaved
                          ? 'OpenRouter connected'
                          : 'Connect with OpenRouter'}
                    </button>
                  )}
                  {keyIsOpenRouter && (
                    <span className="onboarding-v2-keynote">
                      OpenRouter keys need a signed-in account.{' '}
                      <button className="link-button" type="button" onClick={() => openExternal('https://openrouter.ai/sign-up')}>
                        Create one first
                      </button>
                      .
                    </span>
                  )}
                  {keyIsPuter && (
                    <span className="onboarding-v2-keynote">
                      Puter uses a personal auth token.{' '}
                      <button className="link-button" type="button" onClick={() => openExternal('https://puter.com/dashboard#account')}>
                        Create one in your dashboard
                      </button>
                      . Your Puter account covers the model usage.
                    </span>
                  )}
                  <span className="onboarding-v2-divider">
                    {keyIsOpenRouter ? 'or paste a key' : keyIsPuter ? 'then paste the token' : 'or paste a key'}
                  </span>
                  <label htmlFor="onboarding-api-key">{keyIsPuter ? 'Puter auth token' : 'API key'}</label>
                  <div className="onboarding-v2-keyrow">
                    <input
                      id="onboarding-api-key"
                      type="password"
                      autoComplete="off"
                      spellCheck="false"
                      placeholder={keyIsPuter ? 'Puter auth token' : 'sk-…'}
                      value={keyValue}
                      onChange={(event) => { setKeyValue(event.target.value); setKeyError('') }}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveKey() } }}
                    />
                    <button type="button" onClick={saveKey} disabled={!keyValue.trim() || keySaving}>
                      {keySaving ? 'Saving…' : keySaved ? 'Saved' : 'Connect'}
                    </button>
                  </div>
                  {keySaved ? (
                    <p className="onboarding-v2-keyok" role="status">Key saved. Continue to choose role models.</p>
                  ) : keyError ? (
                    <p className="onboarding-v2-error" role="alert">{keyError}</p>
                  ) : (
                    <p className="onboarding-v2-keynote">
                      Stored in the local credential vault. It never goes into the document.
                    </p>
                  )}
                </div>
              )}

              {!keyOpen && keyError && (
                <p className="onboarding-v2-error" role="alert">{keyError}</p>
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

        {step === 3 && (
          <motion.div key="roles" className="onboarding-v2-stage onboarding-v2-roles" {...stage}>
            <div className="onboarding-v2-top-brand"><Wordmark top /></div>
            <div className="onboarding-v2-model-inner">
              <h1>Thinking and writing</h1>
              <p className="onboarding-v2-lede">
                Thinking handles research, planning and critique. Writing handles the
                prose. Leave both on the chat model unless you want to split them.
              </p>
              {activeProvider ? (
                <>
                  <label className="onboarding-v2-role" htmlFor="onboarding-thinking-model">
                    <span>Thinking model</span>
                    <select
                      id="onboarding-thinking-model"
                      value={thinkingModel}
                      onChange={(event) => setThinkingModel(event.target.value)}
                    >
                      <option value="">Same as chat model</option>
                      {roleModels.map((option) => (
                        <option key={`thinking-${option}`} value={option}>{option}</option>
                      ))}
                    </select>
                  </label>
                  <label className="onboarding-v2-role" htmlFor="onboarding-writing-model">
                    <span>Writing model</span>
                    <select
                      id="onboarding-writing-model"
                      value={writingModel}
                      onChange={(event) => setWritingModel(event.target.value)}
                    >
                      <option value="">Same as chat model</option>
                      {roleModels.map((option) => (
                        <option key={`writing-${option}`} value={option}>{option}</option>
                      ))}
                    </select>
                  </label>
                  <p className="onboarding-v2-keynote">
                    Chat model: {activeProvider.defaultModel || activeProvider.id}
                  </p>
                </>
              ) : (
                <p className="onboarding-v2-empty">
                  No provider is connected yet. You can choose role models later in Settings.
                </p>
              )}
              <motion.button
                className="onboarding-v2-primary onboarding-next"
                type="button"
                onClick={finish}
                whileHover={reduced ? undefined : { y: -2 }}
                whileTap={reduced ? undefined : { scale: 0.985 }}
              >
                Finish
              </motion.button>
              <div className="onboarding-v2-alt-actions">
                <button type="button" onClick={() => onFinish?.()}>Finish without choosing</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Progress step={step} />
    </div>
  )
}
