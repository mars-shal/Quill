/**
 * Top-level error boundary.
 *
 * Without this, any throw during render unmounts the whole tree and the window
 * goes blank with nothing on screen and nothing in the UI to explain why. This
 * turns a crash into a readable message, and keeps the stack in the console.
 */

import React, { Suspense } from 'react'
import { Button } from './library/ui/button.jsx'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    console.error('Quill crashed while rendering', error, info?.componentStack)
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    // A decorative effect is never worth losing the editor over. When a
    // `fallback` is supplied the boundary degrades to it and logs, instead of
    // replacing the screen with the crash page.
    if (this.props.fallback !== undefined) {
      console.warn('Effect disabled after a render error', error)
      return this.props.fallback ?? null
    }

    return (
      <div className="boot-screen boot-error" role="alert">
        <div className="boot-mark">
          <img src="/quill-mark.png" alt="" />
        </div>
        <h1>Quill hit an unexpected error</h1>
        <p>{error?.message ?? String(error)}</p>
        {info?.componentStack ? (
          <details className="boot-stack">
            <summary>Technical detail</summary>
            <pre>{info.componentStack}</pre>
          </details>
        ) : null}
        <Button type="button" className="soft-button" onClick={() => window.location.reload()}>
          Reload Quill
        </Button>
      </div>
    )
  }
}

/**
 * Isolates a decorative effect from the rest of the tree.
 *
 * The canvas and WebGL effects in the assistant panel are enhancement only.
 * `metal-fx` in particular throws during render when WebGL2 is missing, and
 * without a local boundary that throw reached the top-level boundary and
 * unmounted the entire editor. `fallback` is the plain, undecorated version of
 * the same control, so the feature disappears and the app keeps working.
 *
 * It is also the `Suspense` boundary for them, because every one of those
 * effects is behind a `React.lazy` import (`library/chat-effects.js`). The same
 * `fallback` serves both jobs and that is the point: an effect that has not
 * finished loading and an effect that cannot run at all are the same situation
 * to a reader -- the feature is not there yet -- and they should degrade to the
 * same plain control rather than to two different placeholders.
 */
export function EffectBoundary({ fallback = null, children }) {
  return (
    <ErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ErrorBoundary>
  )
}

export default ErrorBoundary
