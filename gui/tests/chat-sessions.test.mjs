/**
 * Chat sessions are per document and never overwrite one another.
 *
 * The old store held one transcript per document, so "New chat" destroyed the
 * previous conversation. These tests pin the list, the legacy migration and the
 * title that makes a session recognisable in the picker.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TRANSCRIPT_KEY,
  WELCOME,
  deleteChatSession,
  loadChatSessions,
  newChatSession,
  saveChatSessions,
  sessionAge,
  switchChatSession,
  titleForMessages,
} from '../src/library/chatSessions.js'

function memory(initial = {}) {
  const values = { ...initial }
  return {
    getItem: (key) => (key in values ? values[key] : null),
    setItem: (key, value) => { values[key] = String(value) },
    removeItem: (key) => { delete values[key] },
    values,
  }
}

test('a fresh document opens one welcome conversation', () => {
  const state = loadChatSessions('doc-a', memory())
  assert.equal(state.sessions.length, 1)
  assert.equal(state.activeId, state.sessions[0].id)
  assert.equal(state.sessions[0].messages[0].text, WELCOME)
})

test('the legacy single transcript is migrated, not lost', () => {
  const storage = memory({
    [`${TRANSCRIPT_KEY}:doc-a`]: JSON.stringify({
      messages: [{ id: 'm1', role: 'user', text: 'where is the abstract?' }],
    }),
  })
  const state = loadChatSessions('doc-a', storage)
  assert.equal(state.sessions.length, 1)
  assert.equal(state.sessions[0].messages[0].text, 'where is the abstract?')
  assert.equal(state.sessions[0].title, 'where is the abstract?')
})

test('sessions round-trip with their active id', () => {
  const storage = memory()
  const first = newChatSession()
  const second = newChatSession()
  saveChatSessions('doc-b', { sessions: [first, second], activeId: second.id }, storage)
  const loaded = loadChatSessions('doc-b', storage)
  assert.deepEqual(loaded.sessions.map((session) => session.id), [first.id, second.id])
  assert.equal(loaded.activeId, second.id)
})

test('a session is titled by its first question', () => {
  const messages = [
    { role: 'ai', text: WELCOME },
    { role: 'user', text: 'Can you tighten the introduction into a shorter version?' },
  ]
  assert.match(titleForMessages(messages), /^Can you tighten/)
  assert.ok(titleForMessages(messages).length <= 42)
  assert.equal(titleForMessages([]), 'New conversation')
})

test('deleting the active session selects another, and the last one regenerates', () => {
  const first = newChatSession()
  const second = newChatSession()
  const state = { sessions: [first, second], activeId: first.id }
  const after = deleteChatSession(state, first.id)
  assert.deepEqual(after.sessions.map((session) => session.id), [second.id])
  assert.equal(after.activeId, second.id)

  const empty = deleteChatSession({ sessions: [second], activeId: second.id }, second.id)
  assert.equal(empty.sessions.length, 1)
  assert.notEqual(empty.sessions[0].id, second.id)
})

test('switching to an unknown session is a no-op', () => {
  const state = { sessions: [newChatSession()], activeId: 'first' }
  assert.equal(switchChatSession(state, 'missing'), state)
})

test('session ages stay short for the picker', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  assert.equal(sessionAge(now - 5_000, now), 'just now')
  assert.equal(sessionAge(now - 5 * 60_000, now), '5m ago')
  assert.equal(sessionAge(now - 3 * 3_600_000, now), '3h ago')
  assert.equal(sessionAge(now - 2 * 86_400_000, now), '2d ago')
})
