import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Class-name helper for components that take a `className`.
 *
 * `clsx` handles the conditional part -- arrays, objects, falsy values -- and
 * `twMerge` resolves Tailwind conflicts, so a caller can override what a
 * component set up for itself:
 *
 *   cn('px-3 py-1.5', className)          // caller's px wins
 *   cn('text-muted-foreground', isDanger && 'text-destructive')
 *
 * Without `twMerge` the later class is simply appended, so `px-3` and `px-6` both
 * land in the attribute and the winner is decided by stylesheet order rather than
 * by the caller. That is exactly the ambiguity a component API should not have.
 *
 * A component should only pass through `className` when the override is
 * meaningful. Every hook that accepts it becomes a promise that later utilities
 * beat the defaults.
 *
 * This is Tailwind's `twMerge`; see `tailwind.css` for how the palette resolves.
 *
 * One consequence of the examples above: Tailwind's scanner reads the text of
 * every file under `src/`, comments included, so `px-3`, `px-6`, `py-1.5`,
 * `text-muted-foreground` and `text-destructive` each emit a rule into the
 * shipped stylesheet. That is about 200 bytes for documentation, which is a fine
 * trade -- but it is the reason to keep this comment's examples short rather than
 * a second worked example inline.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}