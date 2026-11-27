import { eq, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import {
  document,
  entitySpace,
  integration,
  interactionDocument,
  link,
} from '@spaces/db/schema'
import { FORMAT_OF_TYPE, MAIL_CAPABILITIES } from './files-filter'
import type {
  FilesFacet,
  FilesFilters,
  FilesFormat,
  FilesFrom,
  FilesLook,
} from './files-filter'
import { BY_EXTENSION, GOOGLE_MIMES, GOOGLE_PATHS } from './files-tab'
import type { FileType } from './files-tab'
import { MIN_QUERY } from './find-text'
import { unfiledPredicate } from './unfiled'

/**
 * The Files page's filters as SQL over the bare `document` table, which
 * every caller selects unaliased. The rules mirror what a row prints: a
 * file's source as its source lane says it, its format as its glyph draws
 * it, so a chip's count is the rows it then shows.
 */

const values = (list: ReadonlyArray<string>): SQL =>
  sql.join(
    list.map((v) => sql`${v}`),
    sql`, `,
  )

/**
 * Where a file came from, one of `FILES_FROM`: attached to an email or
 * brought by a mailbox, then brought by any other connection, then clipped
 * from a link, else uploaded.
 */
export const sourceSql: SQL<FilesFrom> = sql<FilesFrom>`(case
  when exists (select 1 from ${interactionDocument} where ${interactionDocument.documentId} = ${document.entityId} and ${interactionDocument.role} = 'attachment')
    or exists (select 1 from ${integration} where ${integration.id} = ${document.sourceRef} and ${integration.capabilityId} in (${values(MAIL_CAPABILITIES)}))
    then 'email'
  when ${document.sourceRef} is not null then 'drive'
  when ${document.url} is not null then 'link'
  else 'upload' end)`

/** The keys of a type table grouped by the format `Type` files them under. */
function typesBy(
  table: Readonly<Record<string, FileType>>,
): Map<FilesFormat | null, Array<string>> {
  const out = new Map<FilesFormat | null, Array<string>>()
  for (const [key, type] of Object.entries(table)) {
    const format = FORMAT_OF_TYPE[type]
    out.set(format, [...(out.get(format) ?? []), key])
  }
  return out
}

const formatValue = (format: FilesFormat | null): SQL =>
  format === null ? sql`null` : sql`${format}`

/** `lower(extension)`, empty when the name has no dot, as `fileType` reads it. */
const extension = sql`lower(coalesce(substring(${document.filename} from '\\.([^.]*)$'), ''))`
const mime = sql`lower(coalesce(${document.mime}, ''))`

/**
 * A file's format, one of `FILES_FORMATS` or null: a clipped page is a web
 * page whatever its name, otherwise `FORMAT_OF_TYPE` of its glyph's type,
 * clause for clause in `fileType`'s order (a Google file by its type or its
 * link, the extension, then the mime).
 */
export const formatSql: SQL<FilesFormat | null> = (() => {
  const clauses: Array<SQL> = [sql`when ${document.url} is not null then 'web'`]
  for (const [format, mimes] of typesBy(GOOGLE_MIMES))
    clauses.push(
      sql`when ${document.mime} in (${values(mimes)}) then ${formatValue(format)}`,
    )
  for (const [path, type] of GOOGLE_PATHS)
    clauses.push(
      sql`when ${document.externalUrl} ~ ${`^https?://docs\\.google\\.com${path}`} then ${formatValue(FORMAT_OF_TYPE[type])}`,
    )
  for (const [format, exts] of typesBy(BY_EXTENSION))
    clauses.push(
      sql`when ${extension} in (${values(exts)}) then ${formatValue(format)}`,
    )
  clauses.push(
    sql`when ${mime} = 'application/pdf' then 'pdf'`,
    sql`when ${mime} like 'image/%' then 'image'`,
    sql`when ${mime} like 'text/%' then 'document'`,
  )
  return sql<FilesFormat | null>`(case ${sql.join(clauses, sql` `)} else null end)`
})()

/** `Needs a look`: the text could not be read, or only the text was kept. */
export function lookSql(look: FilesLook): SQL {
  return look === 'unread'
    ? sql`${document.extractionStatus} = 'failed'`
    : sql`${document.bytesState} = 'remote'`
}

/** Filed directly under the record or space `id`. */
export function underSql(id: string): SQL {
  return sql`(exists (select 1 from ${link} where ${link.fromEntityId} = ${document.entityId} and ${link.relation} = 'tagged_in' and ${link.toEntityId} = ${id})
    or exists (select 1 from ${entitySpace} where ${entitySpace.entityId} = ${document.entityId} and ${entitySpace.spaceId} = ${id}))`
}

/**
 * The filters that are on as conditions to AND, leaving out the facet
 * `except` names: a chip's count is read with every other facet on and its
 * own facet off, so it says what the list shows once it is pressed.
 */
export function filterConditions(
  f: FilesFilters,
  except: FilesFacet | null = null,
): Array<SQL> {
  const out: Array<SQL> = []
  if (except !== 'under') {
    const filed = [
      ...(f.under === null ? [] : [underSql(f.under)]),
      ...(f.unfiled ? [sql`(${unfiledPredicate()})`] : []),
    ]
    const any = or(...filed)
    if (any !== undefined) out.push(any)
  }
  if (except !== 'from' && f.from.length > 0)
    out.push(sql`${sourceSql} in (${values(f.from)})`)
  if (except !== 'type' && f.type.length > 0)
    out.push(sql`${formatSql} in (${values(f.type)})`)
  if (except !== 'by' && f.by !== null) out.push(eq(document.uploadedBy, f.by))
  if (except !== 'look' && f.look.length > 0) {
    const any = or(...f.look.map(lookSql))
    if (any !== undefined) out.push(any)
  }
  return out
}

/**
 * The query as a regular-expression literal: every character that is not a
 * letter, a digit or a space escaped, which an advanced regex reads
 * literally.
 */
const literal = (q: string) => q.replace(/[^\p{L}\p{N}\s]/gu, '\\$&')

/**
 * The places a file's text matches the search, as `searchHit` counts them:
 * case-insensitive, never on a `[Page N]` or `[Slide N]` marker line. Zero
 * below `MIN_QUERY`, where the hits are not drawn either.
 */
export function placesSql(q: string): SQL<number> {
  const query = q.trim()
  if (query.length < MIN_QUERY) return sql<number>`0`
  return sql<number>`coalesce(regexp_count(regexp_replace(${document.extractedText}, '^\\[(Page|Slide) [0-9]+\\]$', '', 'gn'), ${literal(query)}, 1, 'i'), 0)`
}
