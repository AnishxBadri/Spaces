import { Effect, Schema } from 'effect'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { excerpt } from '@spaces/core/context/excerpt'
import { QUEUES } from '@spaces/core/queue/names'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import {
  document,
  documentRevision,
  entity,
  entitySpace,
  jobRun,
  link,
  storageBinding,
} from '@spaces/db/schema'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import {
  remoteAttachmentSql,
  remoteBytesSql,
} from '#/lib/arrival/mail-attachments'
import {
  documentFilingEdgesProgram,
  documentProvenanceProgram,
} from '#/lib/server/shared'
import { serverQuery } from '#/lib/server/query'
import { attachmentEmailsProgram } from './attachment-emails'
import { documentsQuery } from './query'

/**
 * The columns of one Files-tab row, as a record's list and a file's own
 * window read them.
 */
const documentRowFields = {
  id: document.entityId,
  filename: document.filename,
  mime: document.mime,
  sizeBytes: document.sizeBytes,
  kind: document.kind,
  extractionStatus: document.extractionStatus,
  extractionError: document.extractionError,
  createdAt: document.createdAt,
  uploadedBy: document.uploadedBy,
  // Whether there are bytes at all. Null on a clipped
  // article — the page was read, never stored — and the row's controls
  // read it: a download that cannot exist is offered as "Open source"
  // instead, rather than as a button that throws when pressed.
  blobSha: document.blobSha,
  // The clip's own address, and the one column that tells a
  // saved article from a file: the row's pending state reads
  // "fetching…" rather than "extracting text…" when it is set.
  url: document.url,
  // The storage-source half of the row: where the provider's copy can
  // be opened, and whether it is still there. Both null on every
  // document until a storage-source plugin files one, and the row
  // renders nothing extra when they are.
  externalUrl: document.externalUrl,
  externalStatus: document.externalStatus,
  // The provider's own folder path, verbatim: the row's "from …" line.
  sourcePath: document.sourcePath,
  // The binding whose sync filed it: the Files tab puts it in that
  // folder's band. Null for everything else.
  bindingId: document.bindingId,
  // Follow is offered on a file a storage connection brought: it has a
  // provider id and a connection to poll with. A mailbox's attachment
  // has both, and nothing to follow.
  followable: sql<boolean>`${document.connectionId} is not null and ${document.externalId} is not null and not ${remoteAttachmentSql}`,
  // An email attachment whose file stays in the mailbox.
  remoteBytes: remoteBytesSql,
  // The folded `From email` band: such an attachment nobody filed by
  // hand. A person's edge carries `created_by`; the filing on the
  // participants' records does not.
  fromEmail: sql<boolean>`(${remoteAttachmentSql} and not exists (select 1 from ${link} hand where hand.from_entity_id = ${document.entityId} and hand.relation = 'tagged_in' and hand.created_by is not null) and not exists (select 1 from ${entitySpace} hand where hand.entity_id = ${document.entityId} and hand.created_by is not null))`,
  // The provider's file id, for the revision ledger's foot.
  externalId: document.externalId,
  // A followed file's binding: null on every other row.
  followStatus: storageBinding.status,
  followSyncedAt: storageBinding.lastSyncedAt,
  priorRevisions: sql<number>`(select count(*)::int from ${documentRevision} where ${documentRevision.documentId} = ${document.entityId})`,
  // ISO from `to_json`, since a raw timestamp in `sql` is not decoded.
  revisedAt: sql<
    string | null
  >`(select to_json(max(${documentRevision.at})) #>> '{}' from ${documentRevision} where ${documentRevision.documentId} = ${document.entityId})`,
  // Enough text to prove extraction worked, without hauling a
  // 2MB column into every Files-tab render.
  snippet: sql<string | null>`left(${document.extractedText}, 200)`,
}

/**
 * The documents filed on one record, as its Files tab lists them, newest
 * first. A document private to someone else is not listed.
 */
export const recordDocumentRowsProgram = Effect.fn('recordDocumentRows')(
  function* (viewerId: string, entityId: string) {
    return yield* documentsQuery(() =>
      db
        .select(documentRowFields)
        .from(link)
        .innerJoin(document, eq(document.entityId, link.fromEntityId))
        .innerJoin(entity, eq(entity.id, document.entityId))
        .leftJoin(
          storageBinding,
          and(
            eq(storageBinding.id, document.bindingId),
            eq(storageBinding.grain, 'file'),
          ),
        )
        .where(
          and(
            eq(link.toEntityId, entityId),
            eq(link.relation, 'tagged_in'),
            isNull(entity.mergedIntoId),
            // A document private to someone else is not listed.
            canReadDocumentSql(viewerId),
          ),
        )
        .orderBy(desc(document.createdAt)),
    )
  },
)

/** {@link recordDocumentRowsProgram}, for a caller that is not a program. */
export const recordDocumentRows = (viewerId: string, entityId: string) =>
  Effect.runPromise(recordDocumentRowsProgram(viewerId, entityId))

/** A listed document with no provenance row: a bug, and it says so. */
class DocumentProvenanceMissing extends Schema.TaggedError<DocumentProvenanceMissing>()(
  'DocumentProvenanceMissing',
  { message: Schema.String },
) {}

/** One row as `recordDocumentRowsProgram` and `documentRowProgram` read it. */
export type DocumentRow = Awaited<ReturnType<typeof recordDocumentRows>>[number]

/**
 * Rows as the Files tab and the file window show them: who filed each, every
 * place it is filed, its last read, what replaced it, the email it came on.
 * `recordFollows` is whether the record behind them takes a followed file.
 */
export const describeDocumentRowsProgram = Effect.fn(
  'describeDocumentRowsProgram',
)(function* (
  userId: string,
  rows: ReadonlyArray<DocumentRow>,
  recordFollows: boolean,
) {
  if (rows.length === 0) return []
  // A readable attaching email names the file: `via <subject>`.
  const attached = yield* attachmentEmailsProgram(
    { id: userId },
    rows.map((r) => r.id),
  )
  const users = yield* serverQuery(() =>
    db.select({ id: user.id, name: user.name }).from(user),
  )
  const names = new Map(users.map((x) => [x.id, x.name]))

  // Who filed it. "integration" names no integration, so the ref is
  // resolved to the capability id here, server side, once.
  const provenance = yield* documentProvenanceProgram(rows.map((r) => r.id))

  // Every edge each document is filed by, not just this record's. The
  // filing control renders both kinds as chips, and a per-row fetch would
  // open one request per file to draw a popover nobody has clicked.
  const filings = yield* documentFilingEdgesProgram(rows.map((r) => r.id))

  // The last extraction attempt per document: `job_run` says what the
  // worker did (attempt, duration, how long ago). `distinct on` sorted by
  // started_at desc is the last row per entity, the shape the
  // (entity_id, started_at) index serves.
  const lastRuns = yield* serverQuery(() =>
    db
      .selectDistinctOn([jobRun.entityId], {
        entityId: jobRun.entityId,
        status: jobRun.status,
        attempt: jobRun.attempt,
        durationMs: jobRun.durationMs,
        startedAt: jobRun.startedAt,
        finishedAt: jobRun.finishedAt,
      })
      .from(jobRun)
      .where(
        and(
          eq(jobRun.queue, QUEUES.extractDocument),
          inArray(
            jobRun.entityId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(jobRun.entityId, desc(jobRun.startedAt)),
  )

  // `sinceMs` is computed here rather than in the component on purpose: a
  // relative time read off the browser's clock renders one string on the
  // server and another during hydration, which is a mismatch.
  const now = Date.now()
  const runs = new Map(
    lastRuns.map((r) => [
      r.entityId,
      {
        status: r.status,
        attempt: r.attempt,
        durationMs: r.durationMs,
        sinceMs: now - (r.finishedAt ?? r.startedAt).getTime(),
      },
    ]),
  )

  // The newest document that supersedes each row: the older row reads
  // "Replaced by → <name>", dimmed. Nothing else changes about it.
  const replacements = yield* serverQuery(() =>
    db
      .selectDistinctOn([link.toEntityId], {
        olderId: link.toEntityId,
        id: document.entityId,
        name: document.filename,
      })
      .from(link)
      .innerJoin(document, eq(document.entityId, link.fromEntityId))
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(
          eq(link.relation, 'supersedes'),
          inArray(
            link.toEntityId,
            rows.map((r) => r.id),
          ),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(link.toEntityId, desc(link.createdAt)),
  )
  const replacedBy = new Map(
    replacements.map((r) => [
      r.olderId,
      { id: r.id, name: r.name ?? 'Untitled file' },
    ]),
  )

  const out = []
  for (const row of rows) {
    // Never default to `'manual'`: that would invent a provenance. The id
    // came out of `document` above, so a miss is a bug, and it says so.
    const source = provenance.get(row.id)
    if (!source)
      return yield* new DocumentProvenanceMissing({
        message: `No provenance row for document ${row.id}`,
      })
    const {
      followable,
      followStatus,
      followSyncedAt,
      priorRevisions,
      revisedAt,
      ...r
    } = row
    out.push({
      ...r,
      /** A followed file's binding; null for a file never followed. */
      follow:
        followStatus === null
          ? null
          : {
              status: followStatus,
              lastSyncedAt:
                followSyncedAt === null ? null : followSyncedAt.toISOString(),
              revisions: priorRevisions + 1,
              revisedAt:
                revisedAt === null ? null : new Date(revisedAt).toISOString(),
            },
      /**
       * Whether the row's `···` offers Follow: a file a connection brought
       * and no folder binding holds, not gone, not followed right now.
       */
      canFollow:
        recordFollows &&
        followable &&
        r.externalStatus !== 'gone' &&
        (r.bindingId === null || followStatus === 'paused'),
      filename: r.filename ?? 'Untitled file',
      createdAt: r.createdAt.toISOString(),
      uploadedByName: r.uploadedBy ? (names.get(r.uploadedBy) ?? null) : null,
      snippet: excerpt(r.snippet ?? '') || null,
      lastRun: runs.get(r.id) ?? null,
      sourceClass: source.sourceClass,
      sourceCapability: source.sourceCapability,
      filedIn: filings.get(r.id) ?? [],
      replacedBy: replacedBy.get(r.id) ?? null,
      /** The readable email it came attached to: `via <subject>`. */
      email: attached.get(r.id) ?? null,
    })
  }
  return out
})

/**
 * One document by id, in the row shape, or null when it is gone, merged
 * away or private to someone else: the three answer alike.
 */
export const documentRowProgram = Effect.fn('documentRow')(function* (
  viewerId: string,
  documentId: string,
) {
  const rows = yield* documentsQuery(() =>
    db
      .select(documentRowFields)
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .leftJoin(
        storageBinding,
        and(
          eq(storageBinding.id, document.bindingId),
          eq(storageBinding.grain, 'file'),
        ),
      )
      .where(
        and(
          eq(document.entityId, documentId),
          isNull(entity.mergedIntoId),
          canReadDocumentSql(viewerId),
        ),
      ),
  )
  return rows.at(0) ?? null
})
