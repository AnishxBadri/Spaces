import { cn } from '#/lib/utils'

/**
 * The segmented control: two or three mutually exclusive choices drawn as
 * one hairline box, the chosen one inked. Extracted from the attribute
 * dialog's local copy (2026-09-11) when the log-interaction dialog's
 * hand-rolled call/meeting switch and the note editor's Note · Memo ·
 * Scratch toggle became the second and third of the same shape.
 *
 * A radiogroup, not a row of toggle buttons: exactly one is chosen at all
 * times, which is what `role="radio"` + `aria-checked` says and what
 * `aria-pressed` does not.
 *
 * Generic over the option ids so a caller with a union type — a note kind,
 * an interaction kind — gets that union back in `onChange` instead of a
 * bare string it would have to narrow or assert.
 */
export type SegmentedOption<T extends string> = {
  id: T
  label: string
  /** The digit printed inside the segment — a key the page listens for. */
  hint?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  disabled,
  label,
  className,
}: {
  value: T
  options: Array<SegmentedOption<T>>
  onChange: (id: T) => void
  /** `sm` is the 26px chrome height; `md` the 32px control height. */
  size?: 'sm' | 'md'
  disabled?: boolean | undefined
  /** Names the group for screen readers when no visible label sits beside it. */
  label?: string | undefined
  className?: string | undefined
}) {
  const sm = size === 'sm'
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'flex w-fit items-center border border-hairline',
        sm ? 'h-7' : 'h-8',
        className,
      )}
    >
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabled}
          onClick={() => onChange(o.id)}
          className={cn(
            'focus-ring-inset flex h-full items-center gap-2 font-medium transition-colors duration-150 ease-out-quart disabled:opacity-60',
            sm ? 'px-3 text-label' : 'px-2.5 text-ui',
            i > 0 && 'border-l border-hairline',
            value === o.id
              ? 'bg-hairline text-paper'
              : 'text-graphite hover:bg-bone hover:text-foreground',
          )}
        >
          {o.label}
          {o.hint ? (
            <span className="mono text-micro font-normal opacity-70">
              {o.hint}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
