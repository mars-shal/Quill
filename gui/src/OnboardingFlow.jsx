import React, { useState } from 'react'

/**
 * The first-run sequence.
 *
 * A release install starts with an empty library -- the seed documents are a
 * development convenience, not something a reader should be handed as their own
 * writing -- so the first window a new reader sees is this card rather than a
 * blank shelf. It asks the three questions that decide whether the app is usable
 * at all, in the order they are worth answering:
 *
 *   1. what this is, because a card that opens with settings explains nothing
 *   2. what it looks like, because the theme is the one choice that makes a
 *      strange window feel like an editor before any words exist
 *   3. how it thinks, because with no provider there is no assistant and a chat
 *      panel that cannot answer reads as broken
 *
 * It is persisted through `onboarding_state` (`completed`), so it happens once
 * per install rather than once per launch, and `reconcile_onboarding_completed`
 * on the core side marks an existing library complete before this can appear
 * over it. Nothing here is required: every step can be skipped, and the app is a
 * perfectly good offline editor without a single answer.
 */

const STEPS = 3

export function OnboardingFlow({
  themes = [],
  themeId = '',
  onPickTheme,
  tools = [],
  onAdoptTool,
  onOpenSettings,
  onFinish,
}) {
  const [step, setStep] = useState(0)
  const [adopting, setAdopting] = useState('')
  const [error, setError] = useState('')
  const last = step === STEPS - 1

  // A local server the core found running: adopting it needs no key, no typing
  // and no second screen, which is the whole reason it is offered here.
  const adopt = async (tool) => {
    setAdopting(tool.id)
    setError('')
    const ok = await onAdoptTool?.(tool)
    setAdopting('')
    if (!ok) {
      setError(`Could not connect to ${tool.label}. Start the server and try again.`)
      return
    }
    onFinish?.()
  }

  const useKey = () => {
    onFinish?.()
    onOpenSettings?.()
  }

  return (
    <div className="onboarding-layer" role="dialog" aria-modal="true" aria-label="Welcome to Quill">
      <div className="onboarding-card">
        <div className="onboarding-progress" aria-hidden="true">
          {Array.from({ length: STEPS }, (_, index) => (
            <span key={index} data-on={index <= step ? '' : undefined} />
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="onboarding-mark" aria-hidden="true">
              <img src="/quill-mark.png" alt="" />
            </div>
            <h1>Welcome to Quill</h1>
            <p className="onboarding-lede">
              A desktop editor for long-form writing, with an assistant that
              reads the draft and stays out of the way until you ask.
            </p>
            <p className="onboarding-fineprint">
              Local-first by default. Your writing stays on this machine.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <h1>Pick a look</h1>
            <p className="onboarding-lede">You can change this any time in Settings.</p>
            <div className="onboarding-themes" role="radiogroup" aria-label="Theme">
              {themes.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={option.id === themeId}
                  className="onboarding-theme"
                  data-on={option.id === themeId ? '' : undefined}
                  onClick={() => onPickTheme?.(option.id)}
                >
                  <span className="onboarding-swatch" aria-hidden="true">
                    {['--main', '--sidebar', '--text-1', '--accent'].map((token) => (
                      <i key={token} style={{ background: option.tokens?.[token] }} />
                    ))}
                  </span>
                  <span className="onboarding-theme-name">{option.name}</span>
                  <span className="onboarding-theme-mode">{option.mode}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>How it writes with you</h1>
            <p className="onboarding-lede">
              Quill sends its questions to a model. Say where yours runs — you can
              change this later.
            </p>
            {tools.length > 0 ? (
              <div className="onboarding-tools">
                {tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    className="onboarding-tool"
                    disabled={Boolean(adopting)}
                    onClick={() => adopt(tool)}
                  >
                    <span>
                      <strong>{tool.label}</strong>
                      <em>{tool.version ? `${tool.version} · ` : ''}{tool.models.length} model{tool.models.length === 1 ? '' : 's'}</em>
                    </span>
                    <b>{adopting === tool.id ? 'Connecting…' : 'Use'}</b>
                  </button>
                ))}
              </div>
            ) : (
              <p className="onboarding-empty">
                No local model server is running. Ollama or LM Studio will appear
                here when they are.
              </p>
            )}
            {error && <p className="onboarding-error" role="alert">{error}</p>}
            <div className="onboarding-alts">
              <button type="button" className="onboarding-alt" onClick={useKey}>
                Add an API key
              </button>
              <button type="button" className="onboarding-alt" onClick={() => onFinish?.()}>
                Skip for now — I will only write
              </button>
            </div>
          </>
        )}

        <div className="onboarding-actions">
          {step > 0 ? (
            <button type="button" className="onboarding-back" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : <span />}
          {last ? (
            <button type="button" className="onboarding-next" onClick={() => onFinish?.()}>
              Start writing
            </button>
          ) : (
            <button type="button" className={`onboarding-next${step === 0 ? ' wide' : ''}`} onClick={() => setStep(step + 1)}>
              {step === 0 ? 'Get started' : 'Continue'}
            </button>
          )}
        </div>
        {step === 0 && (
          <p className="onboarding-terms">
            Nothing leaves this machine unless you connect a model and ask it to.
          </p>
        )}
      </div>
    </div>
  )
}
