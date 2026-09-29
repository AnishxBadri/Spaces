import { Effect, Schema } from 'effect'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import { chunk } from '@spaces/db/schema'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityRead,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * `stampSensitivity(entityId)` — **the one writer of `chunk.sensitive`**
 * (SPA-121; the column comment in `packages/db/src/schema/kinds.ts` names
 * this file). The column is a derived cache of the resolver so retrieval can
 * filter inside SQL before scoring (docs/spec-ai-substrate.md §9); this
 * resolves the entity live through `sensitivityFor` — record → filed spaces
 * and their ancestors → binding → workspace default, so an unfiled document
 * resolves the default rather than throwing — and writes the answer onto
 * every chunk the entity owns, whatever its `source_kind`.
 *
 * Two callers: the embed job (`apps/worker/src/jobs/embed-document.ts`), which
 * stamps the chunks it has just written, and storage-18, which will restamp
 * when a binding's sensitivity or a record's filing changes. Nothing else
 * may set the column; an insert leaves it at its default and this corrects
 * it in the same transaction.
 *
 * `within` is that transaction's other half: a write that must commit
 * together with the stamp, run first. The embed job hands its
 * delete-and-insert of the document's chunks here, so no reader ever sees a
 * sensitive document's fresh chunks unstamped.
 *
 * The routing boundary never reads what this writes — `complete()` and
 * `embed()` resolve live, because a stale cache where bytes leave the box is
 * a leak. This column only ever narrows retrieval.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export class StampWriteFailed extends Schema.TaggedError<StampWriteFailed>()(
  'StampWriteFailed',
  { cause: Schema.Defect() },
) {}

export type StampOptions = {
  /** Committed in the same transaction as the stamp, before it. */
  within?: (tx: Tx) => Promise<void>
}

export type StampResult = SensitivityRead & {
  /** Rows whose flag this call changed. */
  stamped: number
}

export const stampSensitivity = Effect.fn('stampSensitivity')(function* (
  entityId: string,
  opts: StampOptions = {},
): Effect.fn.Return<
  StampResult,
  SensitivityReadFailed | SensitivityEntityNotFound | StampWriteFailed
> {
  const resolved = yield* sensitivityFor(entityId)
  const sensitive = resolved.sensitivity === 'sensitive'
  const stamped = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        if (opts.within) await opts.within(tx)
        const rows = await tx
          .update(chunk)
          .set({ sensitive })
          .where(
            and(eq(chunk.entityId, entityId), ne(chunk.sensitive, sensitive)),
          )
          .returning({ id: chunk.id })
        return rows.length
      }),
    catch: (cause) => new StampWriteFailed({ cause }),
  })
  return { ...resolved, stamped }
})
