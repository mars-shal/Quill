/* Google Fonts Developer API client (webfonts/v1). Fetch once, cache, then
 * inject css2 stylesheet links at runtime when a remote family is picked.
 * The API key comes from the runtime environment (GOOGLE_FONTS_KEY in the
 * root .env), not from this source file: the repo is public. Without a key
 * the catalog is empty and only the bundled fonts are offered. */

const GOOGLE_FONTS_API = 'https://www.googleapis.com/webfonts/v1/webfonts'

export interface GoogleFontItem {
  family: string
  category: string
}

let cache: GoogleFontItem[] | null = null

export async function fetchGoogleFonts(): Promise<GoogleFontItem[]> {
  if (cache) return cache
  const key = window.quill ? await window.quill.googleFontsKey() : ''
  if (!key) return []
  const res = await fetch(`${GOOGLE_FONTS_API}?key=${key}&sort=popularity`)
  if (!res.ok) throw new Error(`Google Fonts API ${res.status}`)
  const data = (await res.json()) as { items: GoogleFontItem[] }
  cache = data.items
  return cache
}

export function googleFontCss(family: string, category: string): string {
  const fallback = category === 'monospace' ? 'monospace' : category === 'serif' ? 'serif' : 'sans-serif'
  return `'${family}', ${fallback}`
}

export function loadGoogleFont(family: string): void {
  const id = `gf-${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  if (document.getElementById(id)) return
  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=swap`
  document.head.appendChild(link)
}