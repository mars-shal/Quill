import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

import { cn } from '../../platform/cn.js'

/**
 * The modal surface, over Radix's Dialog primitive.
 *
 * `ModalLayer` owns the scrim and the focus trap, and this owns the dialog box
 * itself. Radix brings its own focus scope and dismissal handling, which is why
 * the trap in `src/ModalLayer.jsx` is a peer rather than a replacement: the layer
 * is what the app's `dialog-keyboard.test.mjs` asserts against, and swapping that
 * out is a separate change with its own evidence.
 *
 * No animation: `data-[state=open]:animate-in` and its `animate-out` partner are
 * deliberately absent, matching the rest of the app outside the assistant. The
 * overlay and content appear outright.
 */
const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('tw:fixed tw:inset-0 tw:z-[200] tw:bg-black/60', className)}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'tw:fixed tw:left-1/2 tw:top-1/2 tw:z-[200] tw:grid tw:w-full tw:max-w-lg tw:-translate-x-1/2 tw:-translate-y-1/2 tw:gap-4 tw:border tw:bg-background tw:p-6 tw:shadow-lg tw:rounded-lg',
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

function DialogHeader({ className, ...props }) {
  return (
    <div
      className={cn('tw:flex tw:flex-col tw:gap-1.5 tw:text-center tw:sm:text-left', className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }) {
  return (
    <div
      className={cn('tw:flex tw:flex-col-reverse tw:gap-2 tw:sm:flex-row tw:sm:justify-end', className)}
      {...props}
    />
  )
}

const DialogTitle = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('tw:text-lg tw:font-semibold tw:leading-none', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('tw:text-sm tw:text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  DialogPrimitive as Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
}