/**
 * Keeps the local writing profile current without a button.
 *
 * The profile is built only from the reader's own library and is entirely
 * local, so refreshing it is cheap: one deterministic pass over the text. The
 * cadence still matters, because the library's `docs` array changes on every
 * autosave. Rebuilding on each of those would spend CPU on prose that has not
 * changed enough to move the metrics.
 *
 * Rules:
 *   - at launch, a profile older than a week is rebuilt;
 *   - when the number of documents changes (a create, import, delete or
 *     restore), a profile older than a day is rebuilt;
 *   - saves debounce for a few seconds so typing does not restart the pass on
 *     every keystroke.
 */

import { useEffect, useRef } from 'react'
import { profileWritingStyle } from '../platform/store.js'

export const PROFILE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const PROFILE_DAY_MS = 24 * 60 * 60 * 1000
const SETTLE_MS = 2500
const LIBRARY_SETTLE_MS = 6000

/** Epoch milliseconds of the last build, or null for a missing/invalid one. */
export function profileBuiltAt(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    const at = Date.parse(parsed?.builtAt || '')
    return Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

/** Whether the stored profile is old enough to warrant another pass. */
export function profileNeedsRefresh(value, documentCount, now = Date.now()) {
  const builtAt = profileBuiltAt(value)
  if (builtAt === null) return true
  let stored = null
  try {
    stored = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return true
  }
  const countChanged = Number(stored?.documents) !== Number(documentCount)
  return now - builtAt >= (countChanged ? PROFILE_DAY_MS : PROFILE_WEEK_MS)
}

function profilePayload(result) {
  return JSON.stringify({
    ...(result?.profile || {}),
    prompt: result?.prompt || '',
    builtAt: new Date().toISOString(),
  })
}

/**
 * Runs the profile pass when it is due. `onChange` receives the JSON string the
 * settings row stores.
 */
export function useAutomaticWritingProfile({
  documents = [],
  writingProfile = '',
  onChange,
  enabled = true,
}) {
  const timer = useRef(null)
  const running = useRef(false)

  useEffect(() => {
    if (!enabled || !documents.length || typeof onChange !== 'function') return undefined
    if (!profileNeedsRefresh(writingProfile, documents.length)) return undefined

    const texts = documents
      .map((document) => String(document.content || ''))
      .filter((text) => text.trim())
    if (!texts.length) return undefined

    // A changed library is worth reflecting quickly; a save is not. The longer
    // delay is what keeps an autosave every 1.5s from restarting the pass.
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (running.current) return
      running.current = true
      profileWritingStyle({ texts })
        .then((result) => onChange(profilePayload(result)))
        .catch((error) => console.warn('Automatic writing profile failed', error))
        .finally(() => {
          running.current = false
        })
    }, (
      profileBuiltAt(writingProfile) === null ? SETTLE_MS : LIBRARY_SETTLE_MS
    ))

    return () => {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [documents, writingProfile, onChange, enabled])
}
