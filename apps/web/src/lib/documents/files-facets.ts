import { Effect } from 'effect'
import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type {
  FilesFacet,
  FilesFilters,
  FilesFormat,
  FilesFrom,
  FilesLook,
} from './files-filter'
import {
  filterConditions,
  formatSql,
  lookSql,
  sourceSql,
} from './files-filter-sql'
import { filesScope } from './files-ledger'
import type { FilesTab } from './files-ledger-view'
import { documentsQuery } from './query'
import { unfiledPredicate } from './unfiled'

/**
 * The Filter panel's counts. Each chip is counted under the open tab, the
 * search and every other facet's filters, with its own facet off: the
 * number it prints is the number of rows the list shows once it alone is
 * on in its facet. Read when the panel opens, never with the list.
 */

export type FilesFacets = {
  /** The `Unfiled` chip's. */
  readonly unfiled: number
  readonly from: Readonly<Record<FilesFrom, number>>
  readonly type: Readonly<Record<FilesFormat, number>>
  readonly look: Readonly<Record<FilesLook, number>>
  /** Every member, with the files they added; the picker's rows. */
  readonly by: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly count: number
  }>
  /** The foot's `96 of 214`: what the filters leave, of the tab and search. */
  readonly shown: number
  readonly total: number
}

export const filesFacetsProgram = Effect.fn('filesFacets')(function* (params: {
  readonly viewer: { readonly id: string }
  readonly tab: FilesTab
  readonly q: string
  readonly filters: FilesFilters
}) {
  const scope = filesScope(params)
  const where = (except: FilesFacet | null): Array<SQL | undefined> => [
    ...scope,
    ...filterConditions(params.filters, except),
  ]
  const counted = <TKey extends string>(
    key: SQL<TKey | null>,
    except: FilesFacet,
  ) =>
    // `group by 1`: the case expression carries parameters, and Postgres
    // cannot match a repeated one to the select list's.
    documentsQuery(() =>
      db
        .select({ key, n: count() })
        .from(document)
        .innerJoin(entity, eq(entity.id, document.entityId))
        .where(and(...where(except)))
        .groupBy(sql`1`),
    )
  /** A grouped count's number for one key, zero when no row has it. */
  const of =
    <TKey extends string>(
      rows: ReadonlyArray<{ key: TKey | null; n: number }>,
    ) =>
    (k: TKey) =>
      rows.find((r) => r.key === k)?.n ?? 0

  const from = yield* counted(sourceSql, 'from')
  const type = yield* counted(formatSql, 'type')
  const filed = (yield* documentsQuery(() =>
    db
      .select({
        unfiled:
          sql<number>`count(*) filter (where ${unfiledPredicate()})`.mapWith(
            Number,
          ),
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(and(...where('under'))),
  )).at(0)
  const looks = (yield* documentsQuery(() =>
    db
      .select({
        unread:
          sql<number>`count(*) filter (where ${lookSql('unread')})`.mapWith(
            Number,
          ),
        textOnly:
          sql<number>`count(*) filter (where ${lookSql('text-only')})`.mapWith(
            Number,
          ),
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(and(...where('look'))),
  )).at(0)
  const adders = yield* documentsQuery(() =>
    db
      .select({ id: document.uploadedBy, n: count() })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(and(...where('by')))
      .groupBy(document.uploadedBy),
  )
  const members = yield* documentsQuery(() =>
    db
      .select({ id: user.id, name: user.name, banned: user.banned })
      .from(user)
      .orderBy(asc(user.name)),
  )
  const totals = (yield* documentsQuery(() =>
    Promise.all([
      db
        .select({ n: count() })
        .from(document)
        .innerJoin(entity, eq(entity.id, document.entityId))
        .where(and(...where(null))),
      db
        .select({ n: count() })
        .from(document)
        .innerJoin(entity, eq(entity.id, document.entityId))
        .where(and(...scope)),
    ]),
  )).map((rows) => rows.at(0)?.n ?? 0)

  const addedBy = new Map(adders.map((a) => [a.id, a.n]))
  return {
    unfiled: filed?.unfiled ?? 0,
    from: {
      upload: of(from)('upload'),
      email: of(from)('email'),
      drive: of(from)('drive'),
      link: of(from)('link'),
    },
    type: {
      pdf: of(type)('pdf'),
      sheet: of(type)('sheet'),
      document: of(type)('document'),
      slides: of(type)('slides'),
      image: of(type)('image'),
      web: of(type)('web'),
    },
    look: {
      unread: looks?.unread ?? 0,
      'text-only': looks?.textOnly ?? 0,
    },
    // A member who can no longer sign in is offered only for what they added.
    by: members
      .filter((m) => m.banned !== true || addedBy.has(m.id))
      .map((m) => ({ id: m.id, name: m.name, count: addedBy.get(m.id) ?? 0 })),
    shown: totals.at(0) ?? 0,
    total: totals.at(1) ?? 0,
  } satisfies FilesFacets
})
