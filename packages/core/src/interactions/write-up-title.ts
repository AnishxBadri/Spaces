import type { InteractionKind } from '@spaces/db/schema/interactions'

/**
 * The instant in a write-up's fallback title, `MM-DD HH:MM` in the
 * process's clock.
 * - The title is stored, so this form stays as titles already carry it;
 *   never use it for a printed date — that is `formatWhen`.
 */
export function titleStamp(iso: string): string {
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
    : `${KIND_LABEL[kind]} · ${titleStamp(occurredAt.toISOString())}`
}
