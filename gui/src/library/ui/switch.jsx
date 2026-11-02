import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '../../platform/cn.js'

/**
 * A switch, over Radix's Switch primitive.
 *
 * Radix renders a `<button role="switch">` carrying `aria-checked`, which is what
 * replaces the checkbox-with-`role="switch"` this stood in for. A `button` is a
 * labelable element, so the surrounding `<label htmlFor>` keeps binding to it.
 *
 * No animation: the canonical shadcn switch transitions its thumb and track on
 * `data-[state=checked]`, and the app has removed motion outside the assistant.
 * The state still has to be legible, so the track and thumb change colour rather
 * than position -- see the `checked:` utilities below.
 */
const Switch = React.forwardRef(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'tw:peer tw:inline-flex tw:h-5 tw:w-9 tw:shrink-0 tw:cursor-pointer tw:items-center tw:rounded-full tw:border-2 tw:border-transparent tw:transition-colors',
      'tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:focus-visible:ring-offset-2',
      'tw:disabled:cursor-not-allowed tw:disabled:opacity-50',
      'tw:data-[state=checked]:bg-primary tw:data-[state=unchecked]:bg-input',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'tw:pointer-events-none tw:block tw:h-4 tw:w-4 tw:rounded-full tw:bg-background tw:shadow-lg',
        'tw:data-[state=checked]:bg-primary-foreground tw:data-[state=unchecked]:bg-background',
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch }