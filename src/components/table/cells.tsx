import { createLink } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import type { AnchorHTMLAttributes, ReactNode, Ref } from 'react'
import { formatDate } from '#/lib/format'
import { cn } from '#/lib/utils'

/**
 * Shared cell renderers. Every table surface draws the same four shapes — a
 * record link, a chip link, a metadata line, a date — so they live here rather
 * than being retyped per route with slightly different sizes each time.
 *
 * The link cells go through `createLink` rather than wrapping `<Link>` in a
 * component with hand-written props: anything that restates `to`/`params` in
 * its own type erases the router's route inference, and a mistyped route param
 * stops being a compile error.
 */

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  ref?: Ref<HTMLAnchorElement>
}

/** The row's identity cell: badge + name, navigating to the record. */
export const RecordLinkCell = createLink(function RecordLinkAnchor({
  name,
  badge,
  className,
  ...props
}: AnchorProps & { name: string; badge?: ReactNode }) {
  return (
    <a
      {...props}
      className={cn(
        'focus-ring-inset flex h-full min-w-0 items-center gap-2 px-1 font-medium hover:underline',
        className,
      )}
    >
      {badge}
      <span className="truncate">{name}</span>
    </a>
  )
})

/** Square icon badge — companies, deals, anything with a mark rather than a face. */
export function IconBadge({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-[1.125rem] shrink-0 items-center justify-center border border-hairline bg-paper">
      <Icon className="size-2.5 text-foreground" strokeWidth={1.75} />
    </span>
  )
}

/** Round initial badge — people. */
export function InitialBadge({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-[1.125rem] shrink-0 items-center justify-center bg-foreground mono text-[0.5625rem] font-medium text-background"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

/** A related record rendered as a pill — spaces, a person's company. */
export const ChipLink = createLink(function ChipAnchor({
  icon: Icon,
  label,
  className,
  ...props
}: AnchorProps & { icon: LucideIcon; label: string }) {
  return (
    <a
      {...props}
      className={cn(
        'focus-ring flex min-w-0 items-center gap-1 border border-rule bg-paper px-1.5 py-0.5 text-label font-medium transition-colors duration-150 ease-out-quart hover:border-hairline',
        className,
      )}
    >
      <Icon className="size-2.5 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{label}</span>
    </a>
  )
})

/** Secondary identity data — domains, emails. Icon + one truncated line. */
export function MetaCell({
  icon: Icon,
  children,
}: {
  icon: LucideIcon
  children: ReactNode
}) {
  return (
    <span className="flex items-center gap-1.5 truncate px-1 text-graphite">
      <Icon className="size-3 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * A date in a column. `.numeric` carries both halves of the Tabular Rule —
 * tabular figures and right alignment — so the two cannot be applied apart.
 */
export function DateCell({
  value,
  className,
}: {
  value: string | Date | null | undefined
  className?: string
}) {
  const text = formatDate(value)
  if (!text) return null
  return (
    <span className={cn('block px-1 numeric text-graphite', className)}>
      {text}
    </span>
  )
}
