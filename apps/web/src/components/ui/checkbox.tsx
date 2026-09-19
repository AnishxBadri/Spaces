import * as React from 'react'
import { Check } from 'lucide-react'

import { cn } from '#/lib/utils.ts'

/**
 * The class string a checkbox box wears. Exported for tests.
 *
 * A 14px square that fills with pine (DESIGN.md §5, "Typed Value Editors"):
 * never a native rounded control, never a circle. Unchecked tints to bone on
 * hover the way a highlighted option does; focus is the reticle and nothing
 * else.
 */
export function checkboxClasses({
  checked,
  className,
}: {
  checked: boolean
  className?: string | undefined
}) {
  return cn(
    'focus-ring flex size-3.5 shrink-0 touch-manipulation items-center justify-center border transition-colors duration-150 ease-out-quart disabled:pointer-events-none disabled:opacity-50',
    checked
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-hairline bg-paper hover:bg-bone',
    className,
  )
}

/**
 * A checkbox.
 *
 * A `<button role="checkbox">` rather than a native input or a Radix control:
 * a Radix checkbox drags its own focus treatment in and the Reticle Rule has
 * no exceptions left, and no call site sits inside a form that submits — every
 * one writes through a server fn the moment it is toggled — so there is no
 * name/value pair for a native input to contribute. The caller owns the label
 * and the hit area around it.
 */
function Checkbox({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<
  React.ComponentProps<'button'>,
  'type' | 'role' | 'aria-checked' | 'onChange' | 'children'
> & {
  checked: boolean
  onCheckedChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-slot="checkbox"
      onClick={() => onCheckedChange(!checked)}
      className={checkboxClasses({ checked, className })}
      {...props}
    >
      {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
    </button>
  )
}

export { Checkbox }
