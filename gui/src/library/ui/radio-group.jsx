import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { Circle } from 'lucide-react'

import { cn } from '../../platform/cn.js'

const RadioGroup = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Root
      className={cn('tw:grid tw:gap-2', className)}
      {...props}
      ref={ref}
    />
  )
})
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName

/**
 * `indicator={false}` renders the label directly instead of inside the dot.
 *
 * The canonical shadcn item puts `children` inside `RadioGroupPrimitive.Indicator`,
 * which Radix only mounts while the item is checked -- correct for "a radio dot
 * beside a label", wrong for a control that *is* its label. The segmented mode
 * switch, the texture chips, the format options and the onboarding themes are all
 * that second shape: the whole button is the label, so burying it in the
 * indicator would hide it except when selected.
 */
const RadioGroupItem = React.forwardRef(({ className, indicator = true, children, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        indicator &&
          'tw:aspect-square tw:h-4 tw:w-4 tw:rounded-full tw:border tw:border-primary tw:text-primary tw:shadow',
        'tw:focus:outline-none tw:focus-visible:ring-1 tw:focus-visible:ring-ring tw:disabled:cursor-not-allowed tw:disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {indicator ? (
        <RadioGroupPrimitive.Indicator className="tw:flex tw:items-center tw:justify-center">
          <Circle className="tw:h-3.5 tw:w-3.5 tw:fill-primary" />
        </RadioGroupPrimitive.Indicator>
      ) : (
        children
      )}
    </RadioGroupPrimitive.Item>
  )
})
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName

export { RadioGroup, RadioGroupItem }