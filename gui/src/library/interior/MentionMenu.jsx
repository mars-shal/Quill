/**
 * The `@` menu: sections of this document and the other files in the library.
 *
 * Rendering lives here; key handling stays in the TipTap plugin (see
 * `editor/writerMention.js`). The two meet through `mentionStore`, which is
 * also why this can be a plain portal: the editor never has to know the menu
 * exists.
 *
 * Motion follows the Motion Studies tokens the brief names: the menu opens on
 * the soft spring (260/24), the highlight crosses on the lead spring (620/36),
 * and opacity settles on 420/32. A short stagger brings the rows in rather than
 * popping the whole list at once.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Icon } from '../../Icon.jsx'
import { mentionSnapshot, subscribeMention } from '../../editor/mentionStore.js'
import './MentionMenu.css'

const SOFT = { type: 'spring', stiffness: 260, damping: 24 }
const LEAD = { type: 'spring', stiffness: 620, damping: 36 }
const FADE = { type: 'spring', stiffness: 420, damping: 32 }
const ROW_H = 38
const GAP = 8

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function MentionMenu() {
  const state = useSyncExternalStore(subscribeMention, mentionSnapshot)
  const reduce = useReducedMotion()
  const ref = useRef(null)
  const [position, setPosition] = useState(null)

  const items = state.items || []
  const open = state.open && items.length > 0

  // The caret rect is in viewport coordinates; a portal can use `position:
  // fixed` directly, so nothing has to be measured against a scrolled ancestor.
  useLayoutEffect(() => {
    if (!open || !state.rect) {
      setPosition(null)
      return
    }
    const rect = state.rect
    const width = ref.current?.offsetWidth || 296
    const height = ref.current?.offsetHeight || Math.min(items.length, 6) * ROW_H + 12
    const below = rect.bottom + GAP
    const flip = below + height > window.innerHeight - 12
    setPosition({
      left: clamp(rect.left, 12, window.innerWidth - width - 12),
      top: flip ? Math.max(12, rect.top - height - GAP) : below,
      width,
    })
  }, [open, state.rect, items.length])

  // The page can scroll under a fixed menu. Follow the caret rather than
  // leaving the list pointing at a paragraph the reader has moved past.
  useEffect(() => {
    if (!open || !state.rect) return undefined
    const place = () => {
      const rect = state.rect
      if (!rect) return
      const width = ref.current?.offsetWidth || 296
      const height = ref.current?.offsetHeight || 240
      const below = rect.bottom + GAP
      const flip = below + height > window.innerHeight - 12
      setPosition({
        left: clamp(rect.left, 12, window.innerWidth - width - 12),
        top: flip ? Math.max(12, rect.top - height - GAP) : below,
        width,
      })
    }
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, state.rect])

  const menu = (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          key="mention-menu"
          className="mention-menu"
          role="listbox"
          aria-label="Mention a section or file"
          initial={{ opacity: 0, height: 0, y: reduce ? 0 : -4 }}
          animate={{ opacity: 1, height: 'auto', y: 0 }}
          exit={{ opacity: 0, height: 0, y: reduce ? 0 : -4 }}
          transition={{
            height: reduce ? { duration: 0 } : SOFT,
            y: reduce ? { duration: 0 } : SOFT,
            opacity: reduce ? { duration: 0 } : FADE,
          }}
          style={position ? { left: position.left, top: position.top } : undefined}
        >
          <div className="mention-menu__head">
            <span>Sections and files</span>
            <kbd>@</kbd>
          </div>
          <ul className="mention-menu__list">
            {items.map((item, index) => {
              const active = index === state.active
              return (
                <li key={`${item.kind}-${item.id}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className="mention-row"
                    data-active={active ? '' : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => state.onPick?.(index)}
                onPointerEnter={() => {
                  // Keyboard owns `active`; hovering previews the same row so
                  // the two never disagree about the highlight.
                  state.onHover?.(index)
                }}
                  >
                    {active && (
                      <motion.span
                        layoutId="mention-active"
                        className="mention-row__plate"
                        transition={reduce ? { duration: 0 } : LEAD}
                        aria-hidden="true"
                      />
                    )}
                    <span className="mention-row__icon" aria-hidden="true">
                      <Icon name={item.kind === 'file' ? 'file' : 'sort'} size={14} />
                    </span>
                    <span className="mention-row__label">{item.label}</span>
                    <span className="mention-row__hint">{item.hint || (item.kind === 'file' ? 'File' : 'Section')}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="mention-menu__foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> to choose</span>
            <span><kbd>↵</kbd> to insert</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  if (typeof document === 'undefined') return null
  return createPortal(menu, document.body)
}
