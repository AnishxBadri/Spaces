import * as React from 'react'
import { Label as LabelPrimitive } from 'radix-ui'

import { cn } from '#/lib/utils.ts'

/**
 * A field's label: sans 12 graphite in sentence case, 6px above its control
 * (the caller's `gap-1.5`); an error goes under the control in destructive
 * at the same step.
 */
function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-label text-graphite select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
