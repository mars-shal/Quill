import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useStore } from './state/store'
import TitleBar from './components/TitleBar'
import SectionTree from './components/SectionTree'
import EditorPane from './components/EditorPane'
import LibraryScreen from './components/LibraryScreen'
import ChatPanel from './components/ChatPanel'
import InspectorPanel from './components/InspectorPanel'
import ProblemsPanel from './components/ProblemsPanel'
import SettingsScreen from './components/SettingsScreen'
import StatusBar from './components/StatusBar'
import IconButton from './components/IconButton'

const MIN_PANEL = 200
const MAX_PANEL = 560

function loadWidth(key: string, fallback: number): number {
  const raw = Number(localStorage.getItem(key))
  return raw >= MIN_PANEL && raw <= MAX_PANEL ? raw : fallback
}

/** Drag handle that resizes the panel to its left (right edge) or right (left edge). */
function ResizeHandle({ side, onDrag }: { side: 'left' | 'right'; onDrag: (deltaX: number) => void }) {
  const lastX = useRef(0)

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      lastX.current = event.clientX
      const onMove = (e: MouseEvent) => {
        onDrag(e.clientX - lastX.current)
        lastX.current = e.clientX
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.classList.remove('resizing')
      }
      document.body.classList.add('resizing')
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [onDrag]
  )

  return <div className={`resize-handle ${side}`} onMouseDown={onMouseDown} role="separator" />
}

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap)
  const project = useStore((s) => s.project)
  const run = useStore((s) => s.run)
  const bottomOpen = useStore((s) => s.bottomOpen)
  const bottomTab = useStore((s) => s.bottomTab)
  const rightTab = useStore((s) => s.rightTab)
  const toast = useStore((s) => s.toast)
  const setBottomTab = useStore((s) => s.setBottomTab)
  const setRightTab = useStore((s) => s.setRightTab)
  const toggleBottom = useStore((s) => s.toggleBottom)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const rightCollapsed = useStore((s) => s.rightCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const toggleRight = useStore((s) => s.toggleRight)

  const [sidebarWidth, setSidebarWidth] = useState(() => loadWidth('quill-sidebar-w', 272))
  const [rightWidth, setRightWidth] = useState(() => loadWidth('quill-right-w', 356))

  const clamp = (w: number) => Math.min(MAX_PANEL, Math.max(MIN_PANEL, w))
  const dragSidebar = useCallback((delta: number) => {
    setSidebarWidth((w) => {
      const next = clamp(w + delta)
      localStorage.setItem('quill-sidebar-w', String(next))
      return next
    })
  }, [])
  const dragRight = useCallback((delta: number) => {
    setRightWidth((w) => {
      const next = clamp(w - delta)
      localStorage.setItem('quill-right-w', String(next))
      return next
    })
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // Escape stops the active generation (run / rewrite / merge).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const { run, api } = useStore.getState()
      if (run?.status === 'running' && api) {
        event.preventDefault()
        useStore.getState().setRun({ ...run, statusLabel: 'stopping…' })
        void api.cancelRun(run.runId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const running = run?.status === 'running'

  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <TitleBar />
        <div className="app-body">
          {sidebarCollapsed ? (
            <button className="panel-rail rail-left" onClick={() => toggleSidebar(false)} title="Show sections">
              <ChevronRight size={15} />
            </button>
          ) : (
            <>
              <aside className="sidebar" style={{ width: sidebarWidth }}>
                <SectionTree />
              </aside>
              <ResizeHandle side="left" onDrag={dragSidebar} />
            </>
          )}
          <main className="editor-area">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={project ? 'editor' : 'library'}
                className="editor-stage"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                {project ? <EditorPane /> : <LibraryScreen />}
              </motion.div>
            </AnimatePresence>
          </main>
          {rightCollapsed ? (
            <button className="panel-rail rail-right" onClick={() => toggleRight(false)} title="Show assistant">
              <ChevronLeft size={15} />
            </button>
          ) : (
            <>
              <ResizeHandle side="right" onDrag={dragRight} />
              <aside className="right-panel" style={{ width: rightWidth }}>
                <div className="right-tabs">
                  <button
                    className={rightTab === 'chat' ? 'active' : ''}
                    onClick={() => setRightTab('chat')}
                  >
                    Assistant
                  </button>
                  <button
                    className={rightTab === 'inspector' ? 'active' : ''}
                    onClick={() => setRightTab('inspector')}
                  >
                    Inspector
                  </button>
                  <span className="spacer" />
                  <IconButton icon={ChevronRight} label="Collapse panel" spinOnHover onClick={() => toggleRight(true)} size={13} />
                </div>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={rightTab}
                    className="right-pane-stage"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                  >
                    {rightTab === 'chat' ? <ChatPanel /> : <InspectorPanel />}
                  </motion.div>
                </AnimatePresence>
              </aside>
            </>
          )}
        </div>
        <div className={`bottom-panel ${bottomOpen ? 'open' : ''}`}>
          <div className="bottom-tabs">
            <button
              className={bottomTab === 'problems' ? 'active' : ''}
              onClick={() => setBottomTab('problems')}
            >
              Problems
            </button>
            <button
              className={bottomTab === 'log' ? 'active' : ''}
              onClick={() => setBottomTab('log')}
            >
              Log
            </button>
            <span className="spacer" />
            <button className="ghost" onClick={() => toggleBottom(false)} title="Close panel">
              ✕
            </button>
          </div>
          <ProblemsPanel />
        </div>
        <StatusBar />
        <SettingsScreen />
        <AnimatePresence>
          {toast && (
            <motion.div
              key={toast}
              className="toast"
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.94 }}
              transition={{
                type: 'spring',
                stiffness: 380,
                damping: 24,
                mass: 0.8
              }}
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
        {running && (
          <div className="run-progress" style={{ width: `${Math.round((run?.ratio || 0) * 100)}%` }} />
        )}
      </div>
    </MotionConfig>
  )
}
