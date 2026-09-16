import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

const WELCOME_SEEN_KEY = 'quill-welcome-seen'

/** First-run overlay shown once (localStorage flag); dismiss sticks. */
export default function WelcomeOverlay() {
  const [open, setOpen] = useState(() => !localStorage.getItem(WELCOME_SEEN_KEY))

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function dismiss() {
    localStorage.setItem(WELCOME_SEEN_KEY, '1')
    setOpen(false)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="welcome-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <motion.div
            className="welcome-modal"
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <h1>Quill</h1>
            <p className="welcome-tagline">An IDE for writers.</p>
            <p className="welcome-pitch">Ingest a document, generate with AI, refine by hand.</p>
            <ol className="welcome-steps">
              <li>
                <span>1</span>
                <p>
                  <strong>Open a source document</strong> — md, docx, pdf, and pptx land as a
                  structured section tree.
                </p>
              </li>
              <li>
                <span>2</span>
                <p>
                  <strong>Ask the assistant</strong> — generate, rewrite, or fill sections from a
                  prompt with live progress.
                </p>
              </li>
              <li>
                <span>3</span>
                <p>
                  <strong>Refine by hand</strong> — finish in the WYSIWYG editor; everything is
                  stored locally.
                </p>
              </li>
            </ol>
            <button className="primary" onClick={dismiss}>
              Start writing
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}