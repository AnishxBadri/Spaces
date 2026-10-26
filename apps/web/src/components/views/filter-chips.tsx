import { formatDay } from '@spaces/core/format'
import { OP_LABELS, isUnary } from '@spaces/core/views/filter'
import type { Condition } from '@spaces/core/views/filter'
import { useClock } from '#/components/clock'
import { optionLabel, refName } from '#/components/attributes/value-editor'
import type {
  RefNames,
  RegistryEntry,
} from '#/components/attributes/value-editor'

const OPTION_TYPES = new Set(['select', 'status', 'multi_select'])
const REF_TYPES = new Set(['record_reference', 'actor_reference'])

/**
 * A condition in words, as its chip reads: `Stage is` and `Seed`. A unary
 * condition (`Domain is empty`) has no value half; one still being written
 * reads `—`.
 */
export function conditionWords(
  def: RegistryEntry | undefined,
  c: Condition,
  opts: { refNames?: RefNames | undefined; today: string },
): { subject: string; value: string | null } {
  const subject = `${def?.name ?? c.slug} ${OP_LABELS[c.op]}`
  if (isUnary(c.op)) return { subject, value: null }
  const v = c.value
  if (v === undefined || v === null || v === '') return { subject, value: '—' }
  const one = (x: string | number | boolean): string => {
    if (typeof x === 'boolean') return x ? 'Yes' : 'No'
    if (def === undefined) return String(x)
    if (OPTION_TYPES.has(def.type)) return optionLabel(def, x)
    if (REF_TYPES.has(def.type) && typeof x === 'string')
      return refName(opts.refNames, x)
    if (def.type === 'date' && typeof x === 'string')
      return formatDay(x, opts.today) || x
    return String(x)
  }
  return {
    subject,
    value: Array.isArray(v) ? v.map(one).join(', ') : one(v),
  }
}

/**
 * The 36px row under a list's view bar while its filter holds conditions:
 * one chip per condition — `<Attribute> is` in graphite, the value in ink,
 * then × — then `Add condition`, and `Clear` at the right. A chip opens the
 * Filter popover; its × drops that condition alone.
 */
export function FilterChips({
  registry,
  conditions,
  refNames,
  onChange,
  onAdd,
  onEdit,
}: {
  registry: ReadonlyArray<RegistryEntry>
  conditions: ReadonlyArray<Condition>
  refNames?: RefNames | undefined
  onChange: (next: Array<Condition>) => void
  /** Opens the Filter popover on its attribute picker. */
  onAdd: () => void
  /** Opens the Filter popover on the conditions. */
  onEdit: () => void
}) {
  const { today } = useClock()
  const bySlug = new Map(registry.map((d) => [d.slug, d]))
  return (
    <div
      data-filter-chips
      role="group"
      aria-label="Filter conditions"
      className="flex h-9 items-center gap-2 border-b border-rule bg-paper px-3"
    >
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {conditions.map((c, i) => {
          const words = conditionWords(bySlug.get(c.slug), c, {
            refNames,
            today,
          })
          const name =
            words.value === null
              ? words.subject
              : `${words.subject} ${words.value}`
          return (
            <span
              key={`${String(i)}:${c.slug}`}
              data-filter-chip
              className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-rule bg-paper px-2 transition-colors duration-150 ease-out-quart has-[[data-chip-remove]:hover]:border-foreground"
            >
              <button
                type="button"
                onClick={onEdit}
                className="focus-ring flex items-center gap-1 rounded-md text-label whitespace-nowrap"
              >
                <span className="text-graphite">{words.subject}</span>
                {words.value === null ? null : (
                  <span className="font-medium text-foreground">
                    {words.value}
                  </span>
                )}
              </button>
              <button
                type="button"
                data-chip-remove
                aria-label={`Remove ${name}`}
                onClick={() => onChange(conditions.filter((_, j) => j !== i))}
                className="focus-ring flex size-4 items-center justify-center rounded-md text-label text-graphite transition-colors duration-150 ease-out-quart hover:bg-bone hover:text-foreground"
              >
                ×
              </button>
            </span>
          )
        })}
        <button
          type="button"
          onClick={onAdd}
          className="focus-ring shrink-0 rounded-md px-1 mono text-micro text-primary"
        >
          Add condition
        </button>
      </div>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => onChange([])}
        className="focus-ring shrink-0 rounded-md text-label text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground"
      >
        Clear
      </button>
    </div>
  )
}
