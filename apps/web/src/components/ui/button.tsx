import * as React from 'react'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'
import { cn } from '#/lib/utils.ts'

const buttonVariants = cva(
  // `focus-ring` is the one focus treatment app-wide; shadcn's
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
 * The text a button reads as, for its tooltip: the strings in its children,
 * icons skipped.
 */
function textOf(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return textOf(node.props.children)
  }
  return ''
}

/**
 * The ink tooltip a key lives in: the label in sans, then the key in mono at
 * 85%. A key is never printed inside the button itself.
 */
function ShortcutTip({
  label,
  shortcut,
  children,
}: {
  label: string
  shortcut: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent data-shortcut-tip>
        <span className="flex items-center gap-2.5">
          {label === '' ? null : <span>{label}</span>}
          <kbd className="mono opacity-85">{shortcut}</kbd>
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  pending = false,
  shortcut,
  disabled,
  ref,
  style,
  children,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /**
     * A write is in flight: the button disarms and holds the width it had
     * while armed, so the caller's `Saving…` never moves its neighbours.
     */
    pending?: boolean
    /** The key that runs this button, shown in its tooltip: `L`, `⌘↵`. */
    shortcut?: string | undefined
  }) {
  const Comp = asChild ? Slot.Root : 'button'
  const own = React.useRef<HTMLButtonElement | null>(null)
  // Measured on every armed commit, because by the render that turns pending
  // the label has already swapped.
  const armedWidth = React.useRef<number | null>(null)
  React.useLayoutEffect(() => {
    if (!pending && own.current) armedWidth.current = own.current.offsetWidth
  })
  const held =
    pending && armedWidth.current !== null
      ? { ...style, minWidth: armedWidth.current }
      : style

  const button = (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-pending={pending ? '' : undefined}
      disabled={disabled ?? pending}
      className={cn(buttonVariants({ variant, size, className }))}
      ref={(el: HTMLButtonElement | null) => {
        own.current = el
        if (typeof ref === 'function') return ref(el)
        if (ref) ref.current = el
      }}
      style={held}
      {...props}
    >
      {children}
    </Comp>
  )
  if (shortcut === undefined) return button
  return (
    <ShortcutTip
      label={props['aria-label'] ?? textOf(children).trim()}
      shortcut={shortcut}
    >
      {button}
    </ShortcutTip>
  )
}

export { Button, buttonVariants }
