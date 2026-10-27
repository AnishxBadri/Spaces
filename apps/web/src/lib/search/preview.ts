import { Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, objectDef } from '@spaces/db/schema'
import type { SelectOption } from '@spaces/db/schema'
import { jsonString, jsonStrings } from '@spaces/core/json'
import { getRegistryByObjectId } from '@spaces/core/writes/attributes/values'
import { canReadNoteSql } from '@spaces/core/writes/read/search'
import { renderWikiLinks } from '@spaces/core/context/wiki-link'
import { excerpt } from '@spaces/core/context/excerpt'
import { listViewsProgram } from '@spaces/core/writes/views/store'
import { getRecordProgram } from '@spaces/core/writes/read/record'
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
import { countViewsProgram, scopeOf } from '#/lib/views/counts'
import { listScope } from '#/lib/views/scope'
import { passageDaySql } from './passages'
import { documentParentsProgram } from './query'
import type { SearchParent } from './query'

/**
 * Cmd-K's preview pane: what a highlighted result shows.
 * - A record is `get_record`'s read as the user (canRead included) plus the
 *   readouts its head prints; the fields are its first six filled attributes,
 *   a company's domain apart in the head, a deal's stages for Move stage.
 * - An object is its record total, as the list page scopes it, and its saved
 *   views with the chips' counts: the views directory and the chips' count
 *   program, never a second count.
 * - A passage is its page's text with the nearest chunk set off, behind the
 *   same note predicate the semantic lane filters by, and the record it is
 *   filed on with its day.
 * Outside the server-fn module so a test can call it without a request.
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

/**
 * One filled attribute as the pane prints it: money in mono, a single
 * select or status option as its badge, anything else as text.
 */
export type PreviewField =
  | { slug: string; label: string; value: string; display: 'text' | 'money' }
  | {
      slug: string
      label: string
      value: string
      display: 'badge'
      /** The option row and its position: what the badge's hue is read from. */
      option: SelectOption
      index: number
    }

/** A deal's live stages and where it stands, for the pane's Move stage. */
export type PreviewStages = {
  current: string | null
  options: Array<SelectOption>
}

export type RecordPreview = {
  id: string
  kind: string
  name: string
  /** The object's singular, for the stamp; null for a note or a file. */
  singular: string | null
  /** The spaces it is filed in, for File in a space. */
  spaces: Array<{ id: string; name: string }>
  /** A company's first domain, printed under its name; null elsewhere. */
  domain: string | null
  readouts: PreviewReadouts | null
  fields: Array<PreviewField>
  /** A deal's stages; null for every other kind. */
  stages: PreviewStages | null
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
    const objectId = record.object?.id ?? null
    const registry =
      objectId === null
        ? []
        : yield* query(() => getRegistryByObjectId(objectId))
    const optionsOf = (slug: string) =>
      registry.find((d) => d.slug === slug)?.options.options ?? []
    const domainAttr = record.attributes.find(
      (a) => a.type === 'domain' && a.text !== null,
    )
    const domain =
      record.kind === 'company' && domainAttr
        ? (jsonString(domainAttr.value) ?? jsonStrings(domainAttr.value).at(0))
        : undefined
    const fields: Array<PreviewField> = []
    for (const a of record.attributes) {
      if (fields.length === PREVIEW_FIELDS) break
      // `text` is `Name: value`, and null when the attribute is empty.
      if (a.text === null) continue
      // The head prints the domain; the grid does not repeat it.
      if (domain !== undefined && a === domainAttr) continue
      const base = {
        slug: a.slug,
        label: a.name,
        value: a.text.slice(a.name.length + 2),
      }
      const picked = jsonString(a.value)
      const options =
        (a.type === 'select' || a.type === 'status') && picked !== null
          ? optionsOf(a.slug)
          : []
      const index = options.findIndex((o) => o.id === picked)
      const option = options.at(index)
      if (index >= 0 && option)
        fields.push({ ...base, display: 'badge', option, index })
      else
        fields.push({
          ...base,
          display: a.type === 'currency' ? 'money' : 'text',
        })
    }
    const stage = record.attributes.find((a) => a.slug === 'stage')
    const out: RecordPreview = {
      id: record.id,
      kind: record.kind,
      name: record.name,
      singular: record.object?.singular ?? null,
      spaces: record.spaces,
      domain: domain ?? null,
      readouts: yield* readoutsFor(record.kind, record.id, now),
      fields,
      stages:
        record.kind === 'deal'
          ? {
              current: stage ? jsonString(stage.value) : null,
              // Move stage never offers a retired stage.
              options: optionsOf('stage').filter((o) => o.archived !== true),
            }
          : null,
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
  /** Every record the object's list lists, before any view: `All 28`. */
  total: number
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
    // The list page's own scope, so `All` never contradicts the table.
    const total = yield* query(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(entity)
        .where(listScope(scopeOf(object)))
        .then((rows) => rows.at(0)?.n ?? 0),
    )
    const out: ObjectPreview = {
      slug: object.slug,
      plural: object.plural,
      path,
      total,
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
  /** The record or space the note or file is filed on. */
  on: SearchParent | null
  /** A note's last edit, a file's arrival: ISO instant. */
  day: string | null
}

type ChunkRow = { idx: number; text: string; page: number | null }

/** A chunk's text as a snippet was cut from it: marks gone, links as names. */
const flatten = (text: string) => excerpt(text.replace(/[«»]/g, ''))

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
              flatten(r.text).includes(snippet),
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
    // Nothing readable, nothing said about where it lives either.
    const readable = rows.length > 0
    const parents = readable
      ? yield* documentParentsProgram([passage.id])
      : new Map<string, SearchParent>()
    const day = readable
      ? ((yield* query(() =>
          db.execute<{ day: string | null }>(sql`
            select ${passageDaySql(sql`e`)} as day
            from entity e
            where e.id = ${passage.id}
          `),
        )).rows.at(0)?.day ?? null)
      : null
    const out: PassagePreview = {
      page: passage.page,
      pages: numbered.length === 0 ? null : Math.max(...numbered),
      parts: onPage.map((r) => ({
        text: renderWikiLinks(r.text),
        matched: r === matched,
      })),
      on: parents.get(passage.id) ?? null,
      day,
    }
    return out
  },
)
