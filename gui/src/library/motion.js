/**
 * The transition shared by every dialog-sized surface.
 *
 * It lived in `main.jsx` as a local function, which meant a second modal surface
 * added anywhere else had to either re-declare it or reach into `main.jsx` for
 * it -- and importing `main.jsx` to get a transition is a circular import that
 * resolves differently depending on which module the app loaded first. The
 * onboarding card is the second surface, so it is here now.
 *
 * A spring, not a tween: a dialog arriving is a physical object being set down,
 * and a spring settles rather than arriving. Reduced motion is a zero duration
 * rather than `stiffness: Infinity`, which Framer treats as an error rather than
 * as "do not move".
 */
export function getMotionTransition(reducedMotion) {
  return reducedMotion
    ? { duration: 0 }
    : { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 }
}

/**
 * The short tween, for anything that should feel like a response rather than an
 * arrival: taps, toggles, the boot layer, the shell.
 *
 * Moved here with `getPanelTransition` for the same reason `getMotionTransition`
 * came: all three were in `main.jsx`, and `ChatPanel` needs two of them from
 * outside it now that the panel is its own module.
 */
export function getFastTransition(reducedMotion) {
  return reducedMotion ? { duration: 0 } : { duration: 0.17, ease: [0.4, 0, 0.2, 1] }
}
