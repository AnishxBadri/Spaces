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
 * components. `note-editor.tsx` carries the map of which surface went which
 * way; this file is the parts list.
 *
 * BlockNote reads these out of its `ShadCNComponentsContext`, so a surface
 * built from them is drawn by exactly the file every other menu, button and
 * tooltip in the app is drawn by — no restyling from outside, and no second
 * copy of the vocabulary to keep in step.
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
 * keeps its own and `styles.css` dresses them — see the map comment in
 * `note-editor.tsx`.
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
 * Enter and exit for the editor's floating sheets — DESIGN.md §5, "Menus:
 * 150/100", on `--ease-out-quart`, origin-aware, scale 0.96 → 1.
 *
 * This is the third seam (see the map in `note-editor.tsx`). BlockNote's
 * floating elements are positioned by floating-ui, which writes both the
 * position AND the transition as **inline style** on the wrapper — so neither
 * the components map nor a stylesheet can reach it, and this object is the
 * only way in.
 *
 * `transform: false` is load-bearing, not a preference: floating-ui positions
 * with `transform: translate(…)` by default and spreads the transition styles
 * over the positioning styles, so a `transform` in the transition would
 * overwrite the position and drop the sheet at the origin. Told to position
 * with `top`/`left` instead, `transform` is free for the motion. The
 * `transition-property` floating-ui emits is derived from the *keys* of
 * `initial`, so naming exactly `opacity` and `transform` is what holds the
 * Compositor Rule here — no third key may join them.
 *
 * Reduce Motion needs nothing added: the app's one global
 * `@media (prefers-reduced-motion: reduce)` rule (`styles.css`, `@layer base`)
 * sets `transition-duration: 0.01ms !important` on `*`, and `!important`
 * outranks an inline style, so the kill switch reaches this without knowing
 * it exists.
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
 * takes DESIGN.md §5's other number — "hovers: ≤100ms or nothing" — and never
 * scales: a handle that grows as the pointer crosses a block reads as a
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
