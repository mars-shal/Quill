import React from 'react'

/**
 * A segmented control whose selection travels instead of jumping.
 *
 * One thumb moves under the options; each option reserves the same width, so
 * the row never reflows. Reduced motion is handled in CSS: the state still
 * changes, the trip is skipped.
 */
export function SegmentedControl({ options = [], label, value, onChange, className = '' }) {
  const count = Math.max(1, options.length)
  const found = options.findIndex((option) => option.value === value)
  const index = found < 0 ? 0 : found
  return (
    <div
      className={`interior-segmented ${className}`.trim()}
      role="group"
      aria-label={label}
      style={{ '--seg-count': count, '--seg-index': index }}
    >
      <span
        className="interior-segmented-thumb"
        aria-hidden="true"
        style={{ width: `calc((100% - 6px) / ${count})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            className={`interior-segmented-option${active ? ' is-active' : ''}`}
            aria-pressed={active}
            disabled={option.disabled}
            onClick={() => { if (!active) onChange?.(option.value) }}
          >
            <span className="interior-segmented-label">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
