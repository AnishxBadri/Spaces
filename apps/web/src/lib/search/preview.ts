import { Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { objectDef } from '@spaces/db/schema'
import { canReadNoteSql } from '@spaces/core/writes/read/search'
import { listViewsProgram } from '@spaces/core/writes/views/store'
import { getRecordProgram } from '#/lib/mcp/tools'
import {
  companyReadoutsProgram,
  dealReadoutsProgram,
  personReadoutsProgram,
  recordReadoutsProgram,
} from '#/lib/records/readouts'
import type {
  CompanyReadouts,
  DealReadouts,
  PersonReadouts,
  RecordReadouts,
} from '#/lib/records/readouts'
import { countViewsProgram } from '#/lib/views/counts'

/**
 * Cmd-K's preview pane: what a highlighted result shows. (D70)
 * - A record is `get_record`'s read as the user (canRead included) plus the
 *   readouts its head prints; the fields are its first six filled attributes.
 * - An object is its saved views with their counts: the views directory and
 *   the chips' count program, never a second count.
 * - A passage is its page's text with the nearest chunk set off, behind the
 *   same note predicate the semantic lane filters by.
 * Outside `lib/server/` so a test can call it without a request.
 */

/** How many filled attributes the pane lists. */
export const PREVIEW_FIELDS = 6

export class PreviewReadFailed extends Schema.TaggedError<PreviewReadFailed>()(
  'PreviewReadFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PreviewReadFailed({ cause }),
  })

/** The numbers the record's own head prints, by the head that prints them. */
export type PreviewReadouts =
  | { kind: 'company'; readouts: CompanyReadouts }
  | { kind: 'person'; readouts: PersonReadouts }
  | { kind: 'deal'; readouts: DealReadouts }
  | { kind: 'custom'; readouts: RecordReadouts }

export type PreviewField = { slug: string; label: string; value: string }

export type RecordPreview = {
  id: string
  kind: string
  name: string
  /** The object's singular, for the stamp; null for a note or a file. */
  singular: string | null
  /** The spaces it is filed in, for the crumb. */
  spaces: Array<{ id: string; name: string }>
  readouts: PreviewReadouts | null
  fields: Array<PreviewField>
}

const readoutsFor = Effect.fn('readoutsFor')(function* (
  kind: string,
  id: string,
  now: Date,
) {
  if (kind === 'company')
    return {
      kind,
      readouts: yield* companyReadoutsProgram(id, now),
    } satisfies PreviewReadouts
  if (kind === 'person')
    return {
      kind,
      readouts: yield* personReadoutsProgram(id, now),
    } satisfies PreviewReadouts
  if (kind === 'deal')
    return {
      kind,
      readouts: yield* dealReadoutsProgram(id, now),
    } satisfies PreviewReadouts
  if (kind === 'custom')
    return {
      kind,
      readouts: yield* recordReadoutsProgram(id, now),
    } satisfies PreviewReadouts
  return null
})

export const recordPreviewProgram = Effect.fn('recordPreviewProgram')(
  function* (reader: { id: string }, id: string, now: Date) {
    const record = yield* getRecordProgram(reader, id)
    const fields: Array<PreviewField> = []
    for (const a of record.attributes) {
      if (fields.length === PREVIEW_FIELDS) break
      // `text` is `Name: value`, and null when the attribute is empty.
      if (a.text === null) continue
      fields.push({
        slug: a.slug,
        label: a.name,
        value: a.text.slice(a.name.length + 2),
      })
    }
    const out: RecordPreview = {
      id: record.id,
      kind: record.kind,
      name: record.name,
      singular: record.object?.singular ?? null,
      spaces: record.spaces,
      readouts: yield* readoutsFor(record.kind, record.id, now),
      fields,
    }
    return out
  },
)

export type ObjectPreviewView = {
  id: string
  name: string
  href: string
  /** Null when the view cannot be counted (an archived attribute in it). */
  count: number | null
}

export type ObjectPreview = {
  slug: string
  plural: string
  path: string
  views: Array<ObjectPreviewView>
}

export const objectPreviewProgram = Effect.fn('objectPreviewProgram')(
  function* (reader: { id: string }, slug: string) {
    const object = (yield* query(() =>
      db
        .select({
          id: objectDef.id,
          slug: objectDef.slug,
          plural: objectDef.plural,
          isSystem: objectDef.isSystem,
        })
        .from(objectDef)
        .where(and(eq(objectDef.slug, slug), eq(objectDef.archived, false))),
    )).at(0)
    if (!object) return null
    const path = object.isSystem ? `/${object.slug}` : `/o/${object.slug}`
    const views = yield* listViewsProgram(
      { surface: 'object', objectId: object.id },
      reader.id,
    )
    const counts = yield* countViewsProgram(
      object.id,
      views.map((v) => v.id),
      reader.id,
    )
    const out: ObjectPreview = {
      slug: object.slug,
      plural: object.plural,
      path,
      views: views.map((v) => ({
        id: v.id,
        name: v.name,
        href: `${path}?view=${v.id}`,
        count: Object.hasOwn(counts, v.id) ? counts[v.id].count : null,
      })),
    }
    return out
  },
)

/** One chunk of the page, the matched one set off. */
export type PagePart = { text: string; matched: boolean }

export type PassagePreview = {
  /** The page shown; null for a source with no pages (a note). */
  page: number | null
  /** The source's last page, when it has pages. */
  pages: number | null
  parts: Array<PagePart>
}

type ChunkRow = { idx: number; text: string; page: number | null }

/** A chunk's text as the semantic lane's snippet was cut from it. */
const flatten = (text: string) =>
  text.replace(/[«»]/g, '').replace(/\s+/g, ' ').trim()

/**
 * The page a passage sits on, its chunks in order, the one whose text the
 * snippet was cut from marked. A source the reader may not read, or one
 * merged away, answers no parts.
 */
export const passagePreviewProgram = Effect.fn('passagePreviewProgram')(
  function* (
    userId: string,
    passage: { id: string; page: number | null; snippet: string },
  ) {
    const result = yield* query(() =>
      db.execute<ChunkRow>(sql`
        select ch.idx, ch.text, ch.page
        from chunk ch
        join entity e on e.id = ch.entity_id and e.merged_into_id is null
        where ch.entity_id = ${passage.id}
          and ${canReadNoteSql(userId)}
        order by ch.source_kind, ch.source_key, ch.idx
      `),
    )
    const rows = result.rows
    const snippet = flatten(passage.snippet)
    const matched =
      snippet === ''
        ? undefined
        : rows.find(
            (r) =>
              (passage.page === null || r.page === passage.page) &&
              flatten(r.text).startsWith(snippet),
          )
    const onPage =
      passage.page === null
        ? matched
          ? [matched]
          : []
        : rows.filter((r) => r.page === passage.page)
    const numbered = rows
      .map((r) => r.page)
      .filter((p): p is number => p !== null)
    const out: PassagePreview = {
      page: passage.page,
      pages: numbered.length === 0 ? null : Math.max(...numbered),
      parts: onPage.map((r) => ({ text: r.text, matched: r === matched })),
    }
    return out
  },
)
