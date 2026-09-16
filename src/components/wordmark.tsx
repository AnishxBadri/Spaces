import { cn } from '#/lib/utils'

/**
 * The 1-bit mark: a 4×4 Bayer tile in ink. The one piece of dither that is
 * allowed to be permanent (the Dither Rule keeps it out of everything with
 * text), because it is the maker's mark, not decoration.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn('size-4 shrink-0', className)}
    >
      <rect width="16" height="16" fill="currentColor" />
      <g fill="var(--paper)">
        {[2, 6, 10].map((x) => (
          <rect key={`a${x}`} x={x} y="2" width="2" height="2" />
        ))}
        {[4, 8, 12].map((x) => (
          <rect key={`b${x}`} x={x} y="4" width="2" height="2" />
        ))}
        {[2, 6, 10].map((x) => (
          <rect key={`c${x}`} x={x} y="6" width="2" height="2" />
        ))}
        {[4, 8, 12].map((x) => (
          <rect key={`d${x}`} x={x} y="8" width="2" height="2" />
        ))}
        {[2, 6, 10].map((x) => (
          <rect key={`e${x}`} x={x} y="10" width="2" height="2" />
        ))}
        {[4, 8, 12].map((x) => (
          <rect key={`f${x}`} x={x} y="12" width="2" height="2" />
        ))}
      </g>
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Mark className="text-foreground" />
      <span className="label-caps text-[0.75rem] text-foreground">Spaces</span>
    </span>
  )
}
