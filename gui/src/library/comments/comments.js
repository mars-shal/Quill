/** Local comment threads, keyed by document. */
const KEY = (docId) => `quill:comments:${docId || 'draft'}`

export function listComments(docId) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(docId)) || '[]')
    return Array.isArray(raw) ? raw.filter((entry) => entry && typeof entry.text === 'string') : []
  } catch {
    return []
  }
}

export function addComment(docId, { id, quote, text }) {
  const next = [{
    id,
    quote: String(quote || '').trim().slice(0, 280),
    text: String(text || '').trim(),
    at: Date.now(),
  }, ...listComments(docId)]
  try { localStorage.setItem(KEY(docId), JSON.stringify(next)) } catch { /* local only */ }
  return next
}

export function removeComment(docId, id) {
  const next = listComments(docId).filter((entry) => entry.id !== id)
  try { localStorage.setItem(KEY(docId), JSON.stringify(next)) } catch { /* local only */ }
  return next
}
