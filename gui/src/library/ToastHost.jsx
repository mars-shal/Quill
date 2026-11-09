import React, { useEffect, useState } from 'react'
import { Icon } from '../Icon.jsx'
import { subscribeToasts } from './toast.js'

/**
 * The one place errors surface. It is mounted for the whole app, so a failed
 * save, import or assistant turn is visible even when the editor panel is
 * collapsed. Toasts are polite status, not dialogs: they never take focus.
 */
export function ToastHost() {
  const [items, setItems] = useState([])

  useEffect(() => subscribeToasts((item) => {
    setItems((current) => [...current.slice(-3), item])
    window.setTimeout(() => {
      setItems((current) => current.filter((entry) => entry.id !== item.id))
    }, item.timeout)
  }), [])

  if (!items.length) return null
  return (
    <div className="toast-host" role="region" aria-label="Notifications" aria-live="polite">
      {items.map((item) => (
        <div className={`toast toast--${item.kind}`} role="status" key={item.id}>
          <Icon name="details" size={14} />
          <span>{item.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
