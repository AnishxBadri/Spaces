import { createLink } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import type { AnchorHTMLAttributes, ReactNode, Ref } from 'react'
import { readAiConfig } from '@spaces/core/ai/attribute-ai'
import { formatAge, formatDay } from '@spaces/core/format'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { useClock } from '#/components/clock'
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

/**
 * The row's identity cell: badge + name, navigating to the record; the name
 * underlines while its row is hovered.
 */
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
        'focus-ring-inset flex h-full min-w-0 items-center gap-2 px-1 font-medium group-hover:underline hover:underline',
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
      /* Optical sizing, not a type step: one initial centred in an 18px ink
         square. The named steps start at 10px (field) and overflow it. */
      // eslint-disable-next-line instrument/vocabulary
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

/**
 * A registry column's meta: figures and dates right-align their head over
 * the `numeric` cell the value editor draws for them.
 */
export function attributeColumnMeta(type: string): { numeric: boolean } {
  return {
    numeric: type === 'number' || type === 'currency' || type === 'date',
  }
}

/**
 * A registry column's meta on a record list: the figures alignment, and
 * the `AI` tag on the head of an attribute a model fills.
 */
export function registryColumnMeta(def: RegistryEntry): {
  numeric: boolean
  ai: boolean
} {
  return { ...attributeColumnMeta(def.type), ai: readAiConfig(def) !== null }
}

/**
 * A date in a column, mono: the day (`13 Oct`, `4 Oct 2024`), or with
 * `age` how long ago (`12d`) under 30 days — the stat-column form.
 * `.numeric` carries both halves of the Tabular Rule — tabular figures and
 * right alignment — so the two cannot be applied apart.
 */
export function DateCell({
  value,
  age = false,
  className,
}: {
  value: string | Date | null | undefined
  age?: boolean
  className?: string
}) {
  const { now, today } = useClock()
  if (!value) return null
  const text = age ? formatAge(value, now) : formatDay(value, today)
  if (!text) return null
  return (
    <span className={cn('block px-1 numeric mono text-graphite', className)}>
      {text}
    </span>
  )
}
