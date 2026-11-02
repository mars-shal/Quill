/**
 * The account-area wording, which is a data problem before it is a design one.
 *
 * The backend reports two booleans. `online: false` covers both "sync is
 * switched off" and "the server did not answer", and sign-in does not turn sync
 * on, so those two readers are indistinguishable from the fields alone. A single
 * "Offline" badge then lies to one of them, which is why `describeAccount` has
 * four outcomes and this file pins every one of them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { configWriteArgs, describeAccount } from '../src/library/account.js'

const signedIn = (overrides = {}) => ({
  signedIn: true,
  account: { id: 'abc', email: 'mara@quill.work', name: 'Mara Lee', workspace: 'Personal' },
  online: false,
  syncEnabled: true,
  baseUrl: 'https://sync.example.com',
  ...overrides,
})

test('no state at all is signed out, not broken', () => {
  // `useAccount` resolves before the first command returns, so `undefined` is a
  // normal value the chip has to render rather than a case to guard at the call
  // site. Signed-out is a fully valid state for a local-only reader.
  for (const state of [undefined, null, {}, { signedIn: false }]) {
    const described = describeAccount(state)
    assert.equal(described.situation, 'signed-out')
    assert.equal(described.label, 'Not signed in')
    assert.equal(described.detail, 'Local only')
    assert.equal(described.initials, '', 'no initials on a chip with nobody in it')
  }
})

test('a mirror that exists but is signed out renders as signed out', () => {
  // `signedIn: false` with a populated account is not a state the backend
  // produces, but rendering a name for a reader who is not signed in is exactly
  // the class of bug the four outcomes exist to prevent, so it is pinned.
  const described = describeAccount({ signedIn: false, account: { id: 'x', email: 'a@b.co', name: 'A B' } })
  assert.equal(described.situation, 'signed-out')
  assert.equal(described.initials, '')
})

test('every signed-in outcome says it is signed in', () => {
  // The components branch on `described.signedIn`. When this field was missing
  // from the signed-in returns, the chip rendered correctly -- it read `label`
  // and `email` -- while the sheet underneath rendered its signed-out form, so
  // the sync toggle was unreachable for a reader who had just signed in.
  for (const overrides of [
    { online: true },
    { online: false, syncEnabled: false },
    { online: false, syncEnabled: true },
  ]) {
    const described = describeAccount(signedIn(overrides))
    assert.equal(described.signedIn, true, `${described.situation} should read as signed in`)
    assert.ok(described.sync, `${described.situation} should describe its sync state`)
  }
})

test('signed in with sync on and the server answering is the happy case', () => {
  const described = describeAccount(signedIn({ online: true }))
  assert.equal(described.situation, 'live')
  assert.equal(described.label, 'Mara Lee')
  assert.equal(described.detail, 'Syncing')
  assert.equal(described.tone, 'live')
  assert.equal(described.sync.detail, 'https://sync.example.com')
})

test('signed in and opted out is not reported as offline', () => {
  // This is the bug. `online` is false here because sync was never switched on,
  // not because anything failed, and a two-state badge shows "Offline" here.
  const described = describeAccount(signedIn({ syncEnabled: false, online: false }))
  assert.equal(described.situation, 'opted-out')
  assert.equal(described.detail, 'Sync off')
  assert.equal(described.tone, 'idle')
  assert.match(described.sync.label, /off/i)
  assert.doesNotMatch(
    described.sync.label,
    /unreachable|offline/i,
    'nothing was asked of a server, so no server can be unreachable',
  )
})

test('signed in with sync on and no answer is the one that is unreachable', () => {
  const described = describeAccount(signedIn({ syncEnabled: true, online: false }))
  assert.equal(described.situation, 'unreachable')
  assert.equal(described.tone, 'warn')
  assert.match(described.sync.label, /unreachable/i)
  // The reassurance is the point of the message: a reader seeing a warning
  // about their sync server needs to know their writing is not in question.
  assert.match(described.sync.detail, /safe|will go up/i)
})

test('opted-out and unreachable are distinguishable, which was the whole point', () => {
  const optedOut = describeAccount(signedIn({ syncEnabled: false, online: false }))
  const unreachable = describeAccount(signedIn({ syncEnabled: true, online: false }))
  assert.notEqual(optedOut.situation, unreachable.situation)
  assert.notEqual(optedOut.detail, unreachable.detail)
  assert.notEqual(optedOut.tone, unreachable.tone)
})

test('a reader who signed up with only an email still gets a chip', () => {
  const described = describeAccount(
    signedIn({ account: { id: 'x', email: 'sam@example.com', name: '', workspace: 'Personal' } }),
  )
  assert.equal(described.initials, 'S', 'first letter of the local part')
  assert.equal(described.label, 'sam@example.com', 'and the email stands in for the name')
})

test('initials come from the name, up to two of them', () => {
  const cases = [
    ['Mara Lee', 'ML'],
    // First and last word, so a hyphen keeps the first name together: "JL" would
    // read as the wrong person's initials.
    ['Jean-Luc Picard', 'JP'],
    ['mara', 'M'],
    ['  padded   name  ', 'PN'],
    ['A B C D', 'AB'],
  ]
  for (const [name, expected] of cases) {
    assert.equal(describeAccount(signedIn({ account: { id: 'x', email: 'e@x.co', name, workspace: 'w' } })).initials, expected, name)
  }
})

test('flipping the toggle has to echo the endpoint back', () => {
  // `sync_config_write` overwrites both columns. Sending only the flag would
  // point the reader's account at the build-time default and fail with a
  // network error much later, so the echo lives in one place.
  assert.deepEqual(configWriteArgs('https://sync.example.com', true), {
    baseUrl: 'https://sync.example.com',
    syncEnabled: true,
  })
  assert.deepEqual(configWriteArgs('https://sync.example.com', false), {
    baseUrl: 'https://sync.example.com',
    syncEnabled: false,
  })
  assert.deepEqual(configWriteArgs(undefined, true), { baseUrl: '', syncEnabled: true })
})
