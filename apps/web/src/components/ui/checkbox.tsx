import * as React from 'react'
import { Check } from 'lucide-react'

import { cn } from '#/lib/utils.ts'

/**
 * The class string a checkbox box wears. Exported for tests.
 *
 * A 14px square that fills with pine: never a native rounded control, never a circle. Unchecked tints to bone on
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

/**
 * The class string a radio box wears: the checkbox's 14px square, which
 * holds a 6px pine square when chosen instead of filling — one of a set,
 * never a tick. Exported for tests.
 */
export function radioClasses({
  checked,
  className,
}: {
  checked: boolean
  className?: string | undefined
}) {
  return cn(
    'focus-ring flex size-3.5 shrink-0 touch-manipulation items-center justify-center border bg-paper transition-colors duration-150 ease-out-quart disabled:pointer-events-none disabled:opacity-50',
    checked ? 'border-primary' : 'border-hairline hover:bg-bone',
    className,
  )
}

/**
 * A radio: one choice of a set, for a single-choice pin or floor. A
 * `<button role="radio">` for the same reasons as `Checkbox`; the caller
 * draws the `radiogroup` around the set and owns each label.
 */
function Radio({
  checked,
  onSelect,
  className,
  ...props
}: Omit<
  React.ComponentProps<'button'>,
  'type' | 'role' | 'aria-checked' | 'onChange' | 'onSelect' | 'children'
> & {
  checked: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-slot="radio"
      onClick={() => {
        if (!checked) onSelect()
      }}
      className={radioClasses({ checked, className })}
      {...props}
    >
      {checked ? <span aria-hidden className="size-1.5 bg-primary" /> : null}
    </button>
  )
}

export { Checkbox, Radio }
