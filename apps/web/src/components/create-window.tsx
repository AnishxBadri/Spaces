import { Link } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  fieldSpanClass,
  ValueEditor,
} from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { Label } from '#/components/ui/label'
import { findByIdentity } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * The parts every create window shares: it asks only for identity, keeps
 * the rest behind `More fields ›`, and refuses a key another record already
 * holds, linking to that record instead.
 */

type Match = Awaited<ReturnType<typeof findByIdentity>>
type IdentityKey = 'domain' | 'email' | 'linkedin'

/** The key's name in the refusal: `already has this domain`. */
const KEY_WORD: Record<IdentityKey, string> = {
  domain: 'domain',
  email: 'email',
  linkedin: 'LinkedIn',
}

/**
 * Asks the server whether a typed key already names a record. `check`
 * answers the match (null for a blank or failed ask) and keeps it with the
 * key it was asked for; only the latest ask lands, so a slow answer for an
 * older value never overwrites a newer one.
 */
export function useIdentityCheck(defaultKey: IdentityKey) {
  const [held, setHeld] = useState<{ key: IdentityKey; match: Match } | null>(
    null,
  )
  const latest = useRef(0)
  async function check(
    value: string,
    key: IdentityKey = defaultKey,
  ): Promise<Match | null> {
    const ask = ++latest.current
    const typed = value.trim()
    if (typed === '') {
      setHeld(null)
      return null
    }
    try {
      const match = await findByIdentity({ data: { key, value: typed } })
      if (ask === latest.current) setHeld({ key, match })
      return match
    } catch {
      if (ask === latest.current) setHeld(null)
      return null
    }
  }
  function clear() {
    latest.current++
    setHeld(null)
  }
  return {
    check,
    clear,
    owner: held?.match.owner ?? null,
    key: held?.key ?? defaultKey,
  }
}

/** `<Name> already has this domain` and the way to that record. */
export function IdentityRefusal({
  owner,
  identityKey,
  className,
}: {
  owner: { name: string; path: string | null }
  identityKey: IdentityKey
  className?: string
}) {
  return (
    <p
      role="alert"
      data-identity-match
      className={cn('text-ui text-destructive', className)}
    >
      {owner.name} already has this {KEY_WORD[identityKey]}
      {owner.path === null ? null : (
        <>
          {' · '}
          <Link to={owner.path} className="focus-ring underline">
            Open {owner.name}
          </Link>
        </>
      )}
    </p>
  )
}

/**
 * The pine `More fields ›` that opens the rest of a create window in place.
 * It stays open once opened: closing would hide values already typed.
 */
export function MoreFields({
  open,
  onOpen,
  children,
}: {
  open: boolean
  onOpen: () => void
  children: ReactNode
}) {
  if (open) return <>{children}</>
  return (
    <button
      type="button"
      onClick={onOpen}
      className="focus-ring w-fit text-ui text-primary hover:underline sm:col-span-2"
    >
      More fields ›
    </button>
  )
}

/** One registry field in a create window, its value held by the window. */
export function RegistryField({
  def,
  value,
  onChange,
  refNames,
}: {
  def: RegistryEntry
  value: unknown
  onChange: (value: unknown) => void
  refNames?: Record<string, { name: string }>
}) {
  return (
    <div className={cn('space-y-1.5', fieldSpanClass(def))}>
      <Label>{def.name}</Label>
      <ValueEditor
        def={def}
        value={value ?? null}
        variant="field"
        {...(refNames === undefined ? {} : { refNames })}
        onSave={onChange}
      />
    </div>
  )
}

/**
 * Today on every blank date field of `defs`, for the moment the fields are
 * revealed: a create's dates default to the day it is made, and only what
 * the reader has been shown is written.
 */
export function withTodayDates(
  defs: ReadonlyArray<{ slug: string; type: string }>,
  values: Record<string, unknown>,
  today: string,
): Record<string, unknown> {
  const next = { ...values }
  for (const def of defs)
    if (def.type === 'date' && (next[def.slug] ?? null) === null)
      next[def.slug] = today
  return next
}

/** The values a create sends: the blanks dropped, the server fills defaults. */
export function filledValues(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== null && v !== undefined),
  )
}
