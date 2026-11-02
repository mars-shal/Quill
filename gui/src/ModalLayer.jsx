/**
 * The scrim and backdrop for every modal surface.
 *
 * This lives in its own module rather than in `main.jsx` so the dialogs can
 * share it without importing the whole application. Export used to hand-roll a
 * `dialog-scrim` div instead, which meant a second scrim with no styling at all
 * -- the export dialog rendered inline in the editor flow rather than over it --
 * and a focus trap that was written twice.
 *
 * It owns two things a modal surface must not get wrong on its own:
 *
 *  - A scrim that closes on click but is out of the tab order and out of the
 *    accessibility tree. Escape and the dialog's own close button already close
 *    it, so a third close control announced first is noise.
 *  - A focus trap, so Tab cannot walk out of the dialog into the page behind and
 *    focus does not reappear wherever it was before.
 *
 * The layer is Radix's `Dialog.Root`, and a dialog that opts in renders through
 * `Dialog.Content`. The root is what routes Escape and outside-pointer dismissal
 * back to `onClose`, so every surface has one closing path. The trap stays here,
 * in this module, rather than being handed to the primitive: Radix's own focus
 * scope enumerates tabbable candidates itself, and the selector it uses and the
 * one `platform/a11y.js` uses are not the same list, so a surface cannot be
 * wired to both and be tested by only one.
 */

import { useRef } from 'react'

import { useFocusTrap } from './platform/a11y.js'
import { Dialog } from './library/ui/dialog.jsx'

export function ModalLayer({ children, onClose, className = '' }) {
  const layerRef = useRef(null)
  useFocusTrap(layerRef, true, onClose)
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose?.() }}>
      <div ref={layerRef} className={`modal-layer ${className}`}>
        {/* `pointer-events` because a modal `Dialog.Content` disables them on the
            body and re-enables them on the content alone. Without this the scrim
            stops being clickable, and the scrim is the only dismiss target a
            pointer user has that is not the close button. */}
        <button className="modal-scrim" type="button" tabIndex={-1} aria-hidden="true" style={{ pointerEvents: 'auto' }} onClick={onClose} />
        {children}
      </div>
    </Dialog.Root>
  )
}