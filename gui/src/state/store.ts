/** Central renderer state (zustand): project, tree, editor, chat, runs. */

import { create } from 'zustand'
import { Api, type ProjectOut, type ProjectSummary, type SectionDetail, type SectionNode } from '../lib/api'
import { WsClient } from '../lib/ws'
import {
  FONT_FAMILIES,
  applyFont,
  applyTheme,
  initFont,
  initTheme,
  type FontFamily
} from '../lib/appearance'
import { fetchGoogleFonts, googleFontCss, loadGoogleFont } from '../lib/googleFonts'

export interface ChatMessage {
  id: number
  role: 'user' | 'system' | 'error'
  text: string
  ts: number
}

export interface RunState {
  runId: string
  kind: 'run' | 'rewrite' | 'merge' | 'format'
  status: 'running' | 'done' | 'cancelled' | 'error'
  ratio: number
  sectionId: string | null
  statusLabel: string
}

export interface LogLine {
  id: number
  text: string
  ts: number
}

/** Pseudo-section id for the whole-document draft view. */
export const DRAFT_ID = '__draft__'

interface AppState {
  api: Api | null
  wsOnline: boolean
  health: { store: string; providers: { name: string; model: string; ready: boolean }[] } | null
  projects: ProjectSummary[]
  project: ProjectOut | null
  tree: SectionNode[]
  selectedId: string | null
  section: SectionDetail | null
  saveState: 'clean' | 'dirty' | 'saving' | 'saved'
  liveText: Record<string, string>
  chat: ChatMessage[]
  logs: LogLine[]
  run: RunState | null
  bottomOpen: boolean
  bottomTab: 'problems' | 'log'
  rightTab: 'chat' | 'inspector'
  toast: string | null
  suggestion: string | null
  preDraftId: string | null
  preDraftSection: SectionDetail | null
  settingsOpen: boolean
  theme: string
  font: { family: string; size: number }
  fontFamilies: FontFamily[]
  sidebarCollapsed: boolean
  rightCollapsed: boolean

  bootstrap: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshProject: () => Promise<void>
  openFilePath: (filePath: string) => Promise<void>
  newDoc: () => Promise<void>
  openProject: (projectId: string) => Promise<void>
  exitToLibrary: () => void
  selectSection: (sectionId: string) => Promise<void>
  selectDraft: () => Promise<void>
  autoSelectWritingSpot: () => Promise<void>
  exitDraft: () => Promise<void>
  addSection: (parentId: string | null, afterSectionId: string | null, title: string) => Promise<void>
  renameSection: (sectionId: string, title: string) => Promise<void>
  renameProject: (title: string) => Promise<void>
  deleteSection: (sectionId: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  saveProjectTo: (fmt: 'md' | 'docx' | 'pdf') => Promise<string | null>
  setSaveState: (state: AppState['saveState']) => void
  saveSectionText: (text: string) => Promise<void>
  applyEvent: (event: Record<string, unknown>) => void
  addChat: (role: ChatMessage['role'], text: string) => void
  addLog: (text: string) => void
  setRun: (run: RunState | null) => void
  setRightTab: (tab: AppState['rightTab']) => void
  toggleBottom: (open?: boolean) => void
  setBottomTab: (tab: AppState['bottomTab']) => void
  showToast: (text: string) => void
  requestSuggestion: (textBefore: string, textAfter: string) => void
  clearSuggestion: () => void
  refreshHealth: () => Promise<void>
  setTheme: (theme: string) => void
  setFont: (font: { family: string; size: number }) => void
  loadFontCatalog: () => Promise<FontFamily[]>
  toggleSettings: (open?: boolean) => void
  toggleSidebar: (open?: boolean) => void
  toggleRight: (open?: boolean) => void
}

let nextId = 1

function walk(nodes: SectionNode[], visit: (node: SectionNode) => void): void {
  for (const node of nodes) {
    visit(node)
    walk(node.children, visit)
  }
}

function patchTree(nodes: SectionNode[], sectionId: string, patch: Partial<SectionNode>): SectionNode[] {
  return nodes.map((node) =>
    node.section_id === sectionId
      ? { ...node, ...patch }
      : { ...node, children: patchTree(node.children, sectionId, patch) }
  )
}

/** Bottom of the outline: the deepest last child of the last root. */
function lastLeaf(nodes: SectionNode[]): SectionNode | null {
  if (nodes.length === 0) return null
  let node = nodes[nodes.length - 1]
  while (node.children.length > 0) node = node.children[node.children.length - 1]
  return node
}

/** First sentence (or line) of a completion. Ghost suggestions stay short. */
function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const match = cleaned.match(/^.{0,200}?[.!?](\s|$)/)
  return match ? match[0].trim() : cleaned.slice(0, 200)
}

export const useStore = create<AppState>((set, get) => {
  // Autocomplete debounce + race guard state (per store instance).
  let suggestionTimer: ReturnType<typeof setTimeout> | null = null
  let suggestionToken = 0

  return {
    api: null,
    wsOnline: false,
    health: null,
    projects: [],
    project: null,
    tree: [],
    selectedId: null,
    section: null,
    saveState: 'clean',
    liveText: {},
    chat: [],
    logs: [],
    run: null,
    bottomOpen: false,
    bottomTab: 'problems',
    rightTab: 'chat',
    toast: null,
    suggestion: null,
    preDraftId: null,
    preDraftSection: null,
    settingsOpen: false,
    theme: initTheme(),
    font: initFont(),
    fontFamilies: FONT_FAMILIES,
    sidebarCollapsed: localStorage.getItem('quill-sidebar-collapsed') === '1',
    rightCollapsed: localStorage.getItem('quill-right-collapsed') === '1',

    async bootstrap() {
      // In the Electron shell the main process supplies the sidecar URL (and
      // native dialogs); in a plain browser (vite dev) fall back to the
      // default loopback port so the UI still works for development.
      const url = window.quill ? await window.quill.serverUrl() : 'http://127.0.0.1:8765'
      const api = new Api(url)
      set({ api })
      get().addLog(`sidecar at ${url}`)

      const ws = new WsClient(
        url.replace(/^http/, 'ws') + '/ws',
        (event) => get().applyEvent(event),
        (online) => set({ wsOnline: online })
      )
      ws.connect()

      if (window.quill) {
        window.quill.onOpenFile(async () => {
          const filePath = await window.quill.pickSourceFile()
          if (filePath) await get().openFilePath(filePath)
        })
        window.quill.onNewDoc(() => void get().newDoc())
        window.quill.onSidecarFailed(() =>
          get().addChat('error', 'Could not reach the quill_engine sidecar. Is the Python venv set up?')
        )
      }

      try {
        const health = await api.health()
        set({ health: { store: health.store, providers: health.providers } })
      } catch {
        get().addChat('error', 'Sidecar health check failed.')
      }
      await get().refreshProjects()
    },

    async refreshProjects() {
      const api = get().api
      if (!api) return
      try {
        set({ projects: await api.listProjects() })
      } catch (error) {
        console.error(error)
      }
    },

    async refreshProject() {
      const { api, project, selectedId } = get()
      if (!api || !project) return
      try {
        const out = await api.getProject(project.meta.project_id)
        set({ project: out, tree: out.tree })
        if (selectedId === DRAFT_ID) {
          await get().selectDraft()
        } else if (selectedId) {
          const detail = await api.getSection(project.meta.project_id, selectedId)
          set({ section: detail })
        }
      } catch (error) {
        console.error(error)
      }
    },

    async openFilePath(filePath) {
      const api = get().api
      if (!api) return
      get().showToast(`Opening ${filePath}…`)
      try {
        const out = await api.openProject(filePath)
        set({ project: out, tree: out.tree, selectedId: null, section: null, liveText: {} })
        get().showToast(`Opened “${out.meta.title}” · ${out.meta.section_count} sections.`)
        await get().refreshProjects()
        await get().autoSelectWritingSpot()
      } catch (error) {
        get().addChat('error', `Failed to open: ${String(error)}`)
      }
    },

    async newDoc() {
      const api = get().api
      if (!api) return
      try {
        const out = await api.newProject('Untitled')
        set({ project: out, tree: out.tree, selectedId: null, section: null, liveText: {} })
        await get().refreshProjects()
        // Drop the writer straight into a fresh section (normal writing software).
        await get().addSection(null, null, 'Introduction')
      } catch (error) {
        get().addChat('error', `Failed to create document: ${String(error)}`)
      }
    },

    async openProject(projectId) {
      const api = get().api
      if (!api) return
      try {
        const out = await api.getProject(projectId)
        set({ project: out, tree: out.tree, selectedId: null, section: null, liveText: {} })
        await get().autoSelectWritingSpot()
      } catch (error) {
        get().addChat('error', `Failed to open project: ${String(error)}`)
      }
    },

    async deleteProject(projectId) {
      const api = get().api
      if (!api) return
      try {
        await api.deleteProject(projectId)
        if (get().project?.meta.project_id === projectId) get().exitToLibrary()
        await get().refreshProjects()
      } catch (error) {
        get().showToast(`Could not delete: ${String(error)}`)
      }
    },

    async saveProjectTo(fmt: 'md' | 'docx' | 'pdf') {
      const { api, project } = get()
      if (!api || !project) return null
      const base = project.meta.title.replace(/[\\/:*?"<>|]/g, '-') || project.meta.project_id
      const ext = fmt === 'docx' ? 'docx' : fmt === 'pdf' ? 'pdf' : 'md'
      const defaultName = `${base}.${ext}`
      let outPath: string | null = null
      if (window.quill) {
        outPath = await window.quill.pickSaveFile(defaultName, fmt)
        if (!outPath) return null
      }
      try {
        const path = await api.export(project.meta.project_id, fmt, outPath ?? undefined)
        get().showToast(`Saved → ${path}`)
        return path
      } catch (error) {
        get().showToast(`Save failed: ${String(error)}`)
        return null
      }
    },

    exitToLibrary() {
      set({
        project: null,
        tree: [],
        selectedId: null,
        section: null,
        liveText: {},
        preDraftId: null,
        preDraftSection: null,
        run: null,
        suggestion: null
      })
      void get().refreshProjects()
    },

    async selectSection(sectionId) {
      const { api, project } = get()
      if (!api || !project) return
      set({ selectedId: sectionId, saveState: 'clean', suggestion: null })
      try {
        const detail = await api.getSection(project.meta.project_id, sectionId)
        set({ section: detail })
      } catch (error) {
        console.error(error)
      }
    },

    async selectDraft() {
      const { api, project, selectedId, section } = get()
      if (!api || !project) return
      set({
        preDraftId: selectedId && selectedId !== DRAFT_ID ? selectedId : get().preDraftId,
        preDraftSection: selectedId === DRAFT_ID ? get().preDraftSection : section,
        selectedId: DRAFT_ID,
        saveState: 'clean',
        suggestion: null
      })
      try {
        const markdown = await api.getDraft(project.meta.project_id)
        set({
          section: {
            section_id: DRAFT_ID,
            title: `${project.meta.title} (draft)`,
            level: 1,
            description: 'Whole document, plain text. Prose under a heading is also saved into that section.',
            text: markdown,
            status: 'draft',
            warnings: [],
            sources: [],
            missing_fields: [],
            model: ''
          }
        })
      } catch (error) {
        get().showToast(`Could not load draft: ${String(error)}`)
      }
    },

    async autoSelectWritingSpot() {
      const state = get()
      if (state.selectedId) return // already somewhere
      const bottom = lastLeaf(state.tree)
      if (bottom) {
        await state.selectSection(bottom.section_id)
      } else {
        // Blank document: create the first section so you can just write.
        await state.addSection(null, null, 'Untitled')
      }
    },

    async exitDraft() {
      const { preDraftId } = get()
      if (preDraftId) await get().selectSection(preDraftId)
      else {
        const first = get().tree[0]
        if (first) await get().selectSection(first.section_id)
      }
      set({ preDraftId: null, preDraftSection: null })
    },

    async addSection(parentId, afterSectionId, title) {
      const { api, project } = get()
      if (!api || !project) return
      try {
        const out = await api.addSection(project.meta.project_id, {
          title,
          parent_id: parentId,
          after_section_id: afterSectionId
        })
        set({ project: out.project, tree: out.project.tree })
        if (out.section_id) await get().selectSection(out.section_id)
      } catch (error) {
        get().showToast(`Could not add section: ${String(error)}`)
      }
    },

    async renameProject(title) {
      const { api, project } = get()
      if (!api || !project) return
      try {
        const out = await api.renameProject(project.meta.project_id, title)
        set({ project: out, tree: out.tree })
        if (get().section?.section_id === DRAFT_ID) {
          set((state) => ({
            section: state.section
              ? { ...state.section, title: `${out.meta.title} (draft)` }
              : null
          }))
        }
        await get().refreshProjects()
      } catch (error) {
        get().showToast(`Could not rename: ${String(error)}`)
      }
    },

    async renameSection(sectionId, title) {
      const { api, project } = get()
      if (!api || !project) return
      try {
        const out = await api.renameSection(project.meta.project_id, sectionId, title)
        set({ project: out.project, tree: out.project.tree })
        if (get().section?.section_id === sectionId) {
          set((state) => ({ section: state.section ? { ...state.section, title } : null }))
        }
      } catch (error) {
        get().showToast(`Could not rename: ${String(error)}`)
      }
    },

    async deleteSection(sectionId) {
      const { api, project, section } = get()
      if (!api || !project) return
      try {
        const out = await api.deleteSection(project.meta.project_id, sectionId)
        const cleared =
          section?.section_id === sectionId
            ? { section: null, selectedId: null }
            : {}
        set({ project: out.project, tree: out.project.tree, ...cleared })
      } catch (error) {
        get().showToast(`Could not delete: ${String(error)}`)
      }
    },

    setSaveState(saveState) {
      set({ saveState })
    },

    async saveSectionText(text) {
      const { api, project, section } = get()
      if (!api || !project || !section) return
      if (section.section_id === DRAFT_ID) {
        set({ saveState: 'saving' })
        try {
          const out = await api.freewrite(project.meta.project_id, text)
          set({
            project: out.project,
            tree: out.project.tree,
            saveState: 'saved'
          })
        } catch (error) {
          set({ saveState: 'dirty' })
          get().showToast(`Draft save failed: ${String(error)}`)
        }
        return
      }
      set({ saveState: 'saving' })
      try {
        const saved = await api.saveSection(project.meta.project_id, section.section_id, text)
        set({
          section: { ...saved, title: section.title, level: section.level, description: section.description },
          saveState: 'saved'
        })
        set((state) => ({
          tree: patchTree(state.tree, section.section_id, {
            word_count: saved.text.split(/\s+/).filter(Boolean).length,
            warning_count: saved.warnings.length,
            status: 'generated'
          })
        }))
      } catch (error) {
        set({ saveState: 'dirty' })
        get().showToast(`Save failed: ${String(error)}`)
      }
    },

    addChat(role, text) {
      set((state) => ({
        chat: [...state.chat.slice(-199), { id: nextId++, role, text, ts: Date.now() }]
      }))
    },

    addLog(text) {
      set((state) => ({
        logs: [...state.logs.slice(-499), { id: nextId++, text, ts: Date.now() }]
      }))
    },

    setRun(run) {
      set({ run })
    },

    setRightTab(rightTab) {
      set({ rightTab })
    },

    toggleBottom(open) {
      set((state) => ({ bottomOpen: open ?? !state.bottomOpen }))
    },

    setBottomTab(bottomTab) {
      set({ bottomTab, bottomOpen: true })
    },

    showToast(text) {
      set({ toast: text })
      setTimeout(() => {
        if (get().toast === text) set({ toast: null })
      }, 4000)
    },

    requestSuggestion(textBefore, textAfter) {
      const { api, run } = get()
      if (!api || (run && run.status === 'running')) return
      if (textBefore.trim().length < 40) return
      if (suggestionTimer) clearTimeout(suggestionTimer)
      const token = ++suggestionToken
      suggestionTimer = setTimeout(async () => {
        try {
          const out = await api.complete(textBefore.slice(-600), textAfter.slice(0, 200))
          // A newer request or an explicit dismiss invalidates this response.
          if (token !== suggestionToken) return
          const completion = firstSentence(out.completion)
          set({ suggestion: completion || null })
        } catch {
          if (token === suggestionToken) set({ suggestion: null })
        }
      }, 1200)
    },

    async refreshHealth() {
      const { api } = get()
      if (!api) return
      try {
        const health = await api.health()
        set({ health: { store: health.store, providers: health.providers } })
      } catch {
        /* keep previous health state */
      }
    },

    setTheme(theme) {
      const apply = () => applyTheme(theme)
      if (typeof document.startViewTransition === 'function') {
        document.startViewTransition(apply)
      } else {
        apply()
      }
      set({ theme })
    },

    setFont(font) {
      applyFont(font)
      set({ font })
    },

    async loadFontCatalog() {
      const cached = get().fontFamilies
      if (cached.length > FONT_FAMILIES.length) return cached
      try {
        const fonts = await fetchGoogleFonts()
        const bundled = new Set(FONT_FAMILIES.map((f) => f.label.toLowerCase()))
        const remote: FontFamily[] = fonts
          .filter((f) => !bundled.has(f.family.toLowerCase()))
          .slice(0, 60)
          .map((f) => ({
            group:
              f.category === 'monospace' ? 'Mono' : f.category === 'serif' || f.category === 'handwriting' ? 'Serif' : 'Sans',
            label: f.family,
            css: googleFontCss(f.family, f.category),
            remote: true
          }))
        set({ fontFamilies: [...FONT_FAMILIES, ...remote] })
        const saved = remote.find((f) => f.css === get().font.family)
        if (saved) loadGoogleFont(saved.label)
        return get().fontFamilies
      } catch {
        return get().fontFamilies
      }
    },

    toggleSettings(open) {
      set((state) => ({ settingsOpen: open ?? !state.settingsOpen }))
    },

    toggleSidebar(open) {
      set((state) => {
        const sidebarCollapsed = open ?? !state.sidebarCollapsed
        localStorage.setItem('quill-sidebar-collapsed', sidebarCollapsed ? '1' : '0')
        return { sidebarCollapsed }
      })
    },

    toggleRight(open) {
      set((state) => {
        const rightCollapsed = open ?? !state.rightCollapsed
        localStorage.setItem('quill-right-collapsed', rightCollapsed ? '1' : '0')
        return { rightCollapsed }
      })
    },

    clearSuggestion() {
      suggestionToken++
      if (suggestionTimer) clearTimeout(suggestionTimer)
      if (get().suggestion !== null) set({ suggestion: null })
    },

    applyEvent(event) {
      const type = event.type as string
      const state = get()

      switch (type) {
        case 'run_started': {
          get().setRun({
            runId: String(event.run_id),
            kind: event.kind as RunState['kind'],
            status: 'running',
            ratio: 0,
            sectionId: null,
            statusLabel: 'starting'
          })
          // New run, clean screen: stale streamed text from a previous run
          // must not linger in liveText while the new run streams.
          set({ liveText: {} })
          // No chat message here: the run status is rendered as a single
          // live shimmer element in ChatPanel while `run` is running.
          break
        }
        case 'progress': {
          const run = state.run
          const sectionId = String(event.section_id || '')
          const status = String(event.status)
          if (run && run.runId === event.run_id) {
            const label = sectionId ? `${status} ${shortId(sectionId)}` : status
            get().setRun({ ...run, ratio: Number(event.ratio) || 0, sectionId, statusLabel: label })
          }
          if (sectionId) {
            set((s) => ({
              tree: patchTree(s.tree, sectionId, { status: mapStatus(status) }),
              // A new generation of this section begins now: drop liveText left
              // over from an earlier run so deltas start from a clean slate.
              ...(status === 'generating' && s.liveText[sectionId] !== undefined
                ? { liveText: { ...s.liveText, [sectionId]: '' } }
                : {})
            }))
          }
          break
        }
        case 'delta': {
          // Live token stream. The editor "types along" via liveText. The
          // backend sends the authoritative full text via a `section` event,
          // so section.text is only ever replaced, never appended to.
          const sectionId = String(event.section_id || '')
          if (!sectionId) break
          const chunk = String(event.text ?? '')
          set((s) => ({
            liveText: { ...s.liveText, [sectionId]: (s.liveText[sectionId] || '') + chunk }
          }))
          break
        }
        case 'section': {
          const sectionId = String(event.section_id)
          const text = String(event.text || '')
          set((s) => ({
            liveText: { ...s.liveText, [sectionId]: text },
            tree: patchTree(s.tree, sectionId, {
              status: 'generated',
              word_count: text.split(/\s+/).filter(Boolean).length
            })
          }))
          if (state.section?.section_id === sectionId && state.saveState !== 'dirty') {
            set({ section: { ...state.section, text, status: 'generated' }, saveState: 'clean' })
          }
          break
        }
        case 'run_done': {
          const status = String(event.status)
          const summary = (event.summary || {}) as Record<string, number>
          get().setRun(state.run && state.run.runId === event.run_id ? { ...state.run, status: status as RunState['status'] } : null)
          // A cancelled/failed run may have left partial streamed text in
          // liveText; refreshProject() reloads the authoritative server state.
          set({ liveText: {} })
          const bits = [
            summary.generated != null ? `${summary.generated} written` : null,
            summary.added != null ? `${summary.added} added` : null,
            summary.renamed != null ? `${summary.renamed} renamed` : null,
            summary.removed != null ? `${summary.removed} removed` : null,
            summary.blocked ? `${summary.blocked} blocked` : null,
            summary.failed ? `${summary.failed} failed` : null
          ].filter(Boolean)
          if (status === 'error') {
            get().addChat('error', `Run failed: ${String(event.error || 'unknown error')}`)
          } else if (status === 'cancelled') {
            get().addChat('system', `Run cancelled${bits.length ? ` · ${bits.join(', ')}` : ''}.`)
          } else {
            get().addChat('system', `Done${bits.length ? ` · ${bits.join(', ')}` : ''}.`)
          }
          void get().refreshProject()
          break
        }
        case 'section_saved':
        case 'evidence_saved':
          void get().refreshProject()
          break
        case 'tree_changed': {
          const changedId = event.section_id ? String(event.section_id) : null
          void (async () => {
            await get().refreshProject()
            // New sections arrive deselected; open them when the server names one.
            if (changedId && !get().section && get().selectedId !== DRAFT_ID) {
              const exists = findNode(get().tree, changedId)
              if (exists) await get().selectSection(changedId)
            }
          })()
          break
        }
        case 'ingest_done':
          void get().refreshProjects()
          break
        default:
          get().addLog(JSON.stringify(event))
      }
    }
  }
})

function findNode(nodes: SectionNode[], sectionId: string): SectionNode | null {
  for (const node of nodes) {
    if (node.section_id === sectionId) return node
    const found = findNode(node.children, sectionId)
    if (found) return found
  }
  return null
}

function mapStatus(status: string): SectionNode['status'] {
  if (status === 'generated') return 'generated'
  if (status === 'blocked') return 'blocked'
  if (status === 'failed') return 'failed'
  return 'pending'
}

function shortId(sectionId: string): string {
  return sectionId.length > 10 ? `${sectionId.slice(0, 10)}…` : sectionId
}

// Debug/testing hook (dev only convenience; harmless in prod).
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__quillStore = useStore
}
