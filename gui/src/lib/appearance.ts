export type FontFamily = { group: 'Serif' | 'Sans' | 'Mono'; label: string; css: string; remote?: boolean }

export const THEMES: { id: string; label: string; group: 'Light' | 'Dark' }[] = [
  { id: 'quill', label: 'Quill Warm', group: 'Light' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', group: 'Light' },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', group: 'Light' },
  { id: 'github-light', label: 'GitHub Light', group: 'Light' },
  { id: 'vscode-light', label: 'VS Code Light+', group: 'Light' },
  { id: 'solarized-light', label: 'Solarized Light', group: 'Light' },
  { id: 'gruvbox-light', label: 'Gruvbox Light', group: 'Light' },
  { id: 'everforest-light', label: 'Everforest Light', group: 'Light' },
  { id: 'one-light', label: 'One Light', group: 'Light' },
  { id: 'tokyo-day', label: 'Tokyo Night Day', group: 'Light' },
  { id: 'ayu-light', label: 'Ayu Light', group: 'Light' },
  { id: 'paper', label: 'Paper Light', group: 'Light' },
  { id: 'quill-dark', label: 'Quill Dark', group: 'Dark' },
  { id: 'catppuccin', label: 'Catppuccin Mocha', group: 'Dark' },
  { id: 'rose-pine', label: 'Rosé Pine', group: 'Dark' },
  { id: 'vscode', label: 'VS Code Dark+', group: 'Dark' },
  { id: 'nord', label: 'Nord', group: 'Dark' },
  { id: 'dracula', label: 'Dracula', group: 'Dark' },
  { id: 'one-dark', label: 'One Dark', group: 'Dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', group: 'Dark' },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark', group: 'Dark' },
  { id: 'everforest-dark', label: 'Everforest Dark', group: 'Dark' },
  { id: 'solarized-dark', label: 'Solarized Dark', group: 'Dark' },
  { id: 'kanagawa', label: 'Kanagawa', group: 'Dark' },
  { id: 'ayu-mirage', label: 'Ayu Mirage', group: 'Dark' },
  { id: 'monokai', label: 'Monokai', group: 'Dark' },
  { id: 'synthwave', label: "SynthWave '84", group: 'Dark' },
  { id: 'night-owl', label: 'Night Owl', group: 'Dark' },
  { id: 'material-palenight', label: 'Material Palenight', group: 'Dark' },
  { id: 'github-dark', label: 'GitHub Dark', group: 'Dark' }
]

export const FONT_FAMILIES: FontFamily[] = [
  { group: 'Serif', label: 'Georgia', css: "'Georgia', 'Iowan Old Style', serif" },
  { group: 'Serif', label: 'Palatino', css: "'Palatino Linotype', 'Book Antiqua', Palatino, serif" },
  { group: 'Serif', label: 'Lora', css: "'Lora', 'Georgia', serif" },
  { group: 'Serif', label: 'Literata', css: "'Literata', 'Georgia', serif" },
  { group: 'Serif', label: 'Newsreader', css: "'Newsreader', 'Georgia', serif" },
  { group: 'Serif', label: 'Source Serif 4', css: "'Source Serif 4', 'Georgia', serif" },
  { group: 'Sans', label: 'System', css: "'Inter', 'Segoe UI', system-ui, sans-serif" },
  { group: 'Sans', label: 'Inter', css: "'Inter', system-ui, sans-serif" },
  { group: 'Sans', label: 'Work Sans', css: "'Work Sans', system-ui, sans-serif" },
  { group: 'Sans', label: 'IBM Plex Sans', css: "'IBM Plex Sans', system-ui, sans-serif" },
  { group: 'Mono', label: 'JetBrains Mono', css: "'JetBrains Mono', 'Fira Code', monospace" },
  { group: 'Mono', label: 'IBM Plex Mono', css: "'IBM Plex Mono', 'JetBrains Mono', monospace" }
]

const DEFAULT_FONT = FONT_FAMILIES.find((f) => f.label === 'IBM Plex Sans') ?? FONT_FAMILIES[0]

export function initTheme(): string {
  const saved = localStorage.getItem('quill-theme') || 'quill'
  const theme = THEMES.some((t) => t.id === saved) ? saved : 'quill'
  document.documentElement.dataset.theme = theme
  return theme
}

export function initFont(): { family: string; size: number } {
  const saved = localStorage.getItem('quill-font')
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      if (typeof parsed?.family === 'string' && typeof parsed?.size === 'number') return parsed
    } catch {
      return { family: DEFAULT_FONT.css, size: 17 }
    }
  }
  return { family: DEFAULT_FONT.css, size: 17 }
}

/** Apply the persisted typeface to the editor (CSS vars on the root). */
export function applyFont(font: { family: string; size: number }): void {
  const root = document.documentElement
  root.style.setProperty('--editor-font', font.family)
  root.style.setProperty('--editor-size', `${font.size}px`)
  localStorage.setItem('quill-font', JSON.stringify(font))
}

/** Apply the theme id to the root element (drives the CSS variable palette). */
export function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('quill-theme', theme)
}