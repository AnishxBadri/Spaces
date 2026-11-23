import type { DraftRecipient } from '@spaces/db/schema/drafts'

/**
 * Who a new email started from a record goes to. Pure: the program reads
 * the record's people, their first email alias and when each was last
 * emailed (`interaction_stat`), and hands them here.
 * - On a person: that person, when they have an address.
 * - On a company, or a deal through its company: the person last emailed
 *   there. Nobody there ever emailed leaves To empty; a guess is worse
 *   than a blank the author fills.
 * - On anything else: empty.
 */

/** One person the prefill may pick. */
export type PrefillPerson = {
  entityId: string
  name: string
  /** Their first email alias; null when they have none. */
  email: string | null
  /** ISO instant of the last email with them; null when never. */
  lastEmailAt: string | null
}

export type PrefillRecord =
  | { kind: 'person'; person: PrefillPerson }
  | { kind: 'company' | 'deal'; team: ReadonlyArray<PrefillPerson> }
  | { kind: 'other' }

const chip = (p: PrefillPerson & { email: string }): DraftRecipient => ({
  email: p.email,
  entityId: p.entityId,
  name: p.name,
})

export function prefillTo(record: PrefillRecord): Array<DraftRecipient> {
  if (record.kind === 'other') return []
  if (record.kind === 'person') {
    const { person } = record
    return person.email === null
      ? []
      : [chip({ ...person, email: person.email })]
  }
  let last: (PrefillPerson & { email: string; lastEmailAt: string }) | null =
    null
  for (const p of record.team) {
    if (p.email === null || p.lastEmailAt === null) continue
    // ISO instants compare lexically; the first of a tie stays.
    if (last === null || p.lastEmailAt > last.lastEmailAt)
      last = { ...p, email: p.email, lastEmailAt: p.lastEmailAt }
  }
  return last === null ? [] : [chip(last)]
}
