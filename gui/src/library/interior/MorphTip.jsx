/**
 * One tooltip for a whole toolbar.
 *
 * The reference behaviour is the point: the first hover pops a label in place;
 * after that the tooltip never disappears between controls, it stretches over
 * to the next one. The edge facing the move runs on the lead spring and the
 * trailing edge on the slow one, so the box visibly stretches and settles at
 * the new label's width. The little tail follows on its own spring.
 *
 * It portals to `document.body` because the editor toolbar scrolls horizontally
 * (`overflow-x: auto`), and a tooltip inside it would be clipped at the edges.
 * Keyboard focus gets the same treatment as the pointer, so tabbing through the
 * bar reads the labels too.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion'
import './MorphTip.css'

const LEAD = { type: 'spring', stiffness: 620, damping: 36 }
const TRAIL = { type: 'spring', stiffness: 190, damping: 19 }
const TAIL = { type: 'spring', stiffness: 300, damping: 22 }
const FADE = { type: 'spring', stiffness: 420, damping: 32 }
const HEIGHT = 30
const GAP = 10
const LEAVE_MS = 140

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function MorphTip({ hostRef, className = '' }) {
  const reduce = useReducedMotion()
  const [tip, setTip] = useState(null)
  const [top, setTop] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const measureRef = useRef(null)

  const left = useMotionValue(0)
  const right = useMotionValue(0)
  const width = useTransform([left, right], ([l, r]) => Math.max(0, r - l))
  const tail = useMotionValue(0)
  const tailX = useTransform(tail, (value) => value - 5)
  const opacity = useMotionValue(0)

  const hovered = useRef(null)
  const lastCenter = useRef(null)
  const hideTimer = useRef(null)
  const clearTimer = useRef(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const targetOf = (event) => {
      const node = event.target instanceof Element ? event.target.closest('[data-tip]') : null
      return node && host.contains(node) ? node : null
    }

    const show = (element) => {
      const label = element.dataset.tip
      if (!label) return
      window.clearTimeout(hideTimer.current)
      window.clearTimeout(clearTimer.current)
      hovered.current = element
      setTip({ label, key: element.dataset.key || '' })
      const rect = host.getBoundingClientRect()
      const button = element.getBoundingClientRect()
      const above = rect.top - HEIGHT - GAP
      const nextFlipped = above < 8
      setFlipped(nextFlipped)
      setTop(nextFlipped ? rect.bottom + GAP : above)
      // The tail starts under the control rather than sliding in from the old
      // one the first time the tooltip appears.
      if (opacity.get() < 0.05) {
        tail.set(button.left + button.width / 2)
        animate(opacity, 1, reduce ? { duration: 0 } : FADE)
      }
    }

    const leave = () => {
      window.clearTimeout(hideTimer.current)
      hovered.current = null
      hideTimer.current = window.setTimeout(() => {
        if (reduce) {
          opacity.set(0)
          setTip(null)
          return
        }
        animate(opacity, 0, FADE)
        clearTimer.current = window.setTimeout(() => setTip(null), 320)
      }, LEAVE_MS)
    }

    const onOver = (event) => {
      const target = targetOf(event)
      if (!target) return
      if (target === hovered.current) return
      show(target)
    }
    const onOut = (event) => {
      const target = targetOf(event)
      if (!target) return
      const related = event.relatedTarget
      if (related instanceof Element && target.contains(related)) return
      if (target === hovered.current) leave()
    }
    const onFocus = (event) => {
      const target = targetOf(event)
      if (target) show(target)
    }
    const onBlur = () => leave()
    const onScroll = () => {
      if (!hovered.current) return
      const rect = hostRef.current?.getBoundingClientRect()
      if (!rect) return
      setTop(rect.top - HEIGHT - GAP < 8 ? rect.bottom + GAP : rect.top - HEIGHT - GAP)
    }

    host.addEventListener('pointerover', onOver)
    host.addEventListener('pointerout', onOut)
    host.addEventListener('focusin', onFocus)
    host.addEventListener('focusout', onBlur)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      host.removeEventListener('pointerover', onOver)
      host.removeEventListener('pointerout', onOut)
      host.removeEventListener('focusin', onFocus)
      host.removeEventListener('focusout', onBlur)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.clearTimeout(hideTimer.current)
      window.clearTimeout(clearTimer.current)
    }
  }, [hostRef, opacity, reduce, tail])

  // The new label is laid out before this runs, so its measured width is the
  // width both edges have to reach. Direction chooses which edge leads.
  useLayoutEffect(() => {
    if (!tip) return
    const element = hovered.current
    const box = measureRef.current
    if (!element || !box) return
    const button = element.getBoundingClientRect()
    const center = button.left + button.width / 2
    const measured = box.offsetWidth || 120
    const half = measured / 2
    const margin = 8
    const l = clamp(center - half, margin, window.innerWidth - measured - margin)
    const r = l + measured
    const previous = lastCenter.current
    const leading = previous == null ? 0 : Math.sign(center - previous)

    if (previous == null || opacity.get() < 0.05) {
      left.set(l)
      right.set(r)
      tail.set(center)
    } else {
      // Moving right: the right edge leads. Moving left: the left edge does.
      animate(left, l, reduce ? { duration: 0 } : leading >= 0 ? TRAIL : LEAD)
      animate(right, r, reduce ? { duration: 0 } : leading >= 0 ? LEAD : TRAIL)
      animate(tail, center, reduce ? { duration: 0 } : TAIL)
    }
    lastCenter.current = center
  }, [tip, left, right, tail, opacity, reduce])

  if (typeof document === 'undefined') return null

  const node = (
    <motion.div
      className={`morph-tip${className ? ` ${className}` : ''}`}
      role="tooltip"
      aria-hidden={tip ? undefined : 'true'}
      data-flipped={flipped ? '' : undefined}
      style={{ top, left, width, opacity }}
    >
      <span className="morph-tip__label">{tip?.label}</span>
      {tip?.key ? <kbd className="morph-tip__key">{tip.key}</kbd> : null}
    </motion.div>
  )

  const tailNode = (
    <motion.span
      className="morph-tip__tail"
      aria-hidden="true"
      style={{
        top: top + (flipped ? -4 : HEIGHT - 4),
        left: tailX,
        opacity,
      }}
    />
  )

  return createPortal(
    <>
      <div ref={measureRef} className="morph-tip morph-tip--measure" aria-hidden="true">
        <span className="morph-tip__label">{tip?.label}</span>
        {tip?.key ? <kbd className="morph-tip__key">{tip.key}</kbd> : null}
      </div>
      {node}
      {tailNode}
    </>,
    document.body,
  )
}
