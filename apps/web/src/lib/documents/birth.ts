import { Effect, Schema } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  document,
  entity,
  entitySpace,
  link,
  pendingBlob,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'
import { documentFilingRefusal } from '#/lib/server/shared'
import type { DocumentKind } from '@spaces/core/documents'
import type { SourceClass } from '@spaces/db/schema'
import type { DocumentFilingTarget } from '#/lib/server/shared'

/**
 * **The birth of a document** — the one server path §3.1 promises all nine
 * entry points converge on: dedupe, then `entity` + `document` + the filing
 * edges + the activity line in one transaction, then enqueue extraction
 * outside it (SPA-113).
 *
 * Until this slice that sequence was inlined in `finalizeDocumentUpload` and
 * reachable only from a browser PUT, so entry points 2–9 each had a writer to
 * copy or a server fn to abuse. It is widened here **once**, for every caller
 * already queued rather than three times later:
 *
 * - `fileAgainst` is an **array** of targets — zero for an unfiled document
 *   (§11.6's inbox), one for a record or a space, N for a note filed in two
 *   spaces. N targets are N edges against **one** document row, which is
 *   §3.4's "a document can be filed in N places" read literally.
 * - `blobSha` is **nullable**: a URL clip keeps a readability snapshot and no
 *   bytes, and a row with no blob is still a row.
 * - the actor is **nullable**: a plugin files as an integration, not as a
 *   person, and `activity.actor_id` / `document.uploaded_by` are user columns.
 *   The integration is named by `sourceRef`, which is the FK the
 *   `document_source_ref_invariant` check enforces.
 * - `provenance` is one bag — `source_path`, `external_id`, `external_url`,
 *   `connection_id` (SPA-78) — so a storage source files through the same
 *   call a person does.
 *
 * **This is not a byte path.** Birth never reads or writes bytes. The browser
 * lane PUT them before it is called (`lib/documents/upload.ts`); the server
 * lane hashes and stores them before it is called. What arrives here is a
 * digest, or nothing.
 *
 * It lives in `lib/documents/` and **not** in `lib/server/`: the server-fns
 * barrel re-exports `lib/server/*` wholesale to the client and a plain export
 * there ships to the browser (CLAUDE.md → Traps, SPA-155), while a test has
 * to be able to call this without a request. `lib/documents/refile.ts` and
 * `lib/documents/space-sources.ts` are the same arrangement. It is never
 * re-exported from `src/lib/server-fns.ts`; the server fn reaches it through
 * a dynamic import inside the handler, the way `lib/server/objects.ts`
 * reaches `effectFn`.
 */

/**
 * Where the provider's copy lives, for the entry points that have one
 * (spec §11 delta 1). Every field is optional because five of the nine entry
 * points have nothing to say about any of them — a person dropping a deck on
 * a Files tab is not a connection.
 */
export type DocumentProvenance = {
  /** The provider's own tree, verbatim (§5.3) — a label, never a key. */
  sourcePath?: string | null
  /** The provider's id for the file — the idempotency key of a sync (§6, §8). */
  externalId?: string | null
  /** The provider's own link, rendered as "Open in source". */
  externalUrl?: string | null
  /** Whose account it came through. */
  connectionId?: string | null
}

/**
 * Who filed it. A person is `{ userId }`; a plugin filing through the SDK is
 * `{ integrationId }` and writes **null** into every user column, because
 * `activity.actor_id`, `entity.created_by`, `document.uploaded_by` and
 * `entity_space.created_by` all reference `user.id` and an integration is not
 * one. Which integration is `sourceRef`'s job, not this field's — it is the
 * column the biconditional check constrains. `null` is a backfill or an
 * import with no attributable actor at all.
 */
export type DocumentActor =
  { userId: string } | { integrationId: string } | null

export type DocumentBirthInput = {
  /** Null for a document whose bytes we do not keep — see the enqueue note. */
  blobSha: string | null
  filename: string
  /**
   * The page this row **is**, for the one entry point that keeps no bytes:
   * §3.1's URL clip writes the article's address here and `blobSha` null
   * (SPA-117). It is not `provenance.externalUrl` — that column is the
   * provider's copy of a file we also hold, rendered as "Open in source"
   * (docsurf-11), and a clip has no provider and no second copy. Optional
   * because eight of the nine entry points have no URL at all.
   */
  url?: string | null
  mime: string | null
  sizeBytes: number | null
  kind: DocumentKind
  /**
   * The eight-value class, never a vendor (D1, SPA-137). `manual` for a
   * person in a surface we ship, `integration` plus a `sourceRef` for a
   * connector.
   */
  sourceClass: SourceClass
  /** `integration.id`, non-null **iff** `sourceClass` is `integration`. */
  sourceRef: string | null
  provenance: DocumentProvenance
  /** Zero, one or N places. Zero is an unfiled document, not an error. */
  fileAgainst: Array<DocumentFilingTarget>
  actor: DocumentActor
}

/** The target will not take this filing — carries the sentence, not a code. */
export class DocumentBirthRejected extends Schema.TaggedError<DocumentBirthRejected>()(
  'DocumentBirthRejected',
  { reason: Schema.String },
) {}

export class DocumentBirthFailed extends Schema.TaggedError<DocumentBirthFailed>()(
  'DocumentBirthFailed',
  { cause: Schema.Defect() },
) {}

export type DocumentBirthFailure = DocumentBirthRejected | DocumentBirthFailed

/**
 * The sentence the client is shown. `Effect.runPromise` rejects with the
 * tagged error itself and a `Schema.TaggedError` carries no `message`, so a
 * refusal allowed to reach the upload toast as-is arrives empty — the rule
 * `ledgerVoidMessage` set and `documentRefileMessage` repeats.
 */
export function documentBirthMessage(failure: unknown): string {
  if (failure instanceof DocumentBirthRejected) return failure.reason
  return 'Could not file this document'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DocumentBirthFailed({ cause }),
  })

/** The user columns, or null when an integration filed it. */
function actorUserId(actor: DocumentActor): string | null {
  return actor !== null && 'userId' in actor ? actor.userId : null
}

/**
 * Every target must exist, must be live, and must agree with the mechanism
 * the caller named — checked **before** the dedupe read, because a mismatched
 * target would otherwise dedupe against the wrong edge table and answer
 * `{ deduped: true }` for a filing that could never exist.
 *
 * One read for the whole array rather than one per target: N targets is the
 * ordinary case now, not the exceptional one.
 */
const checkTargets = Effect.fn('birth.checkTargets')(function* (
  targets: Array<DocumentFilingTarget>,
): Effect.fn.Return<void, DocumentBirthFailure> {
  if (targets.length === 0) return
  const ids = [...new Set(targets.map((t) => t.entityId))]
  const rows = yield* query(() =>
    db
      .select({
        id: entity.id,
        kind: entity.kind,
        name: entity.canonicalName,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(entity)
      .where(inArray(entity.id, ids)),
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const target of targets) {
    const row = byId.get(target.entityId)
    if (!row)
      return yield* new DocumentBirthRejected({ reason: 'Record not found' })
    if (row.mergedIntoId !== null)
      return yield* new DocumentBirthRejected({
        reason: `“${row.name}” was merged into another record — file the document against that one.`,
      })
    const refusal = documentFilingRefusal(target, row.kind)
    if (refusal !== null)
      return yield* new DocumentBirthRejected({ reason: refusal })
  }
})

/**
 * §3.4's rule, per target: same bytes already filed at a requested target is
 * one row, not two. The read answers the **first** such document row — a
 * second drop is almost always a double-click — and the caller then adds
 * whichever of the requested edges that row is missing.
 *
 * Two queries because the two mechanisms are two tables: a record files
 * through `link(tagged_in)`, a space through `entity_space`, and a guard
 * keyed on `link` alone could never dedupe a space filing.
 *
 * Null when there is nothing to dedupe *against*: an empty target array (see
 * the program) or a blobless document, which has no content address for the
 * rule to compare.
 */
const existingFiling = Effect.fn('birth.existingFiling')(function* (
  blobSha: string | null,
  targets: Array<DocumentFilingTarget>,
): Effect.fn.Return<string | null, DocumentBirthFailure> {
  if (blobSha === null || targets.length === 0) return null
  const records = targets.flatMap((t) =>
    t.kind === 'record' ? [t.entityId] : [],
  )
  const spaces = targets.flatMap((t) =>
    t.kind === 'space' ? [t.entityId] : [],
  )

  const onRecords =
    records.length === 0
      ? []
      : yield* query(() =>
          db
            .select({ id: document.entityId, createdAt: document.createdAt })
            .from(document)
            .innerJoin(link, eq(link.fromEntityId, document.entityId))
            .where(
              and(
                eq(document.blobSha, blobSha),
                inArray(link.toEntityId, records),
                eq(link.relation, 'tagged_in'),
              ),
            ),
        )
  const inSpaces =
    spaces.length === 0
      ? []
      : yield* query(() =>
          db
            .select({ id: document.entityId, createdAt: document.createdAt })
            .from(document)
            .innerJoin(entitySpace, eq(entitySpace.entityId, document.entityId))
            .where(
              and(
                eq(document.blobSha, blobSha),
                inArray(entitySpace.spaceId, spaces),
              ),
            ),
        )

  // Oldest first, so a sha filed at two of the requested targets answers the
  // same row whichever order the targets arrived in.
  const hits = [...onRecords, ...inSpaces].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )
  return hits.at(0)?.id ?? null
})

/**
 * Add whatever edges this document does not already carry. Idempotence is the
 * database's, not a read's: `onConflictDoNothing` against `link_edge_unique`
 * and against `entity_space`'s composite primary key, the SPA-50 pattern, so
 * two drops racing produce one edge rather than one edge and one violation.
 */
async function addEdges(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  documentId: string,
  targets: Array<DocumentFilingTarget>,
  userId: string | null,
): Promise<void> {
  for (const target of targets) {
    if (target.kind === 'record') {
      // Attachment goes through `link` — document.entity_id is the
      // document's own identity, not the record it belongs to.
      await tx
        .insert(link)
        .values({
          fromEntityId: documentId,
          toEntityId: target.entityId,
          relation: 'tagged_in',
          source: 'manual',
          createdBy: userId,
        })
        .onConflictDoNothing()
    } else {
      // `source: 'manual'` and a `created_by`: a person put this file in this
      // space, the same provenance an AI-suggested tag carries with
      // `source: 'ai'` and a confidence.
      await tx
        .insert(entitySpace)
        .values({
          entityId: documentId,
          spaceId: target.entityId,
          source: 'manual',
          createdBy: userId,
        })
        .onConflictDoNothing()
    }
  }
}

/**
 * The arrival half of the orphan-blob sweep (SPA-54). `prepareDocumentUpload`
 * writes a `pending_blob` row for bytes it is about to be sent; the row's
 * only job is to make an upload that never finished findable, so the moment a
 * `document` row names the digest the intent is spent and the row goes.
 *
 * It is deleted **here**, inside birth's own transaction, and not in the
 * server fn that called it — birth is the one path every entry point
 * converges on (§3.1), so the server intake, the URL clip and the Drive sync
 * inherit the delete without knowing the table exists. In the transaction so
 * a rolled-back birth leaves the row behind: bytes with no document row are
 * exactly what the sweep is for.
 *
 * Only for a blob-bearing birth. A URL clip keeps no bytes, so there was
 * never a prepare and there is no row; a `delete … where sha is null` would
 * be a statement about nothing.
 */
async function clearPendingBlob(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  blobSha: string | null,
): Promise<void> {
  if (blobSha === null) return
  await tx.delete(pendingBlob).where(eq(pendingBlob.sha, blobSha))
}

/**
 * The whole birth, and the only writer of a `document` row outside tests and
 * seeds — asserted by `birth.test.ts`, which fails naming any second writer.
 */
export const birthDocumentProgram = Effect.fn('birthDocumentProgram')(
  function* (
    input: DocumentBirthInput,
  ): Effect.fn.Return<{ id: string; deduped: boolean }, DocumentBirthFailure> {
    const targets = input.fileAgainst
    yield* checkTargets(targets)

    // §3.4 is a rule about a *target*: "the same bytes already filed here".
    // An unfiled document has no target for it to apply to, so there is
    // nothing it could be the same filing as — every blobless drop and every
    // unfiled one inserts, and two unfiled copies of one deck are two rows in
    // the inbox rather than one row nobody filed twice.
    const existing = yield* existingFiling(input.blobSha, targets)
    if (existing !== null) {
      // Deduped, but the *other* requested targets may be new to this row —
      // one call filing against a record and a space, where only the record
      // already had it, must leave the space edge behind too.
      yield* query(() =>
        db.transaction(async (tx) => {
          await addEdges(tx, existing, targets, actorUserId(input.actor))
          // Deduped is still arrived: the digest is on a document row, so
          // the pending row has nothing left to describe. Skipping it here
          // would leave the sweep a row it can never act on (the reference
          // check says "kept") and never clear.
          await clearPendingBlob(tx, input.blobSha)
        }),
      )
      return { id: existing, deduped: true }
    }

    const userId = actorUserId(input.actor)
    const id = yield* query(() =>
      db.transaction(async (tx) => {
        const [ent] = await tx
          .insert(entity)
          .values({
            kind: 'document',
            canonicalName: input.filename,
            sourceClass: input.sourceClass,
            sourceRef: input.sourceRef,
            createdBy: userId,
          })
          .returning({ id: entity.id })

        await tx.insert(document).values({
          entityId: ent.id,
          blobSha: input.blobSha,
          filename: input.filename,
          url: input.url ?? null,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          kind: input.kind,
          sourceClass: input.sourceClass,
          sourceRef: input.sourceRef,
          sourcePath: input.provenance.sourcePath ?? null,
          externalId: input.provenance.externalId ?? null,
          externalUrl: input.provenance.externalUrl ?? null,
          connectionId: input.provenance.connectionId ?? null,
          uploadedBy: userId,
        })

        await addEdges(tx, ent.id, targets, userId)

        // The upload arrived. See `clearPendingBlob`.
        await clearPendingBlob(tx, input.blobSha)

        // `activity.subject_entity_id` is NOT NULL, so zero targets and N
        // targets both need a subject that is not "the one place this went".
        // The document's own entity id is that subject: one target reads on
        // the record's or the space's timeline exactly as it did before, and
        // an unfiled or multiply-filed document gets a stream of its own
        // rather than an arbitrary target promoted to stand for the rest.
        const only = targets.length === 1 ? targets.at(0) : undefined
        await tx.insert(activity).values({
          actorId: userId,
          verb: 'document.filed',
          subjectEntityId: only?.entityId ?? ent.id,
          objectEntityId: ent.id,
          meta: {
            filename: input.filename,
            kind: input.kind,
            targets: targets.length,
          },
        })

        return ent.id
      }),
    )

    // Outside the transaction: a queue that is down must not roll back a
    // perfectly good upload. The row stays 'pending' and can be re-queued.
    //
    // Skipped for a blobless document, because `extract-document` refuses a
    // null `blob_sha` as 'unsupported' — enqueueing one would spend a worker
    // attempt to write a failure, and never enqueueing leaves it 'pending'
    // forever. A caller that files bytes it does not store sets the row's own
    // `extraction_status` instead.
    if (input.blobSha !== null)
      yield* query(() => enqueue(QUEUES.extractDocument, { documentId: id }))

    return { id, deduped: false }
  },
)
