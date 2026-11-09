import React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

/**
 * A number that changes state by motion, not by a jump.
 *
 * Used where a refresh can replace a value the reader is already looking at:
 * the old value leaves and the new one settles in the same space.
 */
export function ValueFlash({ value, className = '' }) {
  const reduced = useReducedMotion()
  return (
    <span className={`interior-value-flash ${className}`.trim()}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.strong
          key={String(value)}
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
          {value}
        </motion.strong>
      </AnimatePresence>
    </span>
  )
}
