import * as React from 'react'

import { cn } from '#/lib/utils.ts'

/**
 * The three class strings a switch is made of. Exported for tests.
 *
 * DESIGN.md §5, "Inputs / Fields" (Switches, 2026-09-15): a 24×14 square track
 * with a 10px square knob and 2px of padding, no radius. Off is a rule track on
 * paper with a **graphite** knob; on is the pine selection wash with a pine
 * border and a **pine** knob — pine is what "active" is made of everywhere else
 * in the instrument, and the state has to be readable from one switch with no
 * second switch to compare against. Position is a consequence of the state, not
 * the state: a track that only moves an ink block reads as a stray mark.
 *
 * The knob travels on `translate-x` — the Compositor Rule holds inside controls
 * too — and the reticle is the only focus treatment, which is why this is a
 * plain button and not Radix's Switch.
 */
export function switchClasses({
  checked,
  className,
}: {
  checked: boolean
  className?: string | undefined
}) {
  return {
    root: cn(
      'focus-ring flex items-center gap-2 text-label text-graphite transition-colors duration-100 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
      className,
    ),
    track: cn(
      'flex h-3.5 w-6 items-center border p-px transition-colors duration-100 ease-out-quart',
      checked ? 'border-primary bg-selected' : 'border-rule bg-paper',
    ),
    knob: cn(
      'size-2.5 transition-transform duration-100 ease-out-quart',
      checked ? 'translate-x-2.5 bg-primary' : 'translate-x-0 bg-graphite',
    ),
  }
}

/**
 * A switch. `children` is the label the whole control reads as, so the track
 * and its text share one hit area and one reticle.
 */
function Switch({
  checked,
  onCheckedChange,
  className,
  children,
  ...props
}: Omit<
  React.ComponentProps<'button'>,
  'type' | 'role' | 'aria-checked' | 'onChange'
> & {
  checked: boolean
  onCheckedChange: (next: boolean) => void
}) {
  const c = switchClasses({ checked, className })
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      onClick={() => onCheckedChange(!checked)}
      className={c.root}
      {...props}
    >
      <span aria-hidden className={c.track}>
        <span className={c.knob} />
      </span>
      {children}
    </button>
  )
}

export { Switch }
