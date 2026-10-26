import { Lock } from 'lucide-react'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'

/**
 * The ink stamp: what the page is, the kind alone in mono caps on a plain
 * ink rectangle — `COMPANY`, `SPACE`. One per page, on its own row above the
 * title; `RecordHeader` takes exactly one.
 * - `sensitive` appends a lock and `SENSITIVE`.
 * - `archived` is the outline: 1px ink on paper, `ARCHIVED` and the day.
 */
export type StampProps =
  | {
      /** The kind of thing — `Company`, an object's singular, `Space`. */
      kind: string
      state?: 'sensitive' | undefined
    }
  | {
      kind: string
      state: 'archived'
      /** ISO date or timestamp the thing was archived. */
      archivedOn: string
    }

/** A space's stamp: `SPACE`, outlined with the day once archived. */
export function spaceStamp(archivedOn: string | null = null): StampProps {
  return archivedOn === null
    ? { kind: 'Space' }
    : { kind: 'Space', state: 'archived', archivedOn }
}

export function Stamp(props: StampProps) {
  const { today } = useClock()
  if (props.state === 'archived') {
    return (
      <span data-stamp="archived" className="stamp stamp-outline">
        Archived
        <span className="normal-case">
          {formatDay(props.archivedOn, today)}
        </span>
      </span>
    )
  }
  return (
    <span
      data-stamp={props.state === 'sensitive' ? 'sensitive' : 'live'}
      className="stamp"
    >
      {props.kind}
      {props.state === 'sensitive' ? (
        <>
          <Lock aria-hidden className="size-3" strokeWidth={2} />
          Sensitive
        </>
      ) : null}
    </span>
  )
}
