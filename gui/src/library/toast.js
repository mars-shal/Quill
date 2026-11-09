/**
 * A tiny app-wide notice bus.
 *
 * Errors used to disappear into `console.error` or a composer line that is
 * clipped when the panel is narrow. A toast is the one surface that can say
 * "this failed" without taking the caret away from the editor.
 */
const listeners = new Set()
let sequence = 0

export function notify(message, { kind = 'error', timeout = 6000 } = {}) {
  const text = String(message || '').trim()
  if (!text) return 0
  const item = { id: ++sequence, message: text, kind, timeout }
  for (const listener of listeners) listener(item)
  return item.id
}

export function subscribeToasts(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
