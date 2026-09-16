import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { THEMES } from '../lib/appearance'
import { Loader2, Pencil } from 'lucide-react'
import { loadGoogleFont } from '../lib/googleFonts'
import type { FontFamily } from '../lib/appearance'

interface ModelEntry {
  name: string
  base_url: string
  model: string
  models: string[]
  ready: boolean
  local: boolean
  builtin?: boolean
  in_file?: boolean
}

export default function SettingsScreen() {
  const settingsOpen = useStore((s) => s.settingsOpen)
  const toggleSettings = useStore((s) => s.toggleSettings)
  const theme = useStore((s) => s.theme)
  const font = useStore((s) => s.font)
  const fontFamilies = useStore((s) => s.fontFamilies)
  const setTheme = useStore((s) => s.setTheme)
  const setFont = useStore((s) => s.setFont)
  const loadFontCatalog = useStore((s) => s.loadFontCatalog)
  const api = useStore((s) => s.api)
  const showToast = useStore((s) => s.showToast)

  const [config, setConfig] = useState({ name: '', base_url: '', api_key: '', model: '' })
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [providers, setProviders] = useState<ModelEntry[] | null>(null)
  const [current, setCurrent] = useState<{ name: string; model: string } | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  useEffect(() => {
    if (!settingsOpen) return
    void loadFontCatalog()
    if (api) {
      api
        .getModels()
        .then((out) => {
          setProviders(out.providers)
          setCurrent(out.current)
        })
        .catch(() => setProviders([]))
    }
  }, [settingsOpen, api, loadFontCatalog])

  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawerOpen) {
          setDrawerOpen(false)
          setEditing(null)
        } else toggleSettings(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, drawerOpen, toggleSettings])

  if (!settingsOpen) return null

  async function saveProvider() {
    if (!api) return
    const name = config.name.trim().toLowerCase()
    if (!name || !config.base_url.trim()) {
      showToast('Provider name and base URL are required')
      return
    }
    setSaving(true)
    try {
      const out = await api.configureProvider({
        name,
        base_url: config.base_url.trim(),
        api_key: config.api_key.trim(),
        model: config.model.trim() || undefined
      })
      await useStore.getState().refreshHealth()
      const fresh = await api.getModels()
      setProviders(fresh.providers)
      setCurrent(fresh.current)
      setConfig({ name: '', base_url: '', api_key: '', model: '' })
      setEditing(null)
      setDrawerOpen(false)
      const count = out.models.length
      showToast(
        editing
          ? `Saved ${name} · ${count} model${count === 1 ? '' : 's'} available.`
          : `Connected ${name} · ${count} model${count === 1 ? '' : 's'} available.`
      )
    } catch (error) {
      showToast(
        editing ? `Could not save provider: ${String(error)}` : `Could not connect provider: ${String(error)}`
      )
    } finally {
      setSaving(false)
    }
  }

  async function selectModel(entry: ModelEntry, model: string) {
    if (!api || switching || (current?.name === entry.name && current?.model === model)) return
    const key = `${entry.name}/${model}`
    setSwitching(key)
    try {
      await api.selectModel(entry.name, model)
      await useStore.getState().refreshHealth()
      const fresh = await api.getModels()
      setProviders(fresh.providers)
      setCurrent(fresh.current)
      showToast(`Model set — ${entry.name} · ${model}`)
    } catch (error) {
      showToast(`Could not switch model: ${String(error)}`)
    } finally {
      setSwitching(null)
    }
  }

  async function deleteProvider(entry: ModelEntry) {
    if (!api || deleting) return
    if (!window.confirm(`Remove provider "${entry.name}"? Its models and key will be deleted.`)) return
    setDeleting(entry.name)
    try {
      await api.deleteProvider(entry.name)
      await useStore.getState().refreshHealth()
      const fresh = await api.getModels()
      setProviders(fresh.providers)
      setCurrent(fresh.current)
      showToast(`Removed provider — ${entry.name}`)
    } catch (error) {
      showToast(`Could not remove provider: ${String(error)}`)
    } finally {
      setDeleting(null)
    }
  }

  function startEdit(entry: ModelEntry) {
    setEditing(entry.name)
    setConfig({
      name: entry.name,
      base_url: entry.base_url,
      api_key: '',
      model: entry.model === 'default' || entry.model === '' ? '' : entry.model
    })
    setDrawerOpen(true)
  }

  function openConnect() {
    setEditing(null)
    setConfig({ name: '', base_url: '', api_key: '', model: '' })
    setDrawerOpen(true)
  }

  return (
    <div className="theme-backdrop settings-backdrop" onClick={() => toggleSettings(false)}>
      <div
        className="theme-modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="theme-modal-head">
          <div className="font-popover-label">Settings</div>
          <button className="ghost" onClick={() => toggleSettings(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="theme-modal-scroll">
          <AppearanceSection
            theme={theme}
            font={font}
            fontFamilies={fontFamilies}
            setTheme={setTheme}
            setFont={setFont}
          />

          <section className="settings-section">
            <div className="settings-section-title">AI</div>
            {current && (
              <div className="settings-current-model">
                In use — {current.name} · {current.model}
              </div>
            )}
            <button
              className="model-option primary connect-provider-btn"
              onClick={openConnect}
            >
              + Connect a provider
            </button>
            {providers !== null && providers.length > 0 && (
              <div className="settings-providers">
                {providers.map((entry) => (
                  <div key={entry.name} className="model-group">
                    <div className="model-group-label">
                      {entry.name}
                      {entry.local ? ' · local' : entry.ready ? ' · ready' : ' · no key'}
                      {entry.in_file && (
                        <span className="model-group-buttons">
                          <button
                            className="model-edit"
                            disabled={deleting !== null}
                            onClick={() => startEdit(entry)}
                            title={`Edit ${entry.name}`}
                            aria-label={`Edit ${entry.name}`}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            className="model-delete"
                            disabled={deleting !== null}
                            onClick={() => void deleteProvider(entry)}
                            title={`Remove ${entry.name}`}
                          >
                            {deleting === entry.name ? <Loader2 size={12} className="spin" /> : '✕'}
                          </button>
                        </span>
                      )}
                    </div>
                    {entry.models.length > 0 && (
                      <select
                        className="model-select"
                        value={current?.name === entry.name && entry.models.includes(current.model) ? current.model : ''}
                        disabled={switching !== null}
                        onChange={(e) => {
                          if (e.target.value) void selectModel(entry, e.target.value)
                        }}
                      >
                        <option value="" disabled>
                          {current?.name === entry.name ? current.model : `select ${entry.name} model…`}
                        </option>
                        {entry.models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
        {drawerOpen && (
          <div
            className="connect-drawer-backdrop"
            onClick={() => {
              setDrawerOpen(false)
              setEditing(null)
            }}
          >
            <div
              className="connect-drawer"
              role="dialog"
              aria-modal="true"
              aria-label={editing ? `Edit provider ${editing}` : 'Connect a provider'}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="connect-drawer-head">
                <div className="font-popover-label">
                  {editing ? 'Edit provider' : 'Connect a provider'}
                </div>
                <button
                  className="ghost"
                  onClick={() => {
                    setDrawerOpen(false)
                    setEditing(null)
                  }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <div className="connect-drawer-body">
                <input
                  placeholder="name (e.g. my-openai)"
                  value={config.name}
                  disabled={saving || editing !== null}
                  autoFocus={!editing}
                  onChange={(e) => setConfig((c) => ({ ...c, name: e.target.value }))}
                />
                <input
                  placeholder="base URL (https://api.example.com/v1)"
                  value={config.base_url}
                  disabled={saving}
                  onChange={(e) => setConfig((c) => ({ ...c, base_url: e.target.value }))}
                />
                <input
                  placeholder={editing ? 'API key (leave blank to keep current)' : 'API key'}
                  value={config.api_key}
                  disabled={saving}
                  onChange={(e) => setConfig((c) => ({ ...c, api_key: e.target.value }))}
                />
                <input
                  placeholder="default model (optional)"
                  value={config.model}
                  disabled={saving}
                  onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
                />
              </div>
              <div className="connect-drawer-actions">
                <button
                  className="model-option"
                  disabled={saving}
                  onClick={() => {
                    setDrawerOpen(false)
                    setEditing(null)
                  }}
                >
                  Cancel
                </button>
                <button className="model-option primary" disabled={saving} onClick={() => void saveProvider()}>
                  {saving ? <Loader2 size={12} className="spin" /> : null}
                  {saving ? (editing ? 'Saving…' : 'Connecting…') : editing ? 'Save' : 'Connect'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function AppearanceSection({
  theme,
  font,
  fontFamilies,
  setTheme,
  setFont
}: {
  theme: string
  font: { family: string; size: number }
  fontFamilies: FontFamily[]
  setTheme: (t: string) => void
  setFont: (f: { family: string; size: number }) => void
}) {
  const applyFamily = (css: string, label: string) => {
    if (fontFamilies.find((f) => f.css === css)?.remote) loadGoogleFont(label)
    setFont({ ...font, family: css })
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">Style</div>

      <label className="settings-field">
        <span className="settings-field-label">Theme</span>
        <select value={theme} onChange={(e) => setTheme(e.target.value)}>
          {(['Light', 'Dark'] as const).map((group) => (
            <optgroup key={group} label={group}>
              {THEMES.filter((t) => t.group === group).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span className="settings-field-label">Typeface</span>
        <select
          value={font.family}
          onChange={(e) => {
            const entry = fontFamilies.find((f) => f.css === e.target.value)
            applyFamily(e.target.value, entry?.label ?? '')
          }}
        >
          {(['Serif', 'Sans', 'Mono'] as const).map((group) => (
            <optgroup key={group} label={group}>
              {fontFamilies.filter((f) => f.group === group).map((f) => (
                <option key={f.label} value={f.css} style={{ fontFamily: f.css }}>
                  {f.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span className="settings-field-label">Text size · {font.size}px</span>
        <input
          type="range"
          min={14}
          max={24}
          step={1}
          value={font.size}
          onChange={(e) => setFont({ ...font, size: Number(e.target.value) })}
        />
      </label>
    </section>
  )
}