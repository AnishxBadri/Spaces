import { Toggle as TogglePrimitive } from 'radix-ui'
import type * as React from 'react'

import { Button, buttonVariants } from '#/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { cn } from '#/lib/utils.ts'

/**
 * The half of BlockNote's chrome the app owns by handing the library its own
 * components; `NoteEditor` carries the map of which surface went which way.
 * BlockNote reads these from its `ShadCNComponentsContext`, so these surfaces
 * are drawn by the app's own primitives, with no second copy of the
 * vocabulary to keep in step.
 */

/**
 * A pressed toolbar button (bold, italic, the colour picker trigger). The one
 * adapter here rather than a hand-over, because the app has no `Toggle`
 * primitive and does not need one: a toggle is the `Button` it already has,
 * pressed reading `secondary` — bone, per the No-Bar Rule, which is the same
 * thing a highlighted menu row does. Focus is the reticle, because
 * `buttonVariants` carries `focus-ring`.
 */
function EditorToggle({
  className,
  variant: _variant,
  size,
  pressed,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & {
  variant?: 'default' | 'outline' | null | undefined
  size?: 'default' | 'sm' | 'lg' | null | undefined
}) {
  // `pressed` is optional on the target, so an explicit `undefined` is a type
  // error rather than an omission (`exactOptionalPropertyTypes`) — the same
  // conditional spread `DropdownMenuCheckboxItem` uses.
  const pressedProp = pressed === undefined ? {} : { pressed }
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      {...pressedProp}
      className={cn(
        buttonVariants({
          variant: pressed ? 'secondary' : 'ghost',
          size: size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'default',
        }),
        className,
      )}
      {...props}
    />
  )
}

/**
 * The components map handed to `BlockNoteView`. Only the groups the app
 * already owns are listed: `Select`, `Badge`, `Card`, `Avatar`, `Skeleton`,
 * `Tabs` and `Form` have no Instrument primitive behind them, so BlockNote
 * keeps its own and the stylesheet dresses them — see the map in `NoteEditor`.
 */
export const instrumentChrome = {
  Button: { Button },
  DropdownMenu: {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
  },
  Input: { Input },
  Label: { Label },
  Popover: { Popover, PopoverContent, PopoverTrigger },
  Toggle: { Toggle: EditorToggle },
  Tooltip: { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger },
}

/** Where a sheet grows from, given which side of its trigger it opened on. */
const SHEET_ORIGIN = {
  top: 'bottom left',
  bottom: 'top left',
  left: 'right top',
  right: 'left top',
}

/**
 * Enter and exit for the editor's floating sheets: 150ms in, 100ms out, on
 * `--ease-out-quart`, origin-aware, scale 0.96 → 1. floating-ui writes
 * position and transition as inline style, so this object is the only way in.
 * - `transform: false` is load-bearing: floating-ui would otherwise position
 *   with `transform` and the motion's `transform` would drop the sheet at
 *   the origin.
 * - `transition-property` comes from the keys of `initial`: exactly
 *   `opacity` and `transform`, never a third (the Compositor Rule).
 * - Reduce Motion is the global `prefers-reduced-motion` rule, whose
 *   `!important` outranks the inline style.
 */
export const SHEET_MOTION = {
  useFloatingOptions: { transform: false },
  useTransitionStylesProps: {
    duration: { open: 150, close: 100 },
    initial: { opacity: 0, transform: 'scale(0.96)' },
    common: ({ side }: { side: 'top' | 'right' | 'bottom' | 'left' }) => ({
      transformOrigin: SHEET_ORIGIN[side],
      transitionTimingFunction: 'var(--ease-out-quart)',
    }),
  },
}

/**
 * The drag handle and its `+`. A hover affordance rather than a sheet, so it
 * takes the hover timing — ≤100ms or nothing — and never scales: a handle that grows as the pointer crosses a block reads as a
 * twitch, not as an overlay arriving. Positioning is left on `transform`
 * because this one tracks the pointer down the document.
 */
export const HANDLE_MOTION = {
  useTransitionStylesProps: {
    duration: { open: 100, close: 100 },
    initial: { opacity: 0 },
    common: { transitionTimingFunction: 'var(--ease-out-quart)' },
  },
}
