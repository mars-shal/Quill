/**
 * Local document versions.
 *
 * Quill has no server account here, so history is a small local ring: the last
 * few distinct snapshots of the document's HTML, kept in the webview's storage.
 * It is deliberately a history of *content*, not a Yjs operation log -- the
 * reader wants to get yesterday's paragraph back, not replay CRDT operations.
 */

const KEY = (docId) => `quill:versions:${docId || 'draft'}`
const MAX_VERSIONS = 25
const MIN_GAP_MS = 60_000

function words(html = '') {
  const text = String(html).replace(/<[^>]+>/g, ' ').trim()
  return text ? text.split(/\s+/).length : 0
}

function excerpt(html = '') {
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

export function listVersions(docId) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(docId)) || '[]')
    return Array.isArray(raw)
      ? raw.filter((entry) => entry && typeof entry.html === 'string' && Number(entry.at) > 0)
      : []
  } catch {
    return []
  }
}

export function recordVersion(docId, html, { force = false } = {}) {
  const value = String(html || '')
  if (!value.trim()) return listVersions(docId)
  const versions = listVersions(docId)
  const last = versions[0]
  const now = Date.now()
  if (!force && last) {
    if (last.html === value) return versions
    if (now - Number(last.at) < MIN_GAP_MS) return versions
  }
  const next = [{
    id: `v${now}-${Math.random().toString(36).slice(2, 7)}`,
    at: now,
    words: words(value),
    excerpt: excerpt(value),
    html: value,
  }, ...versions].slice(0, MAX_VERSIONS)
  try {
    localStorage.setItem(KEY(docId), JSON.stringify(next))
  } catch {
    // History is a convenience; a full quota must not break saving the document.
  }
  return next
}

export function versionTime(at) {
  const date = new Date(Number(at) || Date.now())
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
