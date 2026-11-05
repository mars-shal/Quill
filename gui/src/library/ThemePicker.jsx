/**
 * The theme picker: built-in themes, saved themes, and the editor for a new one.
 *
 * Three decisions worth stating, because the obvious alternative is wrong in each
 * case.
 *
 * It applies immediately rather than waiting for anything to be confirmed. A
 * theme is the one setting you cannot judge from a dropdown -- "Sepia" says
 * nothing about whether the body text is legible over the sidebar -- and a
 * preview that only appears after a submit button is not a preview. The rest of
 * the Appearance section auto-saves on a 350ms debounce, and the picker's
 * selection is pushed into the same draft, so the two cannot disagree.
 *
 * The editor refuses to save a theme that fails a contrast pair, instead of
 * saving it with a warning. A saved theme is applied by the applier on the next
 * launch with no gate in front of it, so "it saved but warned" would mean a
 * permanently unreadable palette the reader had to remember to go and delete.
 *
 * The editor shows the whole token set's verdict, not just the knob being
 * dragged. `--text-3` is legible on `--main` and unreadable on `--sidebar`, and
 * a per-knob check would clear the knob that caused it.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../Icon.jsx'

/** The reference's Select/Selected pill, with the badge doing the announcing. */
function SelectPill({ selected }) {
  return (
    <span className="select-pill" aria-hidden="true">
      {selected && <Icon name="check" size={12} />}
      {selected ? 'Selected' : 'Select'}
    </span>
  )
}
import { BUILT_IN_THEMES, THEME_IDS, resolveTheme, missingTokens, REQUIRED_TOKENS } from './themes.js'
import { checkTokens, describeFailure, parseColor } from './contrast.js'
import * as store from '../platform/store.js'
import { RadioGroup, RadioGroupItem } from './ui/radio-group.jsx'
import { Button } from './ui/button.jsx'

/**
 * What each built-in is actually for, in the one line under its card.
 *
 * The names are not enough and the mode is not the point either: "Light" and
 * "Dark" describe the switch, not the choice. A card that only says Dark is
 * asking the reader to pick a mood from a word, which is the thing a thumbnail is
 * supposed to answer.
 */
const THEME_NOTES = {
  light: 'Cool white page, plain and bright.',
  paper: 'Warm greys, so the page feels like stock.',
  night: 'Four dark greys, which keeps the panels apart.',
  midnight: 'Deep blue-black with a cool ink.',
  nord: 'Arctic greys and a frost-blue accent.',
  dracula: 'Purple night, high-contrast ink.',
  'rose-pine': 'Muted plum and rose, soft on the eyes.',
  sepia: 'Warm paper with brown ink.',
  solar: 'Sunlit cream and burnt orange.',
  'catppuccin-latte': 'Soft pastels on a cool light base.',
  'catppuccin-mocha': 'Aubergine dark with pastel ink.',
  'tokyo-night': 'City-night blues and neon accents.',
  'gruvbox-dark': 'Retro warm dark with amber ink.',
  'rose-pine-dawn': 'Rose-pine light, gentle and warm.',
  'everforest-light': 'Forest greens on warm cream.',
}

/** A saved theme gets a sentence about where it came from instead of a review. */
const noteFor = (option) =>
  THEME_NOTES[option.id] ?? `Your own ${option.mode === 'dark' ? 'dark' : 'light'} palette.`


/**
 * The knobs the editor exposes.
 *
 * Not all eighteen: these are the ones a reader looking at a screenshot could
 * name. Everything else stays reachable by "Save as" on a preset and editing the
 * copy, and a picker with eighteen colour inputs is a settings screen nobody
 * scrolls to the end of.
 */
const KNOBS = [
  { token: '--main', label: 'Page', hint: 'The writing surface' },
  { token: '--sidebar', label: 'Sidebar', hint: 'Sections and documents' },
  { token: '--chat', label: 'Assistant', hint: 'The Conclave panel' },
  { token: '--text-1', label: 'Body text', hint: 'What you read most' },
  { token: '--text-2', label: 'Secondary text', hint: 'Labels and metadata' },
  { token: '--text-3', label: 'Faint text', hint: 'Timestamps, hints' },
  { token: '--accent', label: 'Accent', hint: 'Links and the focus ring' },
  { token: '--highlight-bg', label: 'Highlight', hint: 'Marked-up passages' },
]

/** A token's value as `#rrggbb`, which is the only thing a colour input takes. */
function toHex(value, fallback) {
  const channels = parseColor(value)
  if (!channels) return fallback
  return `#${channels.slice(0, 3).map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The picture a palette produces: sidebar, page, and the four ink weights on it.
 *
 * It is the applier rather than a drawing of one. The same merged token set goes
 * onto the element as inline custom properties, and every block reads its own
 * colour back out of those properties, so what is measured here is what would
 * be painted. It is used in two places -- the card and the editor -- which is why
 * it is a component rather than markup written twice.
 *
 * Every colour is a token resolved through `toHex`, so a theme whose `--text-1`
 * cannot be parsed falls back to the same value the picker's colour input would
 * show rather than to nothing, and a card can never be a blank rectangle. The
 * fallbacks are the picker's existing ones and are contrast-vetted.
 *
 * `compact` is the card. It is not the editor's block shrunk: the card is a
 * different size context and the two answer different questions. The editor's
 * preview is read, so it carries the sample sentences a reader is meant to
 * compare. The card's is glanced at, so it carries the *shape* of a page -- two
 * ink weights, a link, a mark -- and CSS sizes it to the card. The text is the
 * short form, because a 10px line long enough to ellipsis would be showing the
 * reader their own truncation rule instead of their theme.
 */
function ThemePreview({ tokens, mode = 'light', compact = false }) {
  const main = toHex(tokens['--main'], mode === 'dark' ? '#1a1a1a' : '#ffffff')
  const ink = toHex(tokens['--text-1'], mode === 'dark' ? '#f5f5f5' : '#1a1a1a')
  const faint = toHex(tokens['--text-3'], mode === 'dark' ? '#9a9a9a' : '#6b6b6b')
  const accent = toHex(tokens['--accent'], '#2b5fd4')
  const sidebar = toHex(tokens['--sidebar'], main)
  return (
    <span
      className="theme-preview"
      data-mode={mode}
      data-compact={compact ? 'true' : undefined}
      aria-hidden="true"
      style={Object.fromEntries(Object.entries(tokens).map(([name, value]) => [name, value]))}
    >
      <span className="theme-preview-sidebar" style={{ background: sidebar }}>
        <i style={{ background: ink }} />
        <i style={{ background: faint }} />
      </span>
      <span className="theme-preview-page" style={{ background: main, color: ink }}>
        {compact ? (
          <>
            <b style={{ color: ink }}>Body text</b>
            <b style={{ color: tokens['--text-2'] }}>Metadata</b>
            <span className="theme-preview-foot">
              <em style={{ color: accent }}>A link</em>
              <mark style={{ background: tokens['--highlight-bg'], color: tokens['--highlight-ink'] }}>mark</mark>
            </span>
          </>
        ) : (
          <>
            <b style={{ color: tokens['--text-1'] }}>Body text at 16px</b>
            <b style={{ color: tokens['--text-2'] }}>A secondary line of metadata</b>
            <b style={{ color: tokens['--text-3'] }}>And a faint timestamp</b>
            <em style={{ color: tokens['--accent'] }}>A link</em>
            <mark style={{ background: tokens['--highlight-bg'], color: tokens['--highlight-ink'] }}>highlighted</mark>
          </>
        )}
      </span>
    </span>
  )
}

export default function ThemePicker({ theme, customThemes, onApply, onCustomThemesChange }) {
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  // Every theme the reader can choose, built-ins first, then saved ones newest
  // last so a theme they just made is where their eye lands.
  const options = useMemo(() => [
    ...THEME_IDS.map((id) => ({ id, name: BUILT_IN_THEMES[id].name, builtIn: true, mode: BUILT_IN_THEMES[id].mode, tokens: BUILT_IN_THEMES[id].tokens })),
    ...customThemes.map((entry) => ({
      id: entry.theme_id,
      name: entry.name,
      builtIn: false,
      // Resolved rather than raw, so a card previews the same merged set the
      // applier will write. A card showing only the twelve tokens a preset
      // overrides would be a picture of the wrong theme.
      ...resolveTheme(entry.theme_id, customThemes),
    })),
  ], [customThemes])

  // The shelf reads as two sides, because the side is the first decision:
  // a reader scanning for something easy on the eyes at night does not want
  // the light palettes between the dark ones. Built-in order is preserved
  // inside each group, then saved themes follow.
  const groups = useMemo(() => [
    { mode: 'light', label: 'Light' },
    { mode: 'dark', label: 'Dark' },
  ].map((group) => ({ ...group, options: options.filter((option) => option.mode === group.mode) }))
    .filter((group) => group.options.length > 0), [options])

  const reload = useCallback(async () => {
    const rows = await store.listCustomThemes()
    onCustomThemesChange(rows)
    return rows
  }, [onCustomThemesChange])

  const editFrom = useCallback((id) => {
    if (id === null) {
      setEditing(null)
      return
    }
    const source = resolveTheme(id, customThemes)
    setEditing({
      // A built-in starts as a copy, never as an edit in place: saving over
      // "Night" would change a theme every other reader of this build shares.
      name: BUILT_IN_THEMES[id] ? `${source.name} copy` : source.name,
      mode: source.mode,
      tokens: Object.fromEntries(KNOBS.map(({ token }) => [token, toHex(source.tokens[token], '#888888')])),
      originalId: BUILT_IN_THEMES[id] ? null : id,
    })
    setProblem('')
  }, [customThemes])

  const remove = useCallback(async (id) => {
    setBusy(true)
    try {
      await store.deleteCustomTheme(id)
      const rows = await reload()
      // The applier drops the deleted theme's tokens on the next resolve, but the
      // setting still names it, and `resolveTheme` would silently paint light.
      // Say so here rather than letting the page change under the pointer.
      if (!rows.some((row) => row.theme_id === theme.id)) onApply(theme.custom ? 'light' : theme.id)
      setEditing((current) => (current?.originalId === id ? null : current))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [reload, onApply, theme.custom, theme.id])

  const save = useCallback(async () => {
    if (!editing) return
    setBusy(true)
    setProblem('')
    try {
      const saved = await store.saveCustomTheme({ name: editing.name, tokens: editing.tokens, mode: editing.mode })
      const rows = await reload()
      onApply(saved.theme_id)
      setEditing(null)
      // A saved theme that the settings layer would rewrite is a bug, and the
      // reader would see the picker jump back a second after they chose it.
      if (!rows.some((row) => row.theme_id === saved.theme_id)) {
        setProblem(`"${saved.name}" was saved but cannot be selected.`)
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [editing, reload, onApply])

  // The one selected custom theme, if the reader is on one. Its edit and delete
  // controls follow the selection rather than sitting on nine cards.
  const selectedCustom = options.find((option) => option.id === theme.id && !option.builtIn)

  return (
    <div className="theme-picker">
      {/* Cards, not a dropdown.

          The dropdown was right about one thing and this keeps it: nine separate
          buttons announce as nine buttons, with no indication of which theme is in
          use. A `role="radiogroup"` announces as one control and reports its value,
          which is the actual argument the dropdown was built on -- so the cards are
          Radix radio items and the selection is the group's value, not a class on a
          button.

          What it was wrong about was the picture. A theme is the one setting in
          the app that cannot be judged from a list of words, and the dropdown threw
          away every swatch except one small one of the current theme -- so choosing
          meant reading names. Each card carries its own thumbnail now, drawn from
          that theme's *merged* token set, which is the thing being applied.

          The "make a theme" card is a sibling of the group rather than a fourth
          radio inside it, because a radiogroup may only contain radios: it opens
          the editor rather than selecting anything, and giving it a value would put
          a theme id in the settings row that resolves to no palette. */}
      <div className="theme-presets-head">
        <div>
          <h3 className="theme-presets-title">Theme presets</h3>
          <p className="theme-presets-note">
            Choose a preset theme from our theme library or set up your own theme.
          </p>
        </div>
        <Button type="button" className="soft-button" onClick={() => editFrom(theme.id)}>
          Set new theme
        </Button>
      </div>
      <div className="theme-cards">
        <RadioGroup
          className="theme-cards-list"
          aria-labelledby="theme-label"
          value={theme.id}
          onValueChange={onApply}
        >
          {groups.map((group) => (
            <Fragment key={group.mode}>
              <div className="theme-group-heading">
                <span>{group.label}</span>
                <span className="theme-group-count">{group.options.length}</span>
              </div>
              {group.options.map((option) => (
                <RadioGroupItem
                  key={option.id}
                  value={option.id}
                  indicator={false}
                  className="choice-card theme-card"
                >
                  <ThemePreview tokens={option.tokens} mode={option.mode} compact />
                  <span className="choice-card-text">
                    <span className="choice-card-name">{option.name}</span>
                    <span className="choice-card-note">{noteFor(option)}</span>
                  </span>
                  <SelectPill selected={option.id === theme.id} />
                  <ThemeBadge />
                </RadioGroupItem>
              ))}
            </Fragment>
          ))}
        </RadioGroup>

        {!editing && (
          <button
            type="button"
            className="choice-card theme-new"
            onClick={() => editFrom(theme.id)}
          >
            <span className="theme-new-mark">
              <Icon name="plus" size={18} />
            </span>
            <span className="choice-card-name">Make a theme</span>
            <span className="choice-card-note">
              Start from whichever one is selected.
            </span>
          </button>
        )}
      </div>

      {selectedCustom && (
        <div className="theme-actions">
          <span className="choice-card-note">
            {selectedCustom.name} is yours, so it can be changed or removed.
          </span>
          <div className="theme-actions-buttons">
            <Button type="button" className="soft-button" onClick={() => editFrom(selectedCustom.id)}>
              Edit
            </Button>
            <Button type="button" className="soft-button" disabled={busy} onClick={() => remove(selectedCustom.id)}>
              Delete
            </Button>
          </div>
        </div>
      )}

      {editing && (
        <ThemeEditor
          draft={editing}
          customThemes={customThemes}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={save}
          busy={busy}
        />
      )}

      {problem && <p className="dialog-note theme-problem" role="alert">{problem}</p>}
    </div>
  )
}

/**
 * The corner badge on the selected card.
 *
 * Shown and hidden in CSS against Radix's `data-state` rather than computed here,
 * because the group already owns that state and a second copy of it in React is a
 * second thing to keep in step. `aria-hidden` because the card is a radio and
 * already announces itself as checked; the badge is the sighted reader's half of
 * that fact.
 */
function ThemeBadge() {
  return (
    <span className="choice-card-badge" aria-hidden="true">
      <Icon name="check" size={12} />
    </span>
  )
}


/**
 * The editor for one theme.
 *
 * The verdict is computed from the merged set, so the numbers here are the
 * numbers the applier will produce, and the Save button is disabled while any
 * pair fails. The reasons are listed rather than collapsed into a count,
 * because "2 contrast problems" does not tell a reader which knob to move.
 */
function ThemeEditor({ draft, customThemes, onChange, onCancel, onSave, busy }) {
  const nameRef = useRef(null)
  useEffect(() => { nameRef.current?.focus() }, [])

  const resolved = useMemo(
    () => resolveTheme(draft.originalId || '__draft__', [{ theme_id: '__draft__', name: draft.name, mode: draft.mode, tokens: draft.tokens }]),
    [draft],
  )
  const failures = useMemo(() => checkTokens(resolved.tokens), [resolved.tokens])
  const missing = useMemo(() => missingTokens(resolved.tokens), [resolved.tokens])
  const name = draft.name.trim()
  // An empty name is refused by the store, so the button is disabled rather than
  // letting it throw on click.
  const canSave = !busy && failures.length === 0 && missing.length === 0 && name.length > 0

  const setKnob = (token, value) => onChange((current) => ({ ...current, tokens: { ...current.tokens, [token]: value } }))

  return (
    <div className="theme-editor">
      <div className="theme-editor-head">
        <div>
          <label className="field-label" htmlFor="theme-name">Theme name</label>
          <input
            id="theme-name"
            ref={nameRef}
            value={draft.name}
            maxLength={60}
            onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
          />
        </div>
        <div>
          <span className="field-label">Mode</span>
          <RadioGroup
            className="segmented"
            aria-label="Theme mode"
            value={draft.mode}
            onValueChange={(mode) => onChange((current) => ({ ...current, mode }))}
          >
            {['light', 'dark'].map((mode) => (
              <RadioGroupItem
                key={mode}
                indicator={false}
                value={mode}
                className={draft.mode === mode ? 'on' : ''}
              >
                {mode === 'light' ? 'Light' : 'Dark'}
              </RadioGroupItem>
            ))}
          </RadioGroup>
        </div>
      </div>

      {/* The preview is the real applier: the same inline custom properties on
          the same element, so what is measured here is what is painted. */}
      <ThemePreview tokens={resolved.tokens} mode={draft.mode} />

      <div className="theme-knobs">
        {KNOBS.map((knob) => (
          <label className="theme-knob" key={knob.token}>
            <input
              type="color"
              aria-label={knob.label}
              value={toHex(draft.tokens[knob.token], '#888888')}
              onChange={(event) => setKnob(knob.token, event.target.value)}
            />
            <span>
              <strong>{knob.label}</strong>
              <small>{knob.hint}</small>
            </span>
          </label>
        ))}
      </div>

      {failures.length > 0 ? (
        <div className="theme-verdict failing" role="alert">
          <strong>Not readable yet</strong>
          <ul>
            {failures.map((failure) => (
              <li key={failure.label}>{describeFailure(failure)}</li>
            ))}
          </ul>
          <p>Body text needs 4.5:1. The focus ring needs 3:1.</p>
        </div>
      ) : (
        <p className="theme-verdict ok">
          <Icon name="check" size={13} />
          Every text and indicator pair clears its threshold.
        </p>
      )}

      <div className="theme-editor-actions">
        <Button type="button" className="soft-button" onClick={onCancel}>Cancel</Button>
        <Button type="button" className="soft-button primary" disabled={!canSave} onClick={onSave}>
          {busy ? 'Saving…' : 'Save theme'}
        </Button>
      </div>
    </div>
  )
}

export { KNOBS, toHex }
