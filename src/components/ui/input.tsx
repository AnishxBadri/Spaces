import * as React from 'react'

import { cn } from '#/lib/utils.ts'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-md border border-rule bg-paper px-2.5 py-1 text-base transition-colors duration-150 ease-out-quart selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-ui file:font-medium file:text-foreground placeholder:text-graphite disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-ui',
        // One focus treatment app-wide (see styles.css). shadcn's default here
        // was a translucent 3px ring that sat under 3:1 against white; keep this
        // swap if these primitives are ever re-vendored.
        'focus-ring',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
