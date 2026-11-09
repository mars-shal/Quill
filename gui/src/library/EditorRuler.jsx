import React, { useCallback, useEffect, useRef } from 'react'

/**
 * A page ruler with draggable margin handles.
 *
 * The page is 210 mm wide, so the ruler is the same width and every marker maps
 * directly to a millimetre value. The handles live on the ruler and the page
 * consumes the same two custom properties, which keeps the numbers and the
 * writing column from drifting apart.
 *
 * Dragging listens on `window` rather than on the marker. Pointer capture on a
 * button that is itself moving is easy to lose in a webview, and a lost capture
 * looks exactly like "the ruler does not work": the handle moves one frame and
 * then stops following the pointer. A window listener has no capture to lose.
 */
const PAGE_MM = 210
const MIN_SIDE_MM = 8
const MIN_TEXT_MM = 60

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export function EditorRuler({ left, right, onChange }) {
  const trackRef = useRef(null)
  const dragRef = useRef(null)
  const cleanupRef = useRef(() => {})
  // The latest committed values, read by the document-level listeners. React
  // state inside a listener created on pointerdown would be a snapshot of the
  // render that started the drag.
  const valuesRef = useRef({ left, right })
  valuesRef.current = { left, right }

  const stop = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = () => {}
    dragRef.current = null
  }, [])

  useEffect(() => stop, [stop])

  const millimetresAt = (clientX) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || !rect.width) return null
    return ((clientX - rect.left) / rect.width) * PAGE_MM
  }

  const begin = (side) => (event) => {
    if (event.button != null && event.button !== 0) return
    event.preventDefault()
    if (!trackRef.current) return
    event.currentTarget.focus?.({ preventScroll: true })
    stop()
    dragRef.current = side

    const move = (moveEvent) => {
      if (!dragRef.current) return
      const at = millimetresAt(moveEvent.clientX)
      if (at == null) return
      const { left: currentLeft, right: currentRight } = valuesRef.current
      if (side === 'left') {
        const next = clamp(
          Math.round(at),
          MIN_SIDE_MM,
          PAGE_MM - currentRight - MIN_TEXT_MM,
        )
        if (next !== currentLeft) onChange?.({ left: next, right: currentRight })
      } else {
        const next = clamp(
          Math.round(PAGE_MM - at),
          MIN_SIDE_MM,
          PAGE_MM - currentLeft - MIN_TEXT_MM,
        )
        if (next !== currentRight) onChange?.({ left: currentLeft, right: next })
      }
    }
    const end = () => stop()

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }

  /**
   * A handle is also a control, not only a drag target: arrows move it by a
   * millimetre (Shift: five), Home and End jump to the limits.
   */
  const key = (side) => (event) => {
    const { left: currentLeft, right: currentRight } = valuesRef.current
    const step = event.shiftKey ? 5 : 1
    let next = null
    if (event.key === 'ArrowLeft') next = -step
    else if (event.key === 'ArrowRight') next = step
    else if (event.key === 'Home') next = -PAGE_MM
    else if (event.key === 'End') next = PAGE_MM
    if (next == null) return
    event.preventDefault()
    if (side === 'left') {
      const value = clamp(currentLeft + next, MIN_SIDE_MM, PAGE_MM - currentRight - MIN_TEXT_MM)
      onChange?.({ left: Math.round(value), right: currentRight })
    } else {
      // ArrowLeft on the right handle widens the margin, so it moves the edge
      // left on the ruler. Inverting here is what makes the key feel spatial.
      const value = clamp(currentRight - next, MIN_SIDE_MM, PAGE_MM - currentLeft - MIN_TEXT_MM)
      onChange?.({ left: currentLeft, right: Math.round(value) })
    }
  }

  return (
    <div className="editor-ruler" aria-label="Page margins">
      <div className="editor-ruler-track" ref={trackRef}>
        <span className="editor-ruler-shade" style={{ width: `${(left / PAGE_MM) * 100}%` }} />
        <span className="editor-ruler-shade is-right" style={{ width: `${(right / PAGE_MM) * 100}%` }} />
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((inch) => (
          <span className="editor-ruler-tick" key={inch} style={{ left: `${(inch / 8.27) * 100}%` }}>
            <i>{inch}</i>
          </span>
        ))}
        <span className="editor-ruler-readout" aria-hidden="true">
          {left} / {right} mm
        </span>
        <button
          className="editor-ruler-marker is-left"
          type="button"
          aria-label={`Left margin ${left} millimetres`}
          aria-valuetext={`${left} millimetres`}
          style={{ left: `${(left / PAGE_MM) * 100}%` }}
          onPointerDown={begin('left')}
          onKeyDown={key('left')}
        />
        <button
          className="editor-ruler-marker is-right"
          type="button"
          aria-label={`Right margin ${right} millimetres`}
          aria-valuetext={`${right} millimetres`}
          style={{ left: `${((PAGE_MM - right) / PAGE_MM) * 100}%` }}
          onPointerDown={begin('right')}
          onKeyDown={key('right')}
        />
      </div>
    </div>
  )
}
