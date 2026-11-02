import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useReducedMotion } from 'framer-motion'
import './tailwind.css'
import './styles.css'
// KaTeX's own stylesheet: the Mathematics extension renders every formula with
// KaTeX at the node level, and without these fonts/styles a formula is raw
// LaTeX source sitting in the prose. Imported here so it is present for the
// whole app, including code-split editor chunks.
import 'katex/dist/katex.min.css'
import * as store from './platform/store.js'
import { BUILT_IN_THEMES, resolveTheme, THEME_IDS } from './library/themes.js'

import { backgroundProperties } from './library/backgrounds.js'
import { DetailsDialog, SettingsPage } from './library/SettingsPage.jsx'
import { Library } from './library/Library.jsx'
import { Editor } from './library/Editor.jsx'
import { describeAccount } from './library/account.js'
import { ErrorBoundary } from './ErrorBoundary.jsx'
import { OnboardingFlow } from './OnboardingFlow.jsx'
import { Button } from './library/ui/button.jsx'

// The onboarding theme picker shows the built-in themes, resolved once at module
// scope: it is a static list, and mapping it inside the render body would hand
const ONBOARDING_THEMES = THEME_IDS.map((id) => ({
  id,
  name: BUILT_IN_THEMES[id].name,
  mode: BUILT_IN_THEMES[id].mode,
  tokens: BUILT_IN_THEMES[id].tokens,
}))

const SEED_KEY = 'quill:seeded:v1'

/**
 * Whether this is a development build.
 *
 * The seed documents below are here so a dev server has something to look at,
 * and they must not ship: a reader who installs Quill should open it to an empty
 * library and the first-run card, not to five essays they did not write. `vite
 * build` sets this to false, so the packaged app starts with a clean slate and
 * the only library is the reader's own.
 *
 * The optional chain is for the test loader, which does not define
 * `import.meta.env` at all.
 */
const DEV_BUILD = Boolean(import.meta.env?.DEV)

const seedDocs = [
  {
    id: 'quiet-interface',
    title: 'The Shape of a Quiet Interface',
    kind: 'Essay',
    cat: 'Essays',
    collections: ['Essays'],
    status: 'Drafts',
    color: '#8a5a2b',
    edited: '2h ago',
    content: '<h2>Make room for the sentence</h2><p>The best tools do not ask to be admired. They hold a little space, keep the edges quiet, and let the work arrive without an audience.</p><p>A quiet interface is not an empty one. It is an interface with a clear intention: <strong>make the next sentence easier to begin.</strong></p><h2>The discipline of less</h2><p>Every control has a cost. A label asks for a glance. A bright accent asks for a decision. When the furniture begins to compete with the room, we lose the feeling that the room belongs to us.</p><h3>A small test</h3><p>Remove one thing that feels merely reassuring. Keep the thing that helps a person make progress. The difference is often visible in the first minute.</p>',
  },
  {
    id: 'morning-light',
    title: 'A Field Guide to Morning Light',
    kind: 'Notes',
    cat: 'Notes',
    collections: ['Notes'],
    status: 'Drafts',
    color: '#4ba3e3',
    edited: 'Yesterday',
    content: '<h2>Before the day begins</h2><p>The room is quiet before the first message arrives. Light finds the edge of the table first, then the cup, then the page.</p><h2>Three small observations</h2><ul><li>Keep the first task smaller than your ambition.</li><li>Let the window do some of the work.</li><li>Write down what you notice before you name it.</li></ul>',
  },
  {
    id: 'commonplace',
    title: 'Notes on Keeping a Commonplace',
    kind: 'Notes',
    cat: 'Notes',
    collections: ['Notes'],
    status: 'Revising',
    color: '#2f8f5b',
    edited: '3d ago',
    content: '<h2>A book that remembers for you</h2><p>A commonplace book is not an archive of finished thoughts. It is a place to meet unfinished thoughts halfway.</p><h2>Three kinds of entries</h2><p>Copy the sentence that startles you. Paraphrase the idea that changes your mind. Leave a question where your future self can find it.</p>',
  },
  {
    id: 'slow-tools',
    title: 'The Case for Slow Tools',
    kind: 'Essay',
    cat: 'Essays',
    collections: ['Essays'],
    status: 'Published',
    color: '#7d4bc7',
    edited: '6d ago',
    content: '<h2>Speed is not the only measure</h2><p>We have made more things immediate than ever. The result is a strange new difficulty: knowing when to stay with something.</p><h2>Attention as a material</h2><p>A slow tool does not waste time. It spends time where attention is most valuable, at the point where a small decision becomes a meaningful one.</p>',
  },
  {
    id: 'room-tone',
    title: 'How a Room Finds Its Tone',
    kind: 'Chapter',
    cat: 'Chapters',
    collections: ['Chapters'],
    status: 'Revising',
    color: '#c4643d',
    edited: '1w ago',
    content: '<h2>Start with the light</h2><p>Before choosing a color, notice what the room already reflects. A surface is never neutral; it is waiting for a temperature.</p><h2>Leave one thing unpolished</h2><p>Perfection can make a space feel staged. A little visible imperfection gives the eye somewhere to rest.</p>',
  },
  {
    id: 'reading-list',
    title: 'A Reading List for Slower Days',
    kind: 'Notes',
    cat: 'Notes',
    collections: ['Notes'],
    status: 'Published',
    color: '#e58ab6',
    edited: '2w ago',
    content: '<h2>Books that make room</h2><p>For the days when a long paragraph feels like a small act of faith, keep these close.</p><h2>One page at a time</h2><p>The point is not to finish quickly. It is to notice when a sentence changes the temperature of the room.</p>',
  },
  {
    id: 'field-notes',
    title: 'Field Notes from the Edge of Town',
    kind: 'Chapter',
    cat: 'Chapters',
    collections: ['Chapters'],
    status: 'Drafts',
    color: '#d0a03b',
    edited: '3w ago',
    content: '<h2>The path at first light</h2><p>There is a path behind the station that looks as if it has been there longer than the buildings around it.</p><h2>What the path remembers</h2><p>Footsteps, rain, the low sound of a train. The landscape keeps a record even when nobody is writing it down.</p>',
  },
  {
    id: 'open-ended',
    title: 'An Open-Ended Notebook',
    kind: 'Notes',
    cat: 'Notes',
    collections: ['Notes'],
    status: 'Drafts',
    color: '#6a8792',
    edited: '1mo ago',
    content: '<h2>Begin anywhere</h2><p>There is no required order here. Follow the thread that has a little more light in it.</p><h2>Keep the thread</h2><p>Come back tomorrow and see what has changed.</p>',
  },
]

/**
 * The boot and empty-library states, rendered as an overlay.
 *
 * These used to be early returns in `App`, which meant each state swapped the
 * entire top-level tree: the library, the editor and every piece of local UI
 * state inside them were unmounted and rebuilt. That is the class of bug behind
 * the document-title rename losing its state, and layering an auth gate and an
 * onboarding flow on top of it would have made it much worse.
 *
 * The shell now always renders and this sits above it, so crossing a boot
 * boundary costs a paint rather than a teardown. Onboarding and sign-in will
 * mount here for the same reason.
 */
function BootLayer({ bootstrapped, bootError, libraryEmpty, onCreate, reducedMotion }) {
  // Nothing to say once the workspace is ready and a document is available.
  if (bootstrapped && !bootError && !libraryEmpty) return null
  const mark = <div className="boot-mark"><img src="/quill-mark.png" alt="" /></div>

  let body
  if (!bootstrapped) {
    body = (
      <>
        <p>Opening your workspace…</p>
        <div style={{ marginTop: '16px', width: '220px', opacity: 0.8 }}>
          <div style={{ fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
            ░░░░░░░░░░░░░░░░░░<br/>
            ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒<br/>
            ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
          </div>
        </div>
      </>
    )
  } else if (bootError) {
    body = (
      <>
        <h1>Quill could not open your library</h1>
        <p>{bootError}</p>
        <Button type="button" className="soft-button" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </>
    )
  } else {
    // An empty library is a real state, not a failure. It has to stay visible:
    // rendering nothing produced a blank window indistinguishable from a crash.
    body = (
      <>
        <h1>Your library is empty</h1>
        <p>Create a document to start writing, or import an existing file.</p>
        <Button type="button" className="soft-button primary" onClick={onCreate}>New document</Button>
      </>
    )
  }

  return (
    <div className="boot-layer" role={bootError ? 'alert' : undefined}>
      <div className={`boot-screen${bootError ? ' boot-error' : ''}`}>{mark}{body}</div>
    </div>
  )
}

function App() {
  const osReducedMotion = useReducedMotion()
  const [docs, setDocs] = useState([])
  const [settings, setSettingsState] = useState(store.defaultSettings)
  // The custom theme list is app state rather than a store call inside the
  // render, because both the applier and the picker need it and neither should
  // fetch it. `resolveTheme` is pure, so this is the only place the two meet.
  const [customThemes, setCustomThemes] = useState([])
  const [bootstrapped, setBootstrapped] = useState(false)
  // P6-3. `undefined` until `account_state` answers, and `describeAccount`
  // renders that as signed out rather than as a spinner. Read for the export
  // author only: there is no account surface in the app any more, so nothing
  // else in the render depends on it.
  const [account, setAccount] = useState(undefined)
  const [bootError, setBootError] = useState(null)
  const [view, setView] = useState('library')
  // A library download opens the document and then its export dialog, so the
  // request has to survive the switch from `library` to `editor`. A counter
  // rather than a boolean: two downloads of the same document in a row are two
  // requests, and a boolean set back to `false` on close would make the second
  // one a no-op.
  const [exportRequest, setExportRequest] = useState(0)
  const [currentId, setCurrentId] = useState('')
  const [filter, setFilter] = useState({ type: 'all', value: 'all' })
  const [sortAscending, setSortAscending] = useState(false)
  const [viewMode, setViewMode] = useState('grid')
  const [density, setDensity] = useState('comfortable')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [zen, setZen] = useState(false)
  const [detailsId, setDetailsId] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The first-run card. `false` until the core says otherwise: opening it is
  // decided from `onboarding_state`, not from whether this render looks new.
  const [onboarding, setOnboarding] = useState(false)
  const [sessionApiKey, setSessionApiKey] = useState('')
  const [providerReady, setProviderReady] = useState(false)
  const [activeProvider, setActiveProvider] = useState(null)
  const [providers, setProviders] = useState([])
  // Tools found on this machine, and whether the last look found any. Detection
  // shells out and probes two ports, so it runs when Settings is opened rather
  // than on every mount, and never blocks the first paint.
  const [localTools, setLocalTools] = useState([])
  const zenPrevious = useRef(null)
  // The reader's own Reduce Motion toggle and the OS setting are the same
  // request, and a reader who sets one means it. `useReducedMotion()` is only
  // the OS media query, so taking it alone left the in-app toggle reaching
  // nothing but the `body.reduce-motion` class -- which a universal CSS rule
  // cannot use to stop a JS animation engine or a canvas rAF. Combining them
  // here is what actually reaches Framer, MetalFx, BotAvatar, BorderBeam and
  // Liquid in one change. The assistant is the exception to that and takes the
  // OS half alone, from the constant below.
  const reducedMotion = Boolean(osReducedMotion) || Boolean(settings.reduceMotion)
  // ...and the one surface the in-app toggle does NOT reach. The assistant keeps
  // animating when only the toggle is set, because a Conclave panel whose avatar
  // is frozen and whose beam is parked reads as broken rather than as calm: the
  // motion there is the surface reporting that it is alive and working, not
  // decoration that can be traded away. It follows the OS setting alone, which is
  // the accessibility half of the pair -- an OS-level request is never overruled
  // here. Everything else in the app keeps following `reducedMotion` above, and
  // `Editor.jsx` still needs the combined value for its own outline scrolling.
  const assistantReducedMotion = Boolean(osReducedMotion)
  // P6-5. The author stamped into exports. It was the string "Mara Lee", so
  // every PDF a reader produced credited a fictional person -- and the
  // hardcoding was in two places at once, here and in the account UI that no
  // longer exists. A signed-out reader gets an empty author rather than a
  // borrowed name, because a metadata field with someone else's name in it is
  // worse than one that is blank.
  const accountName = describeAccount(account).name
  // Both helpers return a fresh object literal, so without this every App render
  // handed `Library` two new props and defeated `React.memo` entirely.
  const currentDoc = docs.find((doc) => doc.id === currentId) || docs[0]
  // Statistics are reported by the editor from the ProseMirror document, since
  // the Yjs body — not the legacy `content` column — is the source of truth.
  const [stats, setStats] = useState({ words: 0, chars: 0, paragraphs: 0, read: 1 })

  const setSettings = useCallback((updater) => {
    setSettingsState((current) => (typeof updater === 'function' ? updater(current) : updater))
  }, [])

  /**
   * The theme the app is actually painting.
   *
   * `settings.theme` is an id; this is the resolved `{ id, mode, tokens }`. It is
   * memoised on the two inputs that can change it, because the applier effect
   * depends on it and a fresh object identity would re-write every token
   * whenever anything else re-rendered.
   */
  const theme = useMemo(
    () => resolveTheme(settings.theme, customThemes),
    [settings.theme, customThemes],
  )

  // Load settings + documents from the platform store on mount. In the Tauri
  // runtime this reads SQLite; in the browser it reads the localStorage
  // fallback. On a fresh database the seed documents are written once so the
  // library is never empty on first run.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const info = await store.bootstrap()
        const loadedSettings = info.settings || store.defaultSettings
        if (cancelled) return
        setSettingsState(loadedSettings)
        setDensity(loadedSettings.density || 'comfortable')
        // A theme id naming neither a built-in nor a stored theme resolves to
        // `light` below. The Rust side does the same when it loads settings, so
        // the two agree about what an unrecognised id means.
        setCustomThemes(await store.listCustomThemes())

        let rows = await store.listDocuments()
        const alreadySeeded = store.runtime.isTauri
          ? info.documentCount > 0
          : localStorage.getItem(SEED_KEY) === '1'

        if (DEV_BUILD && !rows.length && !alreadySeeded) {
          for (const seed of seedDocs) {
            try {
              await store.createDocument({
                title: seed.title,
                kind: seed.kind,
                collections: seed.collections,
                status: seed.status,
                color: seed.color,
                content: seed.content,
                contentFormat: 'html',
                provenance: 'seed',
              })
            } catch (error) {
              console.error('Failed to seed document', seed.title, error)
            }
          }
          if (!store.runtime.isTauri) localStorage.setItem(SEED_KEY, '1')
          rows = await store.listDocuments()
        }

        if (cancelled) return
        setDocs(rows)
        if (rows[0]?.id && !currentId) setCurrentId(rows[0].id)
        else if (rows[0]?.id && currentId && !rows.find((r) => r.id === currentId)) setCurrentId(rows[0].id)

        // First run, or not. The core answers `false` only for a genuinely
        // fresh profile -- `reconcile_onboarding_completed` has already marked
        // any library that predates this feature as complete -- so an upgrade
        // opens straight into the workspace it already had.
        const finished = await store.readOnboarding('completed', 'false')
        if (!cancelled && finished !== 'true') setOnboarding(true)

        setBootstrapped(true)
      } catch (error) {
        console.error('Bootstrap failed', error)
        if (!cancelled) {
          setBootError(error instanceof Error ? error.message : String(error))
          setBootstrapped(true)
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // P6-3. Deliberately a separate effect from bootstrap, and deliberately after
  // it. `account_state` makes a live `GET /api/health` with an 8-second timeout
  // whenever sync is switched on, so folding it into `bootstrap` would put the
  // app's launch behind a network round trip -- for a feature most readers of a
  // local notebook never touch. Failing is also not fatal: an unreachable server
  // is a state the export author renders, not a reason to show the boot error.
  useEffect(() => {
    if (!bootstrapped) return undefined
    let cancelled = false
    store
      .accountState()
      .then((state) => {
        if (!cancelled) setAccount(state)
      })
      .catch((error) => {
        console.error('Failed to read the account', error)
        if (!cancelled) setAccount({ signedIn: false, account: null, online: false, syncEnabled: false, baseUrl: '' })
      })
    return () => {
      cancelled = true
    }
  }, [bootstrapped])

  useEffect(() => {
    const root = document.documentElement
    document.body.dataset.theme = theme.id
    // data-mode carries "light" or "dark" alongside data-theme. Stylesheets key
    // anything that is a property of darkness -- the wordmark inversion, dark
    // scrollbars, dark code blocks, the status tints -- on data-mode, so those
    // are inherited by any theme whose mode is dark, not just by `night`.
    document.body.dataset.mode = theme.mode
    // Native widgets, scrollbars and form controls follow this rather than the
    // `data-theme` id. A built-in's own block already sets it, but a custom
    // theme has no block, and without this a custom dark theme leaves every
    // scrollbar and select popup light.
    root.style.setProperty('color-scheme', theme.mode)
    document.body.classList.toggle('reduce-motion', Boolean(settings.reduceMotion))
    root.style.setProperty('--reading-font', settings.font === 'Georgia' ? 'Georgia, "Times New Roman", serif' : settings.font === 'DM Mono' ? '"DM Mono", "JetBrains Mono", ui-monospace, monospace' : 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif')

    // P4-2, P4-3, P4-4. The reader's own backgrounds, as custom properties.
    // `backgroundProperties` returns null when nothing is set, so the common
    // case writes nothing and the stylesheet keeps owning these values.
    //
    // This is in the same effect as the theme on purpose. A texture and a theme
    // are two ways of saying what is behind the text, and splitting them across
    // effects would let a wallpaper and a theme land a frame apart, which reads
    // as a flash of the previous theme's colours over the new wallpaper.
    const backgrounds = backgroundProperties(settings, { mode: theme.mode })
    const writtenBackgrounds = []
    if (backgrounds) {
      for (const [name, value] of Object.entries(backgrounds)) {
        root.style.setProperty(name, value)
        writtenBackgrounds.push(name)
      }
    }

    // A built-in is painted by its own `body[data-theme]` block, so nothing goes
    // inline for it. A custom theme has no block -- `data-theme="sepia"` matches
    // no rule -- so its resolved token set goes onto <html>, where an inline
    // declaration outranks both `:root` and any block.
    //
    // The set is complete rather than partial on purpose: `resolveTheme` merged
    // the custom tokens over the base for its mode, so no `var()` is left
    // pointing at nothing.
    const written = []
    if (theme.custom) {
      for (const [name, value] of Object.entries(theme.tokens)) {
        root.style.setProperty(name, value)
        written.push(name)
      }
    }

    // Cleanup is not optional. Every property written above is removed, so
    // deleting a theme or switching back to a built-in cannot leave that theme's
    // colours on <html> for the rest of the session -- which is what the previous
    // version did with `--reading-font`, and would have done with all thirty-odd
    // of a custom theme's tokens.
    return () => {
      for (const name of written) root.style.removeProperty(name)
      for (const name of writtenBackgrounds) root.style.removeProperty(name)
      root.style.removeProperty('color-scheme')
      root.style.removeProperty('--reading-font')
      document.body.classList.remove('reduce-motion')
    }
  }, [settings, theme])

  useEffect(() => {
    const handlePanelEvent = (event) => setRightOpen((value) => !value)
    document.addEventListener('quill:toggle-right', handlePanelEvent)
    return () => document.removeEventListener('quill:toggle-right', handlePanelEvent)
  }, [])

  const updateDoc = useCallback((id, patch) => {
    setDocs((current) => current.map((doc) => doc.id === id ? store.normalizeDoc({ ...doc, ...patch }) : doc))
    store.updateDocument(id, patch).then((saved) => {
      setDocs((current) => current.map((doc) => doc.id === id ? saved : doc))
    }).catch((error) => console.error('Failed to persist document', id, error))
  }, [])
  const updateTitle = useCallback((title) => { if (!currentDoc) return; updateDoc(currentDoc.id, { title }) }, [currentDoc, updateDoc])
  const openDoc = useCallback((id) => { setCurrentId(id); setView('editor') }, [])
  const goLibrary = useCallback(() => setView('library'), [])
  const deleteDocument = useCallback(
    (id) => {
      store
        .deleteDocument(id)
        .then(() => {
          setDocs((current) => {
            const next = current.filter((doc) => doc.id !== id)
            if (currentId === id) {
              if (next[0]?.id) {
                setCurrentId(next[0].id)
                setView('editor')
              } else {
                setCurrentId(null)
                setView('library')
              }
            }
            return next
          })
        })
        .catch((error) => {
          console.error('Failed to delete document', error)
        })
    },
    [currentId],
  )
  const downloadDoc = useCallback((id) => { setCurrentId(id); setView('editor'); setExportRequest((count) => count + 1) }, [])
  const createDocument = useCallback(() => {
    store.createDocument({
      title: 'Untitled document',
      kind: 'Draft',
      collections: ['Notes'],
      status: 'Drafts',
      color: '#6a8792',
      content: '<h2>New section</h2><p><br></p>',
      contentFormat: 'html',
    }).then((doc) => {
      setDocs((current) => [doc, ...current])
      setFilter({ type: 'all', value: 'all' })
      setCurrentId(doc.id)
      setView('editor')
    }).catch((error) => console.error('Failed to create document', error))
  }, [])
  const setPanel = useCallback((side, open) => { if (side === 'left') setLeftOpen(open); else setRightOpen(open) }, [])
  // Library is memoised, and a memo compares props by identity. These were
  // inline arrows, so each App render produced six new function props and the
  // memo never hit -- including on the 250ms stats tick, which is the case that
  // actually mattered.
  // Closes Settings on the way through: the sidebar stays on screen while
  // Settings is open, but `.app-shell.settings-open .library-main` is
  // `display: none`, so the filter was applying underneath a hidden grid.
  const applyFilter = useCallback((type, value) => {
    setFilter({ type, value })
    setSettingsOpen(false)
  }, [])
  // A toggle, because the entry point lives in the library sidebar and that
  // sidebar stays on screen while Settings is open: a button that could only
  // open would be a dead control in exactly the one state where it is visible.
  const toggleSettings = useCallback(() => setSettingsOpen((value) => !value), [])
  // Stable, because `Library` is memoised and an inline arrow here would hand it a
  // new prop identity on every App render -- re-rendering the whole library grid,
  // and every document tile in it, each time anything at all changed.
  const toggleSort = useCallback(() => setSortAscending((value) => !value), [])
  const toggleZen = useCallback(() => { if (!zen) { zenPrevious.current = { left: leftOpen, right: rightOpen }; setZen(true); setLeftOpen(false); setRightOpen(false) } else { setZen(false); if (zenPrevious.current) { setLeftOpen(zenPrevious.current.left); setRightOpen(zenPrevious.current.right) } } }, [leftOpen, rightOpen, zen])
  const saveDetails = useCallback((id, patch) => { updateDoc(id, { ...patch, cat: patch.collections?.[0] || 'Notes', edited: 'just now' }); setDetailsId(null) }, [updateDoc])
  const updateSettings = useCallback((patch) => setSettings((current) => ({ ...current, ...patch })), [setSettings])
  // Settings as of the last render, so a callback outside a render can persist a
  // merge without reading state that is one update behind.
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  /**
   * The onboarding theme picker applies a choice and keeps it.
   *
   * `updateSettings` is deliberately preview-only, because the settings dialog
   * has a Cancel that has to undo everything the dialog did. Onboarding has no
   * such draft -- the theme *is* the answer to the question the step asked, and
   * a reader who picks Dark, quits, and comes back to a light window has been
   * ignored. So this merges and persists, using the ref for the current values
   * rather than a state read that would be stale inside a callback.
   */
  const applyOnboardingTheme = useCallback((themeId) => {
    setSettings((current) => ({ ...current, theme: themeId }))
    store.setSettings({ ...settingsRef.current, theme: themeId }).catch((error) =>
      console.error('Failed to persist settings', error),
    )
  }, [])
  /**
   * Settings persist as they are changed.
   *
   * There is no Save button, so this is the only path. It deliberately does not
   * close the dialog: the reader is still in it, flipping a font or a density,
   * and a save that closed the window would be its own surprise.
   *
   * Provider credentials do not come through here. They are gated behind the
   * provider section's own "Connect provider" button, because a key is typed a
   * character at a time and writing it to the OS keyring on every keystroke is
   * both slow and wrong. `connectProvider` handles that case.
   */
  const persistSettings = useCallback((next) => {
    setSettings((current) => {
      // Bail when nothing actually changed.
      //
      // The dialog persists its whole draft on a timer, so most of those calls
      // carry values that are already stored -- opening Settings and closing it
      // again, or moving one slider and coming back. Merging anyway produced a
      // fresh object, a fresh render, and a fresh pass through the dialog's save
      // effect, which in a test harness that waits for the DOM to stop changing
      // means every interaction costs a settle timeout.
      const changed = Object.keys(next).some((key) => current[key] !== next[key])
      return changed ? { ...current, ...next } : current
    })
    if (next.density) setDensity(next.density)
    store.setSettings(next).catch((error) => console.error('Failed to persist settings', error))
  }, [setDensity, setSettings])

  /**
   * Looks for local tools whenever Settings opens.
   *
   * Opening is the only moment the answer is shown, and a server that was
   * started after the app did should appear without restarting Quill -- which
   * a one-shot probe at boot could not offer.
   */
  useEffect(() => {
    // Onboarding asks the same question in its last step, so it triggers the
    // same probe rather than adding a second, differently-timed one.
    if (!settingsOpen && !onboarding) return undefined
    let cancelled = false
    store
      .detectCliTools()
      .then((tools) => {
        if (!cancelled) setLocalTools(Array.isArray(tools) ? tools : [])
      })
      .catch((error) => {
        if (!cancelled) setLocalTools([])
        console.error('Failed to detect local tools', error)
      })
    return () => {
      cancelled = true
    }
  }, [settingsOpen, onboarding])

  /**
   * Closes the first-run card and records that it happened.
   *
   * Written on the way out rather than per step: a reader who quits halfway
   * through will see the card again, which is the right answer for a sequence
   * that is three short steps rather than a form to restore.
   */
  const finishOnboarding = useCallback(() => {
    setOnboarding(false)
    store
      .writeOnboarding('completed', 'true')
      .catch((error) => console.error('Failed to record onboarding state', error))
  }, [])

  /**
   * Reads the registry once so the panel works from the provider the core will
   * actually use.
   *
   * The credential is filed under this row's id, and whether a key already
   * exists is a property of that row rather than of the dialog, so both have to
   * come from here -- reading them off the settings blob is what left a saved
   * key sitting in a slot no run ever opened.
   */
  useEffect(() => {
    let cancelled = false
    store
      .listProviders()
      .then((list) => {
        if (!cancelled) setProviders(list)
      })
      .catch((error) => console.error('Failed to list providers', error))
    store
      .getActiveProvider()
      .then((provider) => {
        if (cancelled) return null
        setActiveProvider(provider)
        if (!provider) return null
        // A local server needs no key, so `hasCredential: false` must not be
        // reported as "not connected" for one pointed at loopback.
        if (store.isLocalEndpoint(provider.baseUrl)) {
          if (!cancelled) setProviderReady(true)
          return null
        }
        return store.getProviderSecretStatus(provider.id).then((status) => {
          if (!cancelled) setProviderReady(Boolean(status.hasCredential))
        })
      })
      .catch((error) => console.error('Failed to read the active provider', error))
    return () => {
      cancelled = true
    }
  }, [])

  /** The one action that writes a secret, and the only one that needs a click. */
  const connectProvider = useCallback(async (next, apiKey) => {
    setSessionApiKey(apiKey)
    persistSettings(next)
    if (!apiKey) return false
    try {
      const provider = activeProvider ?? (await store.getActiveProvider())
      if (!provider) {
        console.error('No provider is selected, so the key has nowhere to go')
        setProviderReady(false)
        return false
      }
      setActiveProvider(provider)
      await store.setProviderSecret(provider.id, apiKey)
      const status = await store.getProviderSecretStatus(provider.id)
      const ready = Boolean(status.hasCredential)
      setProviderReady(ready)
      return ready
    } catch (error) {
      console.error('Failed to store provider credential', error)
      setProviderReady(false)
      return false
    }
  }, [persistSettings, activeProvider])

  /** Forgets the key, which hands the provider back to the environment. */
  const disconnectProvider = useCallback(async () => {
    try {
      const provider = activeProvider ?? (await store.getActiveProvider())
      if (!provider) return
      await store.deleteProviderSecret(provider.id)
    } catch (error) {
      console.error('Failed to remove the provider credential', error)
    }
    setSessionApiKey('')
    setProviderReady(false)
  }, [activeProvider])

  /** Points requests at another provider in the registry, and reports whether a
   * key already exists for it so the row can say so without a reconnect. */
  const selectProvider = useCallback(async (id) => {
    try {
      const provider = await store.setActiveProvider(id)
      setActiveProvider(provider)
      if (!provider) return false
      if (store.isLocalEndpoint(provider.baseUrl)) {
        setProviderReady(true)
        return true
      }
      const status = await store.getProviderSecretStatus(provider.id)
      const ready = Boolean(status.hasCredential)
      setProviderReady(ready)
      return ready
    } catch (error) {
      console.error('Failed to select the provider', error)
      return false
    }
  }, [])

  /**
   * Turns a detected local server into the active provider.
   *
   * Two writes that belong together: the row (so the endpoint and its models
   * exist at all) and the selection (so a run uses it). A tool that was adopted
   * once is updated rather than duplicated -- its model list is a live fact
   * about the server, and a second run of `ollama pull` must show up as one new
   * entry, not as a second provider.
   *
   * No credential is written: a loopback endpoint needs none, and the core
   * treats that as a real state rather than a missing key.
   */
  /**
   * Turns a detected local tool into the active provider.
   *
   * Two writes that belong together: the row (so the endpoint and its models
   * exist at all) and the selection (so a run uses it). A tool that was adopted
   * once is updated rather than duplicated -- its model list is a live fact
   * about the server, and a second run of `ollama pull` must show up as one new
   * entry, not as a second provider.
   *
   * Both kinds of tool are covered. A server carries `baseUrl` + `models` and
   * adopts as `openai_chat`. A CLI agent carries `exec` (its one-shot command
   * prefix) and adopts as `cli`: the command travels in `baseUrl` because that
   * is the field every transport reads for "where does this provider answer",
   * its own login is the credential so no key is written, and the tool's id
   * stands in as the picker's model name since the CLI picks its own
   * underlying model.
   */
  const adoptTool = useCallback(async (tool) => {
    if (!tool?.id) return false
    if (!tool.models?.length && !tool.exec) return false
    try {
      const existing = providers.find((provider) => provider.id === tool.id)
      if (!tool.models?.length) {
        const written = existing
          ? await store.updateProvider({ id: tool.id, protocol: 'cli', baseUrl: tool.exec, defaultModel: tool.id, models: [tool.id] })
          : await store.createProvider({
              id: tool.id,
              label: tool.label,
              vendor: 'compatible',
              protocol: 'cli',
              baseUrl: tool.exec,
              defaultModel: tool.id,
              models: [tool.id],
            })
        const active = await store.setActiveProvider(written.id)
        const list = await store.listProviders()
        setProviders(list)
        setActiveProvider(active)
        setProviderReady(true)
        return true
      }
      const model = existing && tool.models.includes(existing.defaultModel)
        ? existing.defaultModel
        : tool.models[0]
      const written = existing
        ? await store.updateProvider({ id: tool.id, baseUrl: tool.baseUrl, models: tool.models, defaultModel: model })
        : await store.createProvider({
            id: tool.id,
            label: tool.label,
            vendor: 'compatible',
            protocol: 'openai_chat',
            baseUrl: tool.baseUrl,
            defaultModel: model,
            models: tool.models,
          })
      const active = await store.setActiveProvider(written.id)
      const list = await store.listProviders()
      setProviders(list)
      setActiveProvider(active)
      setProviderReady(true)
      return true
    } catch (error) {
      console.error('Failed to adopt the local tool', error)
      return false
    }
  }, [providers])

  /** Edits the active provider's default model, so the chat picker and every
   * run resolve one and the same field from the registry. */
  const selectModel = useCallback(async (model) => {
    if (!model) return
    try {
      const provider = activeProvider ?? (await store.getActiveProvider())
      if (!provider) return
      const updated = await store.updateProvider({ id: provider.id, defaultModel: model })
      if (updated) setActiveProvider(updated)
    } catch (error) {
      console.error('Failed to set the default model', error)
    }
  }, [activeProvider])

  useEffect(() => {
    const handleKey = (event) => {
      if (settingsOpen || detailsId) return
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') { event.preventDefault(); setPanel('left', !leftOpen) }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); setPanel('right', !rightOpen) }
      if (event.key === 'Escape' && zen) toggleZen()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [detailsId, leftOpen, rightOpen, settingsOpen, toggleZen, zen])

  return (
    <div className={`app-shell ${leftOpen ? 'left-open' : ''} ${rightOpen ? 'right-open' : ''} ${zen ? 'zen' : ''} ${settingsOpen ? 'settings-open' : ''}`} data-theme={theme.id} data-view={view}>
      <div className="library-layer">
        <Library docs={docs} filter={filter} onFilter={applyFilter} onOpenDoc={openDoc} onNew={createDocument} onSettings={toggleSettings} onDetails={setDetailsId} onDownload={downloadDoc} onDelete={deleteDocument} sortAscending={sortAscending} onSort={toggleSort} viewMode={viewMode} onView={setViewMode} density={density} onDensity={setDensity} />
      </div>
      {currentDoc && (
        <div key={currentDoc.id} className="editor-layer" style={{ pointerEvents: view === 'editor' ? 'auto' : 'none' }}>
          <Editor doc={currentDoc} stats={stats} settings={settings} theme={theme} onSettingsChange={updateSettings} activeProvider={activeProvider} onSelectModel={selectModel} onOpenSettings={() => setSettingsOpen(true)} onStatsChange={setStats} author={accountName} onTitleChange={updateTitle} onBack={goLibrary} onPanel={setPanel} leftOpen={leftOpen} rightOpen={rightOpen} zen={zen} onZen={toggleZen} onDetails={setDetailsId} onDelete={deleteDocument} onContentSave={updateDoc} reducedMotion={reducedMotion} assistantReducedMotion={assistantReducedMotion} view={view} exportRequest={exportRequest} />
        </div>
      )}
      {detailsId && <DetailsDialog key="details-dialog" doc={docs.find((doc) => doc.id === detailsId) || currentDoc} onClose={() => setDetailsId(null)} onSave={(patch) => saveDetails(detailsId, patch)} />}
      {settingsOpen && <SettingsPage key="settings-page" settings={settings} theme={theme} customThemes={customThemes} onCustomThemesChange={setCustomThemes} onApplyTheme={updateSettings} sessionApiKey={sessionApiKey} providerReady={providerReady} onClose={() => setSettingsOpen(false)} onPersist={persistSettings} onConnect={connectProvider} onDisconnect={disconnectProvider} activeProvider={activeProvider} providers={providers} onSelectProvider={selectProvider} onSelectModel={selectModel} localTools={localTools} onAdoptTool={adoptTool} />}
      <BootLayer key="boot-layer" bootstrapped={bootstrapped} bootError={bootError} libraryEmpty={!currentDoc} onCreate={createDocument} reducedMotion={reducedMotion} />
      {onboarding && bootstrapped && !bootError && (
        <OnboardingFlow
          key="onboarding"
          themes={ONBOARDING_THEMES}
          themeId={settings.theme}
          onPickTheme={applyOnboardingTheme}
          tools={localTools.filter((tool) => tool.models?.length)}
          onAdoptTool={adoptTool}
          onOpenSettings={() => setSettingsOpen(true)}
          onFinish={finishOnboarding}
        />
      )}
      {!bootstrapped && (
        <div style={{ position: 'fixed', bottom: '10px', right: '10px', width: '40px', opacity: 0.4, pointerEvents: 'none', zIndex: 100, fontFamily: 'monospace', fontSize: '10px', lineHeight: '1' }}>
          <div>▓▒░</div>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
