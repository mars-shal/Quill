import React from 'react'
import { Bar } from '@nivo/bar'

/**
 * The one Nivo bar chart used by both usage surfaces.
 *
 * A fixed viewBox rather than a measured container: the chart must render in a
 * hidden Settings tab (and in tests) without ResizeObserver, and the card scrolls
 * horizontally on a narrow window instead of crushing the axis labels.
 */

function cssColor(value, fallback) {
  return typeof value === 'string' && /^(#|rgb|hsl)/i.test(value.trim()) ? value.trim() : fallback
}

function shortModel(value) {
  const text = String(value || '')
  return text.length > 28 ? `${text.slice(0, 27)}…` : text
}

export function UsageChart({ models = [], theme, width = 760, compact = false }) {
  const accent = cssColor(theme?.tokens?.['--accent'], '#6a8792')
  const ink = cssColor(theme?.tokens?.['--text-2'], '#4b5563')
  const grid = cssColor(theme?.tokens?.['--border'], 'rgba(0,0,0,0.12)')
  const onAccent = cssColor(theme?.tokens?.['--on-accent'], '#f9f9f9')
  const data = models.map((row) => ({ model: shortModel(row.model), fullModel: row.model, tokens: Number(row.total ?? row.tokens ?? 0) }))
  const height = compact
    ? Math.max(150, models.length * 38 + 52)
    : Math.max(180, models.length * 46 + 64)

  return (
    <Bar
      width={width}
      height={height}
      data={data}
      keys={['tokens']}
      indexBy="model"
      layout="horizontal"
      margin={compact
        ? { top: 6, right: 24, bottom: 28, left: 116 }
        : { top: 8, right: 34, bottom: 34, left: 150 }}
      padding={0.32}
      borderRadius={4}
      colors={[accent]}
      theme={{
        text: { fill: ink, fontSize: 11 },
        axis: {
          ticks: { text: { fill: ink, fontSize: compact ? 9 : 10 } },
          legend: { text: { fill: ink, fontSize: 10 } },
        },
        grid: { line: { stroke: grid, strokeWidth: 1 } },
        tooltip: {
          container: {
            color: ink,
            background: 'var(--main)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: 'var(--shadow-2)',
            fontSize: '11px',
          },
        },
      }}
      enableGridY={false}
      enableGridX={!compact}
      axisBottom={compact ? null : { tickSize: 0, tickPadding: 7, legend: 'Tokens', legendPosition: 'middle', legendOffset: 28 }}
      axisLeft={{ tickSize: 0, tickPadding: compact ? 4 : 7 }}
      enableLabel
      label={(entry) => Number(entry.value).toLocaleString()}
      labelTextColor={onAccent}
      labelSkipWidth={compact ? 44 : 26}
      animate
      motionConfig="gentle"
      tooltip={({ indexValue, value }) => (
        <div className="usage-tooltip">
          <strong>{indexValue}</strong>
          <span>{Number(value).toLocaleString()} tokens</span>
        </div>
      )}
    />
  )
}

/** Last fourteen days, stacked prompt/completion. */
export function UsageHistoryChart({ history = [], theme, width = 760 }) {
  const accent = cssColor(theme?.tokens?.['--accent'], '#6a8792')
  const completion = cssColor(theme?.tokens?.['--text-3'], '#9ca3af')
  const ink = cssColor(theme?.tokens?.['--text-2'], '#4b5563')
  const grid = cssColor(theme?.tokens?.['--border'], 'rgba(0,0,0,0.12)')
  const data = history.map((day) => ({
    date: String(day.date || '').slice(5),
    prompt: Number(day.prompt) || 0,
    completion: Number(day.completion) || 0,
  }))

  return (
    <Bar
      width={width}
      height={250}
      data={data}
      keys={['prompt', 'completion']}
      indexBy="date"
      groupMode="stacked"
      margin={{ top: 10, right: 20, bottom: 48, left: 54 }}
      padding={0.34}
      borderRadius={3}
      colors={[accent, completion]}
      theme={{
        text: { fill: ink, fontSize: 10 },
        axis: { ticks: { text: { fill: ink, fontSize: 9 } }, legend: { text: { fill: ink, fontSize: 10 } } },
        grid: { line: { stroke: grid, strokeWidth: 1 } },
        legends: { text: { fill: ink, fontSize: 10 } },
        tooltip: {
          container: {
            color: ink,
            background: 'var(--main)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: 'var(--shadow-2)',
            fontSize: '11px',
          },
        },
      }}
      axisBottom={{ tickSize: 0, tickPadding: 6, tickRotation: data.length > 10 ? -35 : 0 }}
      axisLeft={{ tickSize: 0, tickPadding: 5 }}
      enableLabel={false}
      legends={[
        { dataFrom: 'keys', anchor: 'top-right', direction: 'row', translateY: -4, itemWidth: 82, itemHeight: 14, symbolSize: 8, symbolShape: 'circle' },
      ]}
      animate
      motionConfig="gentle"
      tooltip={({ id, value, indexValue }) => (
        <div className="usage-tooltip">
          <strong>{indexValue}</strong>
          <span>{id}: {Number(value).toLocaleString()} tokens</span>
        </div>
      )}
    />
  )
}
