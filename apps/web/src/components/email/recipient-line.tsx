import { ChevronDown, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { addRecipient, looksLikeEmail } from '#/lib/email/compose'
import { searchEmailRecipients } from '#/lib/server-fns'
import type { DraftRecipient, RecipientMatch } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/** The address block's label lane: `TO`, `CC`, `BCC`, `SUBJECT`. */
const ADDRESS_LANE = 'w-16 shrink-0 field-label text-graphite'

/** One row of the address block: label, then what it holds, then its trail. */
export function AddressRow({
  label,
  htmlFor,
  trail,
  children,
}: {
  label: string
  htmlFor?: string
  trail?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-rule px-5 py-1.5">
      <label htmlFor={htmlFor} className={ADDRESS_LANE}>
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {children}
      </div>
      {trail}
    </div>
  )
}

/**
 * One recipient: the person's name and the alias chosen, or the bare
 * address. A person with two aliases picks among them from the chip; a new
 * address is dashed; a Bcc reads as hidden.
 */
function Chip({
  chip,
  aliases,
  blind,
  onPick,
  onRemove,
}: {
  chip: DraftRecipient
  aliases: ReadonlyArray<string>
  blind: boolean
  onPick: (email: string) => void
  onRemove: () => void
}) {
  const known = chip.entityId !== undefined
  return (
    <span
      data-chip={chip.email}
      className={cn(
        'flex h-6 items-center gap-1.5 border bg-paper px-2 text-ui',
        known ? 'border-rule' : 'border-dashed border-hairline',
      )}
    >
      {chip.name === undefined ? null : <span>{chip.name}</span>}
      {aliases.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Which address for ${chip.name ?? chip.email}`}
            className="focus-ring flex items-center gap-1 mono text-micro text-graphite hover:text-foreground"
          >
            {chip.email}
            <ChevronDown className="size-3" strokeWidth={1.75} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {aliases.map((email) => (
              <DropdownMenuItem key={email} onSelect={() => onPick(email)}>
                <span className="mono text-micro">{email}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span
          className={cn(
            'mono text-micro',
            chip.name === undefined ? 'text-foreground' : 'text-graphite',
          )}
        >
          {chip.email}
        </span>
      )}
      {known ? null : (
        <span className="mono text-micro text-graphite">new</span>
      )}
      {blind ? (
        <span className="mono text-micro text-graphite">hidden</span>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${chip.name ?? chip.email}`}
        onClick={onRemove}
        className="focus-ring text-graphite hover:text-foreground"
      >
        <X className="size-2.5" strokeWidth={2} />
      </button>
    </span>
  )
}

/**
 * A line of recipients: chips, then the search over people and their email
 * aliases. Enter or a comma takes the first match, else the typed address
 * as a new one; Backspace on an empty box takes the last chip back.
 */
export function RecipientLine({
  label,
  value,
  onChange,
  blind = false,
  autoFocus = false,
  trail,
}: {
  label: string
  value: ReadonlyArray<DraftRecipient>
  onChange: (next: Array<DraftRecipient>) => void
  /** The Bcc line: its chips read as hidden. */
  blind?: boolean
  autoFocus?: boolean
  trail?: ReactNode
}) {
  const inputId = useId()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Array<RecipientMatch>>([])
  // The aliases of each person chosen here, for the chip's pick.
  const [aliases, setAliases] = useState<Map<string, Array<string>>>(
    () => new Map(),
  )

  useEffect(() => {
    if (query.trim() === '') return setMatches([])
    let live = true
    const t = setTimeout(() => {
      searchEmailRecipients({ data: { q: query } })
        .then((rows) => {
          if (live) setMatches(rows)
        })
        .catch(() => {
          if (live) setMatches([])
        })
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query])

  function choose(match: RecipientMatch) {
    const email = match.emails.at(0)
    if (email === undefined) return
    setAliases((prev) => new Map(prev).set(match.entityId, match.emails))
    onChange(
      addRecipient(value, {
        email,
        entityId: match.entityId,
        name: match.name,
      }),
    )
    setQuery('')
    setMatches([])
  }

  function commit(): boolean {
    const first = matches.at(0)
    if (first !== undefined) {
      choose(first)
      return true
    }
    const typed = query.trim().replace(/[,;]$/, '')
    if (!looksLikeEmail(typed)) return false
    onChange(addRecipient(value, { email: typed }))
    setQuery('')
    return true
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'Enter' || e.key === ',') && !e.metaKey && !e.ctrlKey) {
      if (query.trim() === '') return
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && query === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <AddressRow label={label} htmlFor={inputId} trail={trail}>
      {value.map((chip, i) => (
        <Chip
          key={chip.email}
          chip={chip}
          blind={blind}
          aliases={
            chip.entityId === undefined
              ? []
              : (aliases.get(chip.entityId) ?? [])
          }
          onPick={(email) =>
            onChange(value.map((c, j) => (j === i ? { ...c, email } : c)))
          }
          onRemove={() => onChange(value.filter((_, j) => j !== i))}
        />
      ))}
      <span className="relative min-w-32 flex-1">
        <input
          id={inputId}
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (looksLikeEmail(query)) commit()
          }}
          aria-label={`${label} — search people or type an address`}
          className="h-6 w-full bg-transparent text-ui outline-none placeholder:text-graphite"
        />
        {matches.length > 0 ? (
          <ul
            role="listbox"
            aria-label="People"
            className="absolute top-full left-0 z-dropdown mt-1 w-80 border border-hairline bg-paper shadow-dither"
          >
            {matches.map((m) => (
              <li key={m.entityId} role="option" aria-selected={false}>
                <button
                  type="button"
                  // Keep focus in the box, so a pick does not blur-commit.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(m)}
                  className="focus-ring-inset flex h-8 w-full items-center gap-2.5 px-2.5 text-left text-ui hover:bg-bone"
                >
                  <span className="min-w-0 truncate">{m.name}</span>
                  <span className="ml-auto truncate mono text-micro text-graphite">
                    {m.emails.at(0)}
                    {m.emails.length > 1 ? ` +${m.emails.length - 1}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </span>
    </AddressRow>
  )
}
