import { Effect } from 'effect'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attributeEvent } from '@spaces/db/schema'
import { parseRef } from '@spaces/core/context/ref'
import { excerpt } from '@spaces/core/context/excerpt'
import { renderWikiLinks } from '@spaces/core/context/wiki-link'
import { canReadNoteSql } from '@spaces/core/writes/read/search'
import { getRecordProgram } from '@spaces/core/writes/read/record'
import { passageDaySql } from '#/lib/search/passages'
import { documentParentsProgram } from '#/lib/search/query'
import { AskQueryFailed, askQuery } from './query'

/**
 * What a citation in an answer previews on hover: the passage it stands for,
 * read as the reader, with where it lives and its day.
 * - `doc:<id>#<idx>` is that chunk, with its page and the file's last page.
 * - `note:` / `memo:` is the note's first chunk, else the start of its body.
 * - `interaction:` is the start of its written-up body.
 * - `attr:` is the value as the record prints it.
 * Every read passes the same note and document predicate the search lanes
 * filter by, so a ref the reader may not read answers null — nor does it say
 * where the source lives. Any other ref, or one that names nothing, is null.
 */

export type AskRefPreview = {
  kind: 'file' | 'note' | 'interaction' | 'attribute'
  /** The file's name, the note's title, the subject, the attribute's name. */
  name: string
  text: string
  /** The chunk's page; null for a source with no pages. */
  page: number | null
  /** The file's last page, when it has pages. */
  pages: number | null
  /** The record or space it is filed on; for an attribute, its record. */
  on: string | null
  /** ISO instant: a file's arrival, a note's last edit, when it happened. */
  day: string | null
}

/** How much of a body a preview prints before it is cut. */
const BODY_MAX = 600

const flat = (text: string) =>
  excerpt(text.replace(/[«»]/g, ''), { noteBody: true, max: BODY_MAX })

const parentName = Effect.fn('ask.refParent')(function* (id: string) {
  const parents = yield* documentParentsProgram([id]).pipe(
    Effect.mapError((e) => new AskQueryFailed({ cause: e.cause })),
  )
  return parents.get(id)?.name ?? null
})

type SourceRow = {
  name: string
  text: string | null
  body: string | null
  page: number | null
  pages: number | null
  day: string | null
}

/** A chunk of a file or a note, behind the reader's predicate. */
const sourceProgram = Effect.fn('ask.refSource')(function* (
  userId: string,
  entityId: string,
  source: { kind: 'document'; idx: number } | { kind: 'note' },
) {
  const chunkWhere =
    source.kind === 'document'
      ? sql`ch.source_kind = 'document' and ch.idx = ${source.idx}`
      : sql`ch.source_kind = 'note'`
  const row = (yield* askQuery(() =>
    db.execute<SourceRow>(sql`
      select
        coalesce(nullif(n.title, ''), d.filename, e.canonical_name) as name,
        (select ch.text from chunk ch
          where ch.entity_id = e.id and ${chunkWhere}
          order by ch.idx limit 1) as text,
        (select ch.page from chunk ch
          where ch.entity_id = e.id and ${chunkWhere}
          order by ch.idx limit 1) as page,
        (select max(ch.page) from chunk ch
          where ch.entity_id = e.id and ch.source_kind = 'document') as pages,
        n.body_md as body,
        ${passageDaySql(sql`e`)} as day
      from entity e
      left join note n on n.entity_id = e.id
      left join document d on d.entity_id = e.id
      where e.id = ${entityId}
        and e.merged_into_id is null
        and e.kind = ${source.kind}
        and ${canReadNoteSql(userId)}
    `),
  )).rows.at(0)
  if (row === undefined) return null
  const text =
    row.text !== null
      ? renderWikiLinks(row.text)
      : row.body !== null
        ? flat(row.body)
        : ''
  if (text === '') return null
  const out: AskRefPreview = {
    kind: source.kind === 'document' ? 'file' : 'note',
    name: row.name,
    text,
    page: row.page,
    pages: row.pages,
    on: yield* parentName(entityId),
    day: row.day,
  }
  return out
})

type InteractionRow = {
  subject: string | null
  kind: string
  body: string
  day: string
  on: string | null
}

/** An interaction's written-up body; one with none, or unreadable, is null. */
const interactionProgram = Effect.fn('ask.refInteraction')(function* (
  userId: string,
  id: string,
) {
  const row = (yield* askQuery(() =>
    db.execute<InteractionRow>(sql`
      select i.subject, i.kind::text as kind, n.body_md as body,
        to_char(i.occurred_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as day,
        (select r.canonical_name from interaction_entity ie
          join entity r on r.id = ie.entity_id and r.merged_into_id is null
          where ie.interaction_id = i.id
          order by r.canonical_name limit 1) as on
      from interaction i
      join note n on n.entity_id = i.note_id
      join entity e on e.id = n.entity_id
      where i.id = ${id}
        and ${canReadNoteSql(userId)}
    `),
  )).rows.at(0)
  if (row === undefined) return null
  const text = flat(row.body)
  if (text === '') return null
  const out: AskRefPreview = {
    kind: 'interaction',
    name: row.subject ?? row.kind,
    text,
    page: null,
    pages: null,
    on: row.on,
    day: row.day,
  }
  return out
})

/** An attribute's value as its record prints it, and when it last changed. */
const attributeProgram = Effect.fn('ask.refAttribute')(function* (
  userId: string,
  entityId: string,
  slug: string,
) {
  // Refused is the read policy's answer, or no such record: no preview.
  const record = yield* getRecordProgram({ id: userId }, entityId).pipe(
    Effect.catchTag('McpToolRefused', () => Effect.succeed(null)),
    Effect.mapError((e) => new AskQueryFailed({ cause: e.cause })),
  )
  if (record === null) return null
  const attr = record.attributes.find((a) => a.slug === slug)
  // `text` is `Name: value`, and null while the attribute is empty.
  if (attr === undefined || attr.text === null) return null
  const recordId = record.id
  const last = (yield* askQuery(() =>
    db
      .select({ at: attributeEvent.at })
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, recordId),
          eq(attributeEvent.attrSlug, slug),
        ),
      )
      .orderBy(desc(attributeEvent.at))
      .limit(1),
  )).at(0)
  const out: AskRefPreview = {
    kind: 'attribute',
    name: attr.name,
    text: attr.text.slice(attr.name.length + 2),
    page: null,
    pages: null,
    on: record.name,
    day: last?.at.toISOString() ?? null,
  }
  return out
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The preview of one cited ref, as `userId` may read it; null for none. */
export const askRefPreviewProgram = Effect.fn('ask.refPreview')(function* (
  userId: string,
  ref: string,
): Effect.fn.Return<AskRefPreview | null, AskQueryFailed> {
  const p = parseRef(ref)
  if (p === null) return null
  switch (p.kind) {
    case 'doc':
      return UUID.test(p.entityId)
        ? yield* sourceProgram(userId, p.entityId, {
            kind: 'document',
            idx: p.idx,
          })
        : null
    case 'note':
    case 'memo':
      return UUID.test(p.entityId)
        ? yield* sourceProgram(userId, p.entityId, { kind: 'note' })
        : null
    case 'interaction':
      return UUID.test(p.id) ? yield* interactionProgram(userId, p.id) : null
    case 'attr':
      return yield* attributeProgram(userId, p.entityId, p.slug)
    case 'event':
    case 'task':
    case 'mandate':
    case 'term':
      return null
  }
})
