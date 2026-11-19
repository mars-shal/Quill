/**
 * The writing profile refreshes itself.
 *
 * The cadence is the contract: a week-old profile is refreshed at launch, and
 * a changed library (create, import, delete, restore) refreshes a day-old one.
 * A save does not, because autosave changes the `docs` array every 1.5s and a
 * pass per keystroke would be work for prose that has not moved the metrics.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROFILE_DAY_MS,
  PROFILE_WEEK_MS,
  profileBuiltAt,
  profileNeedsRefresh,
} from '../src/library/useWritingProfile.js'

function stored(builtAt, documents) {
  return JSON.stringify({ builtAt, documents })
}

test('a missing or malformed profile is always due', () => {
  assert.equal(profileNeedsRefresh('', 3), true)
  assert.equal(profileNeedsRefresh('not json', 3), true)
  assert.equal(profileNeedsRefresh(JSON.stringify({ documents: 3 }), 3), true)
  assert.equal(profileBuiltAt(''), null)
})

test('a week-old profile is due even when the library is unchanged', () => {
  const now = Date.parse('2026-11-15T12:00:00Z')
  const old = new Date(now - PROFILE_WEEK_MS - 1000).toISOString()
  assert.equal(profileNeedsRefresh(stored(old, 4), 4, now), true)
})

test('a fresh profile is left alone while the library is unchanged', () => {
  const now = Date.parse('2026-11-15T12:00:00Z')
  const fresh = new Date(now - 60 * 60 * 1000).toISOString()
  assert.equal(profileNeedsRefresh(stored(fresh, 4), 4, now), false)
})

test('a changed library refreshes a day-old profile', () => {
  const now = Date.parse('2026-11-15T12:00:00Z')
  const dayOld = new Date(now - PROFILE_DAY_MS - 1000).toISOString()
  assert.equal(profileNeedsRefresh(stored(dayOld, 4), 5, now), true)
})

test('a changed library leaves a same-hour profile alone', () => {
  const now = Date.parse('2026-11-15T12:00:00Z')
  const fresh = new Date(now - 5 * 60 * 1000).toISOString()
  assert.equal(profileNeedsRefresh(stored(fresh, 4), 5, now), false)
})
