import { Effect } from 'effect'
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  chunk,
  document,
  entity,
  integration,
  interaction,
  link,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { parseAddresses } from '#/lib/arrival/forwarded'
import { documentFilingEdgesProgram } from '#/lib/server/shared'
import { attachmentEmailsProgram } from './attachment-emails'
import { inSyncedFolderSql, keptVersionsSql } from './deletable-sql'
import { namedInFileProgram, spaceTreeProgram } from './file-under'
import type { FileUnderOption } from './file-under'
import { firstLineOf } from './files-ledger-view'
import type { FilesTab } from './files-ledger-view'
import { documentsQuery } from './query'
import type { ShelfRecord } from './shelf'
import { unfiledPredicate } from './unfiled'

/**
 * The Files page's list: one row per file the reader may read, unfiled
 * first and then newest first, with what each row prints (its first line,
 * pages or words, where it is filed, where it came from, the guess an
 * unfiled row offers) and the tab counts.
 * - Outside the server-fn modules, whose plain exports ship to the browser.
 * - One params object, so a filter or an arrangement is a new field, not a
 *   new program.
 */

/** What the list is asked for. */
export type FilesLedgerParams = {
  /** Whose list: a file private to someone else is not on it. */
  readonly viewer: { readonly id: string; readonly email: string }
  /** The open folder tab. */
  readonly tab: FilesTab
  /**
   * How many rows to read from the top. `Load 50 more` raises it, so a
   * re-read after a filing redraws every row on screen, not only the first
   * page.
   */
  readonly limit: number
  /** Names and text; empty reads everything. */
  readonly q: string
}

/** Where a file came from, as its source lane says it. */
export type FilesSource =
  | {
      readonly via: 'email'
      /** The sender, or null when the reader sent it. */
      readonly from: string | null
      /** The mailbox it came through: `Gmail`. */
      readonly mailbox: string | null
    }
  | {
      readonly via: 'lane'
      /** The capability that brought it: `google-drive`. */
      readonly lane: string
      /** The provider's folder path, verbatim. */
      readonly path: string | null
    }
  | { readonly via: 'link'; readonly site: string }
  | {
      readonly via: 'upload'
      /** Who uploaded it, or null for the reader's own. */
      readonly by: string | null
    }

/** A space a file is filed under, with its ancestors' names, root first. */
export type FilesSpace = {
  readonly id: string
  readonly name: string
  readonly parents: ReadonlyArray<string>
}

export type FilesLedgerRow = {
  readonly id: string
  readonly filename: string
  readonly kind: (typeof document.$inferSelect)['kind']
  readonly mime: string | null
  readonly sizeBytes: number | null
  /** Null on a clipped page: there are no bytes to download. */
  readonly blobSha: string | null
  readonly url: string | null
  readonly externalUrl: string | null
  readonly extractionStatus: (typeof document.$inferSelect)['extractionStatus']
  readonly extractionError: string | null
  /** ISO 8601, compared lexically. */
  readonly createdAt: string
  /** Filed under nothing: the `Unfiled` band's. */
  readonly unfiled: boolean
  /** The first line of its text, from its first chunk; null before it is read. */
  readonly firstLine: string | null
  /** Its highest read page (a spreadsheet's sheet); null when none knows. */
  readonly pages: number | null
  /** Its words, counted only when it has no pages. */
  readonly words: number | null
  /** Its place on its replace chain (`v2`), or null for a file that stands alone. */
  readonly versionAt: number | null
  readonly records: ReadonlyArray<ShelfRecord>
  readonly spaces: ReadonlyArray<FilesSpace>
  readonly source: FilesSource
  /** An unfiled file's best guess, named in its own text; null for none. */
  readonly guess: FileUnderOption | null
  /** A file of its kind is filed under one of its records: `Newer version of…`. */
  readonly hasOlder: boolean
  /** The delete confirm's: what brought it and what it takes with it. */
  readonly sourceCapability: string | null
  readonly sourcePath: string | null
  readonly inSyncedFolder: boolean
  /** Its kept revisions and itself, which a delete takes with it. */
  readonly versions: number
}

export type FilesLedger = {
  readonly rows: ReadonlyArray<FilesLedgerRow>
  /** Every file the params match, for the foot's `50 of 214`. */
  readonly total: number
  /** How many of those are unfiled: the `Unfiled` band's count. */
  readonly unfiled: number
  /** Each tab's count, whatever the search. */
  readonly counts: Readonly<Record<FilesTab, number>>
}

/** `%` and `_` read literally in a search. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`

/** How much of the first chunk to read for its first line. */
const FIRST_TEXT_CHARS = 600

export const filesLedgerProgram = Effect.fn('filesLedger')(function* (
  params: FilesLedgerParams,
) {
  const { viewer, tab, limit } = params
  const q = params.q.trim()
  const unfiled = sql<boolean>`(${unfiledPredicate()})`
  const listed = [isNull(entity.mergedIntoId), canReadDocumentSql(viewer.id)]
  const matched = [
    ...listed,
    ...(tab === 'all' ? [] : [eq(document.kind, tab)]),
    ...(q === ''
      ? []
      : [
          or(
            ilike(document.filename, likePattern(q)),
            ilike(document.extractedText, likePattern(q)),
          ),
        ]),
  ]

  const byKind = yield* documentsQuery(() =>
    db
      .select({
        kind: document.kind,
        all: count(),
        unfiled: sql<number>`count(*) filter (where ${unfiled})`.mapWith(
          Number,
        ),
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(and(...listed))
      .groupBy(document.kind),
  )
  const sum = (t: FilesTab, of: (k: (typeof byKind)[number]) => number) =>
    byKind
      .filter((k) => t === 'all' || k.kind === t)
      .reduce((n, k) => n + of(k), 0)
  const all = (t: FilesTab) => sum(t, (k) => k.all)
  const counts: Record<FilesTab, number> = {
    all: all('all'),
    deck: all('deck'),
    cap_table: all('cap_table'),
    dd: all('dd'),
    legal: all('legal'),
    article: all('article'),
    other: all('other'),
  }
  const found =
    q === ''
      ? {
          total: counts[tab],
          unfiled: sum(tab, (k) => k.unfiled),
        }
      : ((yield* documentsQuery(() =>
          db
            .select({
              total: count(),
              unfiled: sql<number>`count(*) filter (where ${unfiled})`.mapWith(
                Number,
              ),
            })
            .from(document)
            .innerJoin(entity, eq(entity.id, document.entityId))
            .where(and(...matched)),
        )).at(0) ?? { total: 0, unfiled: 0 })

  // The per-row columns below are scalar subqueries over one row each; the
  // planner reads them after the sort and the limit, for the rows shown.
  const rows = yield* documentsQuery(() =>
    db
      .select({
        id: document.entityId,
        filename: document.filename,
        kind: document.kind,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        blobSha: document.blobSha,
        url: document.url,
        externalUrl: document.externalUrl,
        extractionStatus: document.extractionStatus,
        extractionError: document.extractionError,
        createdAt: document.createdAt,
        uploadedBy: document.uploadedBy,
        uploadedByName: user.name,
        sourceCapability: integration.capabilityId,
        sourcePath: document.sourcePath,
        unfiled,
        // The first chunk is the file's own text in reading order; a file
        // whose text is read but not yet cut falls back to its text.
        firstText: sql<
          string | null
        >`coalesce((select left(${chunk.text}, ${FIRST_TEXT_CHARS}) from ${chunk} where ${chunk.entityId} = ${document.entityId} and ${chunk.sourceKind} = 'document' order by ${chunk.idx} limit 1), left(${document.extractedText}, ${FIRST_TEXT_CHARS}))`,
        pages: sql<
          number | null
        >`(select max(${chunk.page}) from ${chunk} where ${chunk.entityId} = ${document.entityId} and ${chunk.sourceKind} = 'document')`,
        words: sql<
          number | null
        >`case when exists (select 1 from ${chunk} where ${chunk.entityId} = ${document.entityId} and ${chunk.sourceKind} = 'document' and ${chunk.page} is not null) then null else regexp_count(${document.extractedText}, '\\S+') end`,
        // Every file this one replaced, however far back; `union` stops a
        // cycle a bad link could make.
        older: sql<number>`(with recursive older(id) as (select l.to_entity_id from ${link} l where l.from_entity_id = ${document.entityId} and l.relation = 'supersedes' union select l.to_entity_id from ${link} l join older o on l.from_entity_id = o.id where l.relation = 'supersedes') select count(*)::int from older)`,
        superseded: sql<boolean>`exists (select 1 from ${link} l where l.to_entity_id = ${document.entityId} and l.relation = 'supersedes')`,
        // `Newer version of…` offers the files of its kind filed under one
        // of its records, as the file's head does.
        hasOlder: sql<boolean>`exists (select 1 from ${link} mine join ${link} theirs on theirs.to_entity_id = mine.to_entity_id and theirs.relation = 'tagged_in' join ${document} d2 on d2.entity_id = theirs.from_entity_id join ${entity} e2 on e2.id = d2.entity_id where mine.from_entity_id = ${document.entityId} and mine.relation = 'tagged_in' and d2.kind = ${document.kind} and d2.entity_id <> ${document.entityId} and e2.merged_into_id is null)`,
        inSyncedFolder: inSyncedFolderSql,
        versions: keptVersionsSql,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      // `uploaded_by` is null for a file a connector brought with no person
      // behind it, and `source_ref` for every manual upload.
      .leftJoin(user, eq(user.id, document.uploadedBy))
      .leftJoin(integration, eq(integration.id, document.sourceRef))
      .where(and(...matched))
      .orderBy(desc(unfiled), desc(document.createdAt), desc(document.entityId))
      .limit(limit),
  )
  if (rows.length === 0)
    return { rows: [], total: found.total, unfiled: found.unfiled, counts }

  const ids = rows.map((r) => r.id)
  const filings = yield* documentFilingEdgesProgram(ids)
  const tree = [...filings.values()].some((edges) =>
    edges.some((e) => e.kind === 'space'),
  )
    ? yield* spaceTreeProgram()
    : new Map<string, { readonly parents: ReadonlyArray<string> }>()
  const senders = yield* emailSendersProgram(viewer, ids)
  // One guess per unfiled row on screen, never for the whole workspace.
  const guesses = new Map(
    yield* Effect.forEach(
      rows.filter((r) => r.unfiled),
      (r) =>
        namedInFileProgram(viewer, r.id, 1).pipe(
          Effect.map((named) => [r.id, named.at(0) ?? null] as const),
        ),
      { concurrency: 4 },
    ),
  )

  return {
    rows: rows.map((r): FilesLedgerRow => {
      const edges = filings.get(r.id) ?? []
      return {
        id: r.id,
        filename: r.filename ?? 'Untitled file',
        kind: r.kind,
        mime: r.mime,
        sizeBytes: r.sizeBytes,
        blobSha: r.blobSha,
        url: r.url,
        externalUrl: r.externalUrl,
        extractionStatus: r.extractionStatus,
        extractionError: r.extractionError,
        createdAt: r.createdAt.toISOString(),
        unfiled: r.unfiled,
        firstLine: firstLineOf(r.firstText),
        pages: r.pages,
        words: r.words === null ? null : Number(r.words),
        versionAt: r.older > 0 || r.superseded ? r.older + 1 : null,
        records: edges.flatMap((e) =>
          e.kind === 'record'
            ? [
                {
                  id: e.id,
                  name: e.name,
                  kind: e.entityKind,
                  objectSlug: e.objectSlug,
                },
              ]
            : [],
        ),
        spaces: edges.flatMap((e) =>
          e.kind === 'space'
            ? [
                {
                  id: e.id,
                  name: e.name,
                  parents: tree.get(e.id)?.parents ?? [],
                },
              ]
            : [],
        ),
        source: sourceOf(viewer, r, senders.get(r.id)),
        guess: guesses.get(r.id) ?? null,
        hasOlder: r.hasOlder,
        sourceCapability: r.sourceCapability,
        sourcePath: r.sourcePath,
        inSyncedFolder: r.inSyncedFolder,
        versions: r.versions,
      }
    }),
    total: found.total,
    unfiled: found.unfiled,
    counts,
  }
})

/** The email a file came on: its sender and mailbox. */
type Sender = { readonly from: string | null; readonly mailbox: string | null }

/**
 * Each attached file's sender, from the earliest email the reader may read
 * (`attachmentEmailsProgram`'s gate): a file on an email the reader may not
 * open names no one.
 */
const emailSendersProgram = Effect.fn('filesLedger.senders')(function* (
  viewer: { readonly id: string; readonly email: string },
  documentIds: ReadonlyArray<string>,
) {
  const attached = yield* attachmentEmailsProgram(viewer, documentIds)
  const out = new Map<string, Sender>()
  if (attached.size === 0) return out
  const mails = yield* documentsQuery(() =>
    db
      .select({ id: interaction.id, meta: interaction.meta })
      .from(interaction)
      .where(
        inArray(
          interaction.id,
          [...attached.values()].map((a) => a.interactionId),
        ),
      ),
  )
  const metaOf = new Map(mails.map((m) => [m.id, m.meta]))
  const me = viewer.email.toLowerCase()
  for (const [documentId, mail] of attached) {
    const meta = metaOf.get(mail.interactionId)
    const sender = parseAddresses(meta?.kind === 'email' ? meta.from : '').at(0)
    out.set(documentId, {
      from:
        sender === undefined || sender.email === me
          ? null
          : (sender.name ?? sender.email),
      mailbox: mail.mailbox,
    })
  }
  return out
})

function sourceOf(
  viewer: { readonly id: string },
  r: {
    readonly sourceCapability: string | null
    readonly sourcePath: string | null
    readonly url: string | null
    readonly uploadedBy: string | null
    readonly uploadedByName: string | null
  },
  sender: Sender | undefined,
): FilesSource {
  if (sender !== undefined) return { via: 'email', ...sender }
  if (r.sourceCapability !== null)
    return { via: 'lane', lane: r.sourceCapability, path: r.sourcePath }
  if (r.url !== null && URL.canParse(r.url))
    return {
      via: 'link',
      site: new URL(r.url).hostname.replace(/^www\./, ''),
    }
  return {
    via: 'upload',
    by: r.uploadedBy === viewer.id ? null : r.uploadedByName,
  }
}
