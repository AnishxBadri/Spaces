import { Effect, Layer } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entityAlias } from '@spaces/db/schema'
import { JobRetryable, Read } from '@spaces/sdk'
import type { ReadEntity, RecordKind, SearchHit } from '@spaces/sdk'
import { getRecordProgram } from '../read/record'
import { lexicalRowsProgram } from '../read/search'
import type { BoundIntegration } from './binding'

/**
 * ReadLive: the plugin's view of the graph, read **as the bound integration**
 * (`{ type: 'integration', id: row.id }`). No function here takes an actor,
 * so a plugin cannot read as anyone else; a private note is never visible.
 * - `entity(id)` is MCP's `get_record` program: merged ids follow to the
 *   survivor; an unreadable id, a missing one and anything not a company,
 *   person or deal all answer null.
 * - `search(q)` is the lexical + fuzzy fused statement with `canReadNoteSql`
 *   as the integration — no embedding call. Company, person and deal only.
 */

export type IntegrationActor = {
  readonly type: 'integration'
  readonly id: string
}

/** The reader a Layer reads as — derived from the row, never passed in. */
export const actorOf = (
  row: Pick<BoundIntegration, 'id'>,
): IntegrationActor => ({
  type: 'integration',
  id: row.id,
})

const RECORD_KINDS: ReadonlyArray<RecordKind> = ['company', 'person', 'deal']
const isRecordKind = (kind: string): kind is RecordKind =>
  RECORD_KINDS.some((k) => k === kind)

const KEY_KINDS = ['domain', 'email', 'linkedin'] as const

const failed = (what: string) => (cause: unknown) =>
  new JobRetryable({
    reason: `Read.${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  })

export const ReadLive = (
  row: Pick<BoundIntegration, 'id'>,
): Layer.Layer<Read> => {
  const actor = actorOf(row)

  const entity = (id: string) =>
    Effect.gen(function* () {
      const record = yield* getRecordProgram(actor, id).pipe(
        Effect.map((r) => r),
        Effect.catchTag('McpToolRefused', () => Effect.succeed(null)),
        Effect.catchTag('McpToolQueryFailed', (e) =>
          Effect.fail(failed('entity')(e.cause)),
        ),
      )
      if (record === null || !isRecordKind(record.kind)) return null
      const aliases = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ kind: entityAlias.kind, value: entityAlias.valueNorm })
            .from(entityAlias)
            .where(
              and(
                eq(entityAlias.entityId, record.id),
                inArray(entityAlias.kind, [...KEY_KINDS]),
              ),
            )
            .orderBy(entityAlias.createdAt, entityAlias.id),
        catch: failed('entity'),
      })
      const keysOf = (kind: (typeof KEY_KINDS)[number]) =>
        aliases.filter((a) => a.kind === kind).map((a) => a.value)
      const values: Record<
        string,
        (typeof record.attributes)[number]['value']
      > = {}
      // Stored values only: a relationship's inverse half stays MCP's.
      for (const a of record.attributes)
        if (a.value !== null && a.derived !== true) values[a.slug] = a.value
      const result: ReadEntity = {
        id: record.id,
        kind: record.kind,
        name: record.name,
        keys: {
          domain: keysOf('domain'),
          email: keysOf('email'),
          linkedin: keysOf('linkedin'),
        },
        values,
      }
      return result
    })

  const search = (
    q: string,
    options?: { kinds?: ReadonlyArray<RecordKind>; limit?: number },
  ) =>
    Effect.gen(function* () {
      const text = q.trim()
      if (text.length < 2) return []
      const rows = yield* lexicalRowsProgram({
        userId: actor.id,
        q: text,
      }).pipe(Effect.mapError((e) => failed('search')(e.cause)))
      const wanted = options?.kinds ?? RECORD_KINDS
      const hits: Array<SearchHit> = []
      for (const r of rows) {
        if (r.row_kind !== 'entity' || !isRecordKind(r.kind)) continue
        const kind = r.kind
        if (!wanted.includes(kind)) continue
        hits.push({ entityId: r.id, kind, name: r.name })
      }
      return hits.slice(0, options?.limit ?? 20)
    })

  return Layer.succeed(Read, Read.of({ entity, search }))
}
