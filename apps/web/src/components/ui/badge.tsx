import * as React from 'react'
import { Slot } from 'radix-ui'

import { badgeStyle, optionColor } from '@spaces/core/attributes/colors'

import { cn } from '#/lib/utils.ts'

/**
 * The colour → inline-style map, re-exported so the badge is the one place in
 * the app that turns a stored colour into paint. `option-list-editor`'s colour
 * swatches take it from here rather than from core: a swatch is choosing a
 * badge colour, so it belongs to the badge, and `@spaces/core`'s `badgeStyle`
 * keeps exactly one importer.
 */
export { badgeStyle }

/**
 * What a badge needs of an option row. Deliberately the row and not a resolved
 * colour: `optionColor`'s index fallback is why a set defined before the
 * palette existed still renders fully coloured, and why the board and Today
 * agree on hues for the same stage. Hand a `Badge` a colour and that agreement
 * becomes each caller's problem.
 */
export type BadgeOption = { color?: string } | undefined

/**
 * The class string a badge wears. Exported for tests and for the rare caller
 * that owns its own element without going through `asChild`.
 *
 * Square chips, mono 11 medium, 20px tall, 6px inset (DESIGN.md §5 "Option
 * Badges"). Two states drop the hue, both documented:
 *
 * - `archived` — struck graphite on bone (DESIGN.md §5, Settings: "archived
 *   options struck on bone"). It is a prop rather than each caller's business
 *   because the treatment was duplicated at four sites and had drifted at
 *   three of them.
 * - `unselected` — a dashed rule in graphite (DESIGN.md §5, the Mandate:
 *   "stages as badges with the unselected ones dashed").
 */
export function badgeClasses({
  archived = false,
  unselected = false,
  interactive = false,
  className,
}: {
  archived?: boolean | undefined
  unselected?: boolean | undefined
  interactive?: boolean | undefined
  className?: string | undefined
}) {
  return cn(
    'flex h-5 items-center px-1.5 mono text-micro font-medium aria-disabled:pointer-events-none aria-disabled:opacity-50',
    // Hover and press live on opacity so the Compositor Rule holds, and the
    // reticle is the focus treatment — both only when the caller supplied an
    // element that can be hovered, pressed or focused at all.
    interactive &&
      'focus-ring transition-[color,background-color,border-color,opacity] duration-150 ease-out-quart hover:opacity-80 active:opacity-70',
    archived && 'bg-bone font-normal text-graphite line-through',
    unselected &&
      'border border-dashed border-rule font-normal text-graphite hover:border-hairline hover:text-foreground',
    className,
  )
}

/**
 * The hue a badge paints, from the option row and its position — never from a
 * colour the caller resolved, so `optionColor`'s index fallback keeps deciding
 * and the board, Today and the registry agree on the hue of the same stage.
 * The two documented hueless states paint nothing and take their classes
 * instead.
 */
export function badgeTint({
  option,
  index,
  archived = false,
  unselected = false,
}: {
  option: BadgeOption
  index: number
  archived?: boolean | undefined
  unselected?: boolean | undefined
}) {
  if (archived || unselected) return undefined
  return badgeStyle(optionColor(option, index))
}

/**
 * A square option badge. Renders a `<span>`; pass `asChild` to wear a button
 * or a link instead, which is also what turns on the hover, press and focus
 * states.
 */
function Badge({
  option,
  index,
  archived = false,
  unselected = false,
  asChild = false,
  className,
  style,
  ...props
}: Omit<React.ComponentProps<'span'>, 'color'> & {
  option: BadgeOption
  index: number
  // `| undefined` throughout: an option row's `archived` flag is itself
  // optional, and a caller forwarding it is the normal case, not a bug
  // (`exactOptionalPropertyTypes`).
  archived?: boolean | undefined
  unselected?: boolean | undefined
  asChild?: boolean | undefined
}) {
  const Comp = asChild ? Slot.Root : 'span'
  const tint = badgeTint({ option, index, archived, unselected })
  return (
    <Comp
      data-slot="badge"
      className={badgeClasses({
        archived,
        unselected,
        interactive: asChild,
        className,
      })}
      style={tint ? { ...tint, ...style } : style}
      {...props}
    />
  )
}

export { Badge }
