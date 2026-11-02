/**
 * Focus management for modal surfaces.
 *
 * Extracted from `ExportDialog.jsx`, which was the only dialog with a real
 * trap: it moved focus in on mount, pulled focus back when it left, and restored
 * it on close. `ModalLayer` had only a fade and a clickable scrim, so Details and
 * Settings let Tab escape to the page behind the scrim, and neither could be
 * closed with Escape -- `App`'s global keydown handler returns early while either
 * is open, so the one key that would have closed them was swallowed.
 *
 * Phases 3, 5 and 6 add four more dialogs. Without this they would each
 * re-implement the trap, and a bug fixed in one would not be fixed in the rest.
 */

import { useEffect, useRef } from 'react'

/**
 * Matches the focusable elements a keyboard user can reach.
 *
 * `:not([tabindex="-1"])` is repeated on every selector on purpose. A negative
 * `tabindex` means "programmatically focusable, not tabbable", and it applies
 * to natively focusable elements too -- so the scrim button, which is
 * `tabIndex={-1}`, must be excluded by each native selector as well as by the
 * attribute one. Without that it stays the first thing Tab lands on, and Tab
 * out of the dialog wraps to a close button that sits before the dialog.
 */
const FOCUSABLE = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Whether an element is hidden, without asking about layout. */
function isHidden(element) {
  if (element.hidden) return true
  if (element.closest?.('[hidden]')) return true
  const view = element.ownerDocument?.defaultView
  if (!view) return false
  const style = view.getComputedStyle(element)
  return style.display === 'none' || style.visibility === 'hidden'
}

/**
 * The focusable descendants of `node`, in tab order, skipping hidden ones.
 *
 * The visibility check is deliberately computed-style rather than layout-based.
 * `offsetParent === null` and an empty `getClientRects()` are the usual ways to
 * spot a `display: none` element in a browser, but jsdom reports `null` and
 * `[]` for *every* element because it has no layout engine -- so those checks
 * made this function return an empty list under test, which quietly reduced the
 * trap to a no-op and left the only passing focus tests passing for the wrong
 * reason: the dialogs focus a field themselves.
 */
export function focusableWithin(node) {
  if (!node) return []
  return [...node.querySelectorAll(FOCUSABLE)].filter((element) => !isHidden(element))
}

/**
 * Traps focus inside `ref` while `active`, and Escape calls `onEscape`.
 *
 * On activation, focus moves to the first focusable control, or to the container
 * itself when there is none, so the dialog is never left entirely unfocused. On
 * deactivation, focus returns to whatever was focused before, which is what makes
 * the invoking button the natural place to resume from.
 *
 * Tab is handled explicitly rather than left to the `focusin` guard alone: a
 * browser's native wrap-around moves focus to the browser chrome, which the
 * `focusin` listener never sees. Handling Tab keeps the cycle inside the dialog.
 */
export function useFocusTrap(ref, active, onEscape) {
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape

  useEffect(() => {
    if (!active) return undefined
    const node = ref.current
    if (!node) return undefined

    const previous = document.activeElement
    const focusables = () => focusableWithin(node)
    ;(focusables()[0] ?? node).focus()

    const onFocusIn = (event) => {
      if (!node.contains(event.target)) (focusables()[0] ?? node).focus()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        // A field with its own Escape handling gets first refusal.
        if (event.defaultPrevented) return
        event.stopPropagation()
        escapeRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) {
        event.preventDefault()
        node.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      // Only intervene at the ends. In the middle, native order is correct and
      // hijacking it would break the expected Tab direction.
      if (event.shiftKey && (current === first || !node.contains(current))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (current === last || !node.contains(current))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown, true)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [active, ref])
}
