/**
 * Chat sessions for one document.
 *
 * The assistant used to keep exactly one transcript per document. Asking a new
 * question after "New chat" overwrote the previous conversation, and there was
 * no way back to it. A session is the same `{messages}` record with a stable id,
 * a title taken from its first question, and a timestamp, kept in a small list
 * under the document's key.
 *
 * The old `quill:chat-transcript:v1` records are still read once so an upgrade
 * does not strand the conversation a reader already had.
 */

export const TRANSCRIPT_KEY = 'quill:chat-transcript:v1'
export const SESSIONS_KEY = 'quill:chat-sessions:v1'
export const WELCOME = 'I’m here when you want a second pair of eyes. I can summarize, tighten, or find a pattern in the draft.'
const MAX_MESSAGES = 200

const scoped = (base, documentId) => (documentId ? `${base}:${documentId}` : base)

export function newChatSession(messages) {
  const now = Date.now()
  const list = Array.isArray(messages) && messages.length
    ? messages
    : [{ id: 'welcome', role: 'ai', text: WELCOME }]
  return {
    id: `chat-${now}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
    title: titleForMessages(list),
    messages: list,
  }
}

/** The first thing the reader asked, as a short list label. */
export function titleForMessages(messages = []) {
  const first = messages.find((message) => message?.role === 'user' && String(message?.text || '').trim())
  if (!first) return 'New conversation'
  const text = String(first.text).replace(/\s+/g, ' ').trim()
  return text.length > 42 ? `${text.slice(0, 41).trimEnd()}…` : text
}

export function sessionAge(at, now = Date.now()) {
  const delta = Math.max(0, Number(now) - Number(at || 0))
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`
  return new Date(Number(at) || now).toLocaleDateString()
}

function normaliseSession(session) {
  const messages = Array.isArray(session?.messages) && session.messages.length
    ? session.messages
    : [{ id: 'welcome', role: 'ai', text: WELCOME }]
  return {
    id: String(session?.id || `chat-${Date.now()}`),
    createdAt: Number(session?.createdAt) || Date.now(),
    updatedAt: Number(session?.updatedAt) || Date.now(),
    title: String(session?.title || titleForMessages(messages)),
    messages,
  }
}

/** Loads the document's sessions, migrating the legacy single transcript. */
export function loadChatSessions(documentId, storage) {
  if (storage) {
    try {
      const saved = JSON.parse(storage.getItem(scoped(SESSIONS_KEY, documentId)) || 'null')
      if (Array.isArray(saved?.sessions) && saved.sessions.length) {
        const sessions = saved.sessions.map(normaliseSession)
        const activeId = sessions.some((session) => session.id === saved.activeId)
          ? saved.activeId
          : sessions[0].id
        return { sessions, activeId }
      }
    } catch {
      // A broken record is replaced by a fresh conversation below.
    }

    const legacy = storage.getItem(scoped(TRANSCRIPT_KEY, documentId))
      || (documentId ? storage.getItem(TRANSCRIPT_KEY) : null)
    if (legacy) {
      try {
        const previous = JSON.parse(legacy)
        if (Array.isArray(previous?.messages) && previous.messages.length) {
          const session = newChatSession(previous.messages)
          return { sessions: [session], activeId: session.id }
        }
      } catch {
        // Ignore the old record and start clean.
      }
    }
  }

  const session = newChatSession()
  return { sessions: [session], activeId: session.id }
}

export function saveChatSessions(documentId, state, storage) {
  if (!storage) return
  const sessions = (state?.sessions || []).map((session) => ({
    ...session,
    messages: session.messages.slice(-MAX_MESSAGES),
  }))
  storage.setItem(
    scoped(SESSIONS_KEY, documentId),
    JSON.stringify({ activeId: state?.activeId || sessions[0]?.id || '', sessions }),
  )
}

export function switchChatSession(state, id) {
  if (!state?.sessions?.some((session) => session.id === id)) return state
  return { ...state, activeId: id }
}

/** Removes a session, leaving one fresh conversation when the last one goes. */
export function deleteChatSession(state, id) {
  const remaining = (state?.sessions || []).filter((session) => session.id !== id)
  if (!remaining.length) {
    const session = newChatSession()
    return { sessions: [session], activeId: session.id }
  }
  return {
    sessions: remaining,
    activeId: state.activeId === id ? remaining[0].id : state.activeId,
  }
}
