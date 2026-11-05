import React from 'react'

/**
 * A designed empty state, not a sentence in the middle of a blank panel.
 *
 * The illustration is a line drawing so it takes the theme's ink instead of
 * shipping a second palette. The action is supplied by the caller: an empty
 * library and an empty filter offer different next steps.
 */
export function EmptyState({ title, copy, children, className = '' }) {
  return (
    <div className={`empty-state ${className}`}>
      <div className="empty-state-art" aria-hidden="true">
        <svg viewBox="0 0 180 132" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M25 108h130" />
          <path d="M34 104V58c9-2 18-1 26 3v43c-8-4-17-5-26-3Z" />
          <path d="M60 104V45c9-2 18-1 26 3v53c-8-4-17-5-26-3Z" />
          <path d="M34 58c9-2 18-1 26 3M60 45c9-2 18-1 26 3" />
          <path className="empty-state-accent" d="M96 104V70c0-9 7-16 16-16h6c9 0 16 7 16 16v34" />
          <path d="M96 104h38M107 54V42M124 54V34" />
          <path className="empty-state-accent" d="m139 25 2.6 5.4L147 33l-5.4 2.6L139 41l-2.6-5.4L131 33l5.4-2.6L139 25Z" />
        </svg>
      </div>
      <p className="empty-state-title">{title}</p>
      {copy && <small className="empty-state-copy">{copy}</small>}
      {children && <div className="empty-state-actions">{children}</div>}
    </div>
  )
}
