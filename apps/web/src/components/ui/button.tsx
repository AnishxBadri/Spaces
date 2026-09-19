import * as React from 'react'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '#/lib/utils.ts'

const buttonVariants = cva(
  // `focus-ring` is the one focus treatment app-wide (see styles.css); shadcn's
  // default translucent ring sat under 3:1 against white. Keep this swap if
  // these primitives are ever re-vendored.
  "focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-ui font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out-quart active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        outline: 'border border-hairline bg-paper hover:bg-bone',
        secondary: 'bg-bone text-foreground hover:bg-bone-deep',
        ghost: 'hover:bg-bone',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3 has-[>svg]:px-2.5',
        xs: "h-6 gap-1 rounded-md px-2 text-label has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-[1.625rem] gap-1.5 rounded-md px-2 text-label has-[>svg]:px-1.5',
        lg: 'h-9 rounded-md px-4 has-[>svg]:px-3',
        icon: 'size-8',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

/**
 * Whether the button around you is mid-write (DESIGN.md §5,
 * Micro-interactions; SPA-53). `KeyHint` reads it so `Save ⌘↵` becoming
 * `Saving…` does not leave a keycap standing for an action that is no longer
 * armed. A context rather than a `group-data-` class because the hint has to
 * leave the accessibility tree too — a screen reader announcing
 * "Saving… ⌘↵" is the same orphan, just heard instead of seen.
 */
const ButtonPending = React.createContext(false)

export function useButtonPending(): boolean {
  return React.useContext(ButtonPending)
}

/**
 * The key hint's two states. It never unmounts: the No-Shift Rule wants the
 * hint's width reserved while it is gone, so the pending label cannot widen
 * the button and shove its neighbours. Opacity only, on a named transition.
 */
export function keyHintClasses(pending: boolean): string {
  return cn(
    'mono text-micro transition-opacity duration-150 ease-out-quart',
    pending ? 'opacity-0' : 'opacity-85',
  )
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  pending = false,
  disabled,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** A write is in flight: the action is not armed, so its key hint goes. */
    pending?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <ButtonPending value={pending}>
      <Comp
        data-slot="button"
        data-variant={variant}
        data-size={size}
        data-pending={pending ? '' : undefined}
        disabled={disabled ?? pending}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    </ButtonPending>
  )
}

export { Button, buttonVariants }
