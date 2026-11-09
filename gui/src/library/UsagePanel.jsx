import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../Icon.jsx'
import { SegmentedControl } from './interior/SegmentedControl.jsx'
import { ValueFlash } from './interior/ValueFlash.jsx'
import { UsageChart, UsageHistoryChart } from './UsageChart.jsx'
import { Switch } from './ui/switch.jsx'
import { usageStats } from '../platform/store.js'

/**
 * Token usage today, as a small dashboard rather than a table of numbers.
 *
 * The sidecar reports a prompt/completion split per model for the current UTC
 * day, plus a fourteen-day total series. The dashboard shows what was spent,
 * what it was spent on, and the list-rate estimate that follows from the split.
 * A provider that reports no usage contributes an estimate, counted separately.
 */

// List price, USD per million tokens (input / output). A model without an entry
// shows an em dash rather than a fabricated number; local models are often $0
// but that is a property of the server, not of the model id.
const MODEL_PRICING = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.60 },
  'openai/gpt-oss-20b': { input: 0.10, output: 0.50 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'deepseek-chat': { input: 0.27, output: 1.10 },
  'mistral-small-latest': { input: 0.20, output: 0.60 },
  'openai/gpt-4o': { input: 2.50, output: 10.00 },
}

function pricingFor(model) {
  return MODEL_PRICING[model] || null
}

function costOf(row) {
  const price = pricingFor(row.model)
  if (!price) return null
  return (row.prompt / 1_000_000) * price.input + (row.completion / 1_000_000) * price.output
}

function formatCost(value) {
  if (value === null || value === undefined) return '—'
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function normaliseRow(model, value) {
  if (typeof value === 'number') {
    return { model, prompt: 0, completion: 0, total: value, calls: value ? 1 : 0, estimated_calls: 0 }
  }
  if (!value || typeof value !== 'object') {
    return { model, prompt: 0, completion: 0, total: 0, calls: 0, estimated_calls: 0 }
  }
  return {
    model,
    prompt: Number(value.prompt) || 0,
    completion: Number(value.completion) || 0,
    total: Number(value.total) || 0,
    calls: Number(value.calls) || 0,
    estimated_calls: Number(value.estimated_calls) || 0,
  }
}

function shortModel(value) {
  const text = String(value || '')
  return text.length > 34 ? `${text.slice(0, 33)}…` : text
}

export function UsagePanel({ draft = {}, update } = {}) {
  const [usage, setUsage] = useState(null)
  const [state, setState] = useState('loading')
  const [chartMode, setChartMode] = useState('models')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    usageStats()
      .then((data) => {
        if (cancelled) return
        setUsage(data && typeof data === 'object' ? data : { date: '', limit: 0, models: {}, totals: {}, history: [] })
        setState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setUsage({ date: '', limit: 0, models: {}, totals: {}, history: [] })
        setState('ready')
      })
    return () => { cancelled = true }
  }, [revision])

  const models = useMemo(() => {
    const rows = usage?.models && typeof usage.models === 'object' ? usage.models : {}
    return Object.entries(rows)
      .map(([model, value]) => normaliseRow(model, value))
      .sort((a, b) => b.total - a.total)
  }, [usage])

  const totals = useMemo(() => {
    const raw = usage?.totals
    if (raw && typeof raw === 'object') {
      return {
        prompt: Number(raw.prompt) || 0,
        completion: Number(raw.completion) || 0,
        total: Number(raw.total) || 0,
        calls: Number(raw.calls) || 0,
        estimated_calls: Number(raw.estimated_calls) || 0,
      }
    }
    return models.reduce((sum, row) => ({
      prompt: sum.prompt + row.prompt,
      completion: sum.completion + row.completion,
      total: sum.total + row.total,
      calls: sum.calls + row.calls,
      estimated_calls: sum.estimated_calls + row.estimated_calls,
    }), { prompt: 0, completion: 0, total: 0, calls: 0, estimated_calls: 0 })
  }, [models, usage])

  const knownCosts = models.map(costOf).filter((value) => value !== null)
  const estimatedCost = knownCosts.length ? knownCosts.reduce((sum, value) => sum + value, 0) : null
  const limit = Math.max(0, Number(usage?.limit) || 0)
  const share = limit > 0 ? Math.min(1, totals.total / limit) : 0
  const history = Array.isArray(usage?.history) ? usage.history : []
  const activeDays = history.filter((day) => Number(day.total) > 0).length

  if (state === 'loading' && !usage) {
    return (
      <div className="usage-panel" aria-busy="true">
        <div className="usage-summary">
          {[0, 1, 2, 3].map((index) => <div className="usage-stat usage-stat--skeleton" key={index}><span /></div>)}
        </div>
        <div className="usage-card usage-card--skeleton"><span /></div>
      </div>
    )
  }

  return (
    <div className="usage-panel">
      <div className="usage-summary">
        <div className="usage-stat">
          <span className="usage-stat-label">Total tokens</span>
          <ValueFlash value={totals.total.toLocaleString()} />
          <small>{usage?.date || 'No calls yet'}</small>
        </div>
        <div className="usage-stat">
          <span className="usage-stat-label">Prompt / completion</span>
          <strong className="usage-split">
            <span>{totals.prompt.toLocaleString()}</span>
            <em>/</em>
            <span>{totals.completion.toLocaleString()}</span>
          </strong>
          <small>{totals.calls.toLocaleString()} call{totals.calls === 1 ? '' : 's'}</small>
        </div>
        <div className="usage-stat">
          <span className="usage-stat-label">Estimated cost</span>
          <ValueFlash value={formatCost(estimatedCost)} />
          <small>{knownCosts.length ? 'list rates, not billed amounts' : 'no list price for these models'}</small>
        </div>
        <div className="usage-stat">
          <span className="usage-stat-label">Daily limit</span>
          <ValueFlash value={limit ? `${Math.round(share * 100)}%` : '—'} />
          <div className="usage-limit" aria-hidden="true">
            <i style={{ width: `${Math.max(share * 100, totals.total ? 2 : 0)}%` }} data-level={share > 0.75 ? 'high' : 'low'} />
          </div>
          <small>{limit ? `${limit.toLocaleString()} tokens` : 'no limit configured'}</small>
        </div>
      </div>

      <div className="usage-card">
        <div className="usage-card-head">
          <div>
            <h3>Usage by model</h3>
            <p>
              {usage?.date ? `Today, ${usage.date}` : 'Today'}
              {activeDays ? ` · ${activeDays} active day${activeDays === 1 ? '' : 's'} in the last 14` : ''}
              {totals.estimated_calls ? ` · ${totals.estimated_calls} estimated call${totals.estimated_calls === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <div className="usage-card-actions">
            <SegmentedControl
              label="Usage chart range"
              value={chartMode}
              onChange={setChartMode}
              options={[
                { value: 'models', label: 'By model' },
                { value: 'history', label: '14 days' },
              ]}
            />
            <button className="usage-refresh" type="button" aria-label="Refresh usage" onClick={() => setRevision((value) => value + 1)}>
              <Icon name="revise" size={13} />
            </button>
          </div>
        </div>

        {!models.length ? (
          <div className="usage-empty">
            <Icon name="grid" size={20} />
            <strong>No token usage yet</strong>
            <p>Ask the assistant or run a document and the calls will appear here.</p>
          </div>
        ) : (
          <>
            <div className="usage-chart">
              {chartMode === 'models'
                ? <UsageChart models={models} />
                : <UsageHistoryChart history={history} />}
            </div>
            <div className="usage-breakdown-title">Full breakdown</div>
            <div className="usage-list" aria-label="Full token breakdown by model">
              <div className="usage-list-head" aria-hidden="true">
                <span>Model</span><span>Calls</span><span>Prompt</span><span>Completion</span><span>Total</span><span>Cost</span>
              </div>
              {models.map((row) => {
                const cost = costOf(row)
                const price = pricingFor(row.model)
                return (
                  <div className="usage-list-row" key={row.model}>
                    <span className="usage-list-model" title={row.model}>{row.model}</span>
                    <span className="usage-list-num">{row.calls.toLocaleString()}{row.estimated_calls ? '*' : ''}</span>
                    <span className="usage-list-num">{row.prompt.toLocaleString()}</span>
                    <span className="usage-list-num">{row.completion.toLocaleString()}</span>
                    <span className="usage-list-num usage-list-total">{row.total.toLocaleString()}</span>
                    <span className="usage-list-price">
                      {formatCost(cost)}
                      {price && <small>${price.input} / ${price.output} per M</small>}
                    </span>
                  </div>
                )
              })}
              <div className="usage-list-row usage-list-row--sum" aria-label="Totals">
                <span className="usage-list-model">All models</span>
                <span className="usage-list-num">{totals.calls.toLocaleString()}</span>
                <span className="usage-list-num">{totals.prompt.toLocaleString()}</span>
                <span className="usage-list-num">{totals.completion.toLocaleString()}</span>
                <span className="usage-list-num usage-list-total">{totals.total.toLocaleString()}</span>
                <span className="usage-list-price">{formatCost(estimatedCost)}</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* A budget switch, not a second assistant. It trims the draft, caps the
          answer and skips the optional gap-research round, so the same turn
          costs fewer tokens without changing which model answered. */}
      <div className="usage-card usage-saving">
        <div className="usage-saving-copy">
          <span className="usage-stat-label">Token saving mode</span>
          <strong>Spend less on every turn</strong>
          <p>
            Sends a shorter draft, caps the answer at about 900 tokens and skips the optional
            second research pass. Answers are shorter; the model is the same.
          </p>
        </div>
        <div className="usage-saving-control">
          <Switch
            id="token-saving"
            checked={Boolean(draft.tokenSaving)}
            onCheckedChange={(value) => update?.('tokenSaving', value)}
          />
          <label htmlFor="token-saving">{draft.tokenSaving ? 'On' : 'Off'}</label>
        </div>
      </div>

      <p className="usage-footnote">
        Prompt / completion are split as the provider reports them. Calls marked * had no provider usage and are estimated
        from the prompt and output. Costs use published list rates per million tokens and are not invoices; local models
        usually cost nothing. The daily bucket resets at UTC midnight.
      </p>
    </div>
  )
}
