import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../../Icon.jsx'

/**
 * Copy to tick, width locked, reverts after 2s.
 *
 * The width is reserved by rendering both icons in the same grid cell; the
 * control never changes size while the confirmation is showing.
 */
export function CopyButton({ value = '', className = '', label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = async () => {
    if (!value) return
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard permission can be denied; leaving the icon unchanged is the
      // honest result rather than a false tick.
    }
  }

  return (
    <button
      className={`interior-copy ${className}`.trim()}
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      disabled={!value}
      onClick={copy}
    >
      <span className="interior-copy-icon" data-copied={copied ? '' : undefined}>
        <Icon name="copy" size={17} />
      </span>
      <span className="interior-copy-icon interior-copy-icon--done" data-copied={copied ? '' : undefined}>
        <Icon name="check" size={17} />
      </span>
    </button>
  )
}
