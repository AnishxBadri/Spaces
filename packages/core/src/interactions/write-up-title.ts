import type { InteractionKind } from '@spaces/db/schema/interactions'

/**
 * The ledger's time lane: `MM-DD HH:MM` in the reader's clock.
 * - One implementation for the timeline row and the write-up's fallback
 *   title, so both print an instant the same way.
 */
export function stamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const KIND_LABEL: Record<InteractionKind, string> = {
  email: 'Email',
  meeting: 'Meeting',
  call: 'Call',
}

/**
 * A write-up's name at birth: the subject, else the kind and the hour
 * (`Meeting · 09-18 10:00`) — a synced row may carry no subject, and
 * "Untitled" is a worse answer than saying what is known.
 */
export function writeUpTitle(
  kind: InteractionKind,
  subject: string | null,
  occurredAt: Date,
): string {
  const named = subject?.trim()
  return named
    ? named
    : `${KIND_LABEL[kind]} · ${stamp(occurredAt.toISOString())}`
}
