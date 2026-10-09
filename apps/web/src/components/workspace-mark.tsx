import { cn } from '#/lib/utils'

/**
 * The workspace's mark: its logo when one is set, else the monogram — the
 * name's initial in an ink square. Drawn at the sidebar head (24px) and in
 * General's Logo row (48px). (D81)
 * - The logo is never cropped: it sits whole inside the square.
 */
export function WorkspaceMark({
  name,
  logo,
  size,
  className,
}: {
  name: string
  logo: string | null
  size: number
  className?: string
}) {
  if (logo !== null)
    return (
      <img
        src={logo}
        alt=""
        aria-hidden
        width={size}
        height={size}
        draggable={false}
        style={{ width: size, height: size }}
        className={cn('shrink-0 rounded-none object-contain', className)}
      />
    )
  return (
    <span
      aria-hidden
      data-monogram
      style={{ width: size, height: size }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-none bg-foreground font-medium text-background',
        size >= 40 ? 'text-display' : 'text-ui',
        className,
      )}
    >
      {monogram(name)}
    </span>
  )
}

/** The name's first letter, uppercased; whole characters, never half a pair. */
export function monogram(name: string): string {
  return (Array.from(name.trim()).at(0) ?? '').toUpperCase()
}
