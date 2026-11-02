import { cn } from '../../platform/cn.js'

export function Input({ className, type = 'text', ...props }) {
  return (
    <input
      type={type}
      className={cn(
        'tw:flex tw:h-9 tw:w-full tw:rounded-md tw:border tw:border-input tw:bg-background tw:px-3 tw:py-1 tw:text-sm tw:shadow-xs tw:transition-colors',
        'tw:placeholder:text-muted-foreground',
        'tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring',
        'tw:disabled:cursor-not-allowed tw:disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }) {
  return (
    <label
      className={cn(
        'tw:text-sm tw:font-medium tw:leading-none tw:text-foreground',
        className,
      )}
      {...props}
    />
  )
}