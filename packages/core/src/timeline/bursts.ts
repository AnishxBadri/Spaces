import type { Json } from '@spaces/db/json'

/**
 * Read-time burst condensing for the record timeline (CONTEXT.md — history is
 * stored per attribute and condensed when read, never on write).
 *
 * This is a pure function and not a block inside the server fn because
 * nothing in this repo can test a server fn: `requireUser()` reads
 * `getRequest()`, so no test imports `lib/server/*`. The grouping key is the
 * part with a bug in it — it decides which changes the reader is told were
 * one act — so it is the part that has to be reachable from a test. The
 * server fn keeps the queries; this keeps the judgement.
 */

/**
 * What the condenser needs of an `attribute_event` row. Deliberately
 * structural: the caller passes drizzle rows straight through, and the
 * generic below carries their exact enum literals into the result instead of
 * this file restating the enums (which would then rot apart from the column).
 */
export type BurstEventRow = {
  attrSlug: string
  to: Json | null
  actorType: string
  actorId: string | null
  actorRef: string | null
  source: string
  at: Date
}

export type Burst<TRow extends BurstEventRow> = {
  type: 'attrs'
  actorType: TRow['actorType']
  /** The user id, for an `actor_type = 'user'` burst. */
  actor: string | null
  /** The integration id, for an `actor_type = 'integration'` burst. */
  actorRef: string | null
  source: TRow['source']
  at: string
  changes: Array<{ slug: string; to: TRow['to'] }>
}

/** Consecutive changes by one attender through one door fold into one entry. */
export const BURST_GAP_MS = 10 * 60 * 1000

/**
 * Fold a descending-by-`at` run of attribute events into bursts.
 *
 * The key is `(actorType, actorId, actorRef, source)`. `actorRef` is load
 * bearing and was the bug this function was extracted to fix: two different
 * integrations enriching the same record inside the gap share an actorType,
 * a null actorId and a source, so without it they folded into one burst that
 * claimed a single actor did work two of them did — a lie the reader has no
 * way to see through. A merge's rewrites are kept out of the person's edits
 * around them by the same key, via `source`.
 *
 * Events are expected newest-first, as the timeline query returns them; the
 * gap is measured from the burst's own timestamp back to the next event.
 */
export function condenseBursts<TRow extends BurstEventRow>(
  events: ReadonlyArray<TRow>,
  gapMs: number = BURST_GAP_MS,
): Array<Burst<TRow>> {
  const bursts: Array<Burst<TRow>> = []
  for (const ev of events) {
    const last = bursts.at(-1)
    if (
      last &&
      last.actorType === ev.actorType &&
      last.actor === (ev.actorId ?? null) &&
      last.actorRef === (ev.actorRef ?? null) &&
      last.source === ev.source &&
      new Date(last.at).getTime() - ev.at.getTime() < gapMs
    ) {
      last.changes.push({ slug: ev.attrSlug, to: ev.to })
    } else {
      bursts.push({
        type: 'attrs',
        actorType: ev.actorType,
        actor: ev.actorId ?? null,
        actorRef: ev.actorRef ?? null,
        source: ev.source,
        at: ev.at.toISOString(),
        changes: [{ slug: ev.attrSlug, to: ev.to }],
      })
    }
  }
  return bursts
}
