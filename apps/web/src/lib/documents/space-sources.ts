import { Effect, Schema } from 'effect'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, entitySpace } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'

/**
 * The documents filed **into** one space (SPA-44) — the space-page twin of
 * `listRecordDocuments`' lane, and the same row shape.
 *
 * Filing into a space is `entity_space`, never `link(tagged_in)`
 * (CONTEXT.md → Sources are documents; `DocumentFilingTarget` in
 * `lib/server/shared.ts`), which is why this cannot reuse the Files-tab
 * query: that one reads the edge a record filing writes, and a space
 * filing writes the other table entirely.
 *
 * It lives outside `lib/server/` on purpose. `lib/server/spaces.ts` is
 * reachable from the client barrel, and a plain export there ships to the
 * browser (CLAUDE.md → Traps, SPA-155); `lib/notes/filed.ts` is the same
 * arrangement for the space page's notes lane, and a test can call this
 * without a request.
 *
 * `entity.merged_into_id` is filtered in SQL, as everywhere else on this
 * page: a document merged away stops being a source of the space it was
 * filed into.
 */

export class SpaceSourcesFailed extends Schema.TaggedError<SpaceSourcesFailed>()(
  'SpaceSourcesFailed',
  { cause: Schema.Defect() },
) {}

export type SpaceSource = {
  id: string
  filename: string
  kind: (typeof document.$inferSelect)['kind']
  sizeBytes: number | null
  mime: string | null
  extractionStatus: (typeof document.$inferSelect)['extractionStatus']
  extractionError: string | null
  uploadedByName: string | null
  /** ISO 8601 — compared lexically, the repo convention for dates. */
  createdAt: string
  /**
   * How long ago it was filed, in ms, measured on the **server**. A relative
   * time read off the browser's clock renders one string during SSR and
   * another during hydration, which is a mismatch — the Files tab computes
   * its `sinceMs` here for exactly this reason.
   */
  sinceMs: number
  snippet: string | null
}

/**
 * Enough extracted text to prove the worker landed, and not a byte more:
 * the column runs to 2MB and nothing on a space page wants it. Same 200 as
 * the Files tab, for the same reason.
 */
const SNIPPET_CHARS = 200

export const spaceSourcesProgram = Effect.fn('spaceSourcesProgram')(function* (
  spaceId: string,
): Effect.fn.Return<Array<SpaceSource>, SpaceSourcesFailed> {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          id: document.entityId,
          filename: document.filename,
          kind: document.kind,
          sizeBytes: document.sizeBytes,
          mime: document.mime,
          extractionStatus: document.extractionStatus,
          extractionError: document.extractionError,
          createdAt: document.createdAt,
          uploadedByName: user.name,
          snippet: sql<
            string | null
          >`left(${document.extractedText}, ${SNIPPET_CHARS})`,
        })
        .from(entitySpace)
        .innerJoin(document, eq(document.entityId, entitySpace.entityId))
        .innerJoin(entity, eq(entity.id, document.entityId))
        // Left, not inner: `uploaded_by` is nullable, and a document a
        // connector filed with no user behind it must still be a source.
        .leftJoin(user, eq(user.id, document.uploadedBy))
        .where(
          and(eq(entitySpace.spaceId, spaceId), isNull(entity.mergedIntoId)),
        )
        .orderBy(desc(document.createdAt)),
    catch: (cause) => new SpaceSourcesFailed({ cause }),
  })

  const now = Date.now()
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename ?? 'Untitled file',
    kind: r.kind,
    sizeBytes: r.sizeBytes,
    mime: r.mime,
    extractionStatus: r.extractionStatus,
    extractionError: r.extractionError,
    uploadedByName: r.uploadedByName,
    createdAt: r.createdAt.toISOString(),
    sinceMs: now - r.createdAt.getTime(),
    snippet: r.snippet?.replace(/\s+/g, ' ').trim() || null,
  }))
})
