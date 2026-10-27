import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entityAlias, objectDef } from '@spaces/db/schema'
import { canonicalId } from '@spaces/core/writes/entities/sweep'
import {
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
} from '@spaces/sdk/identity'
import { recordPath } from '#/lib/record-path'
import { effectFn } from '#/lib/server/effect'

/**
 * What a create window asks before it creates: whether the identity key
 * typed into it already names a record, and for an email, which company
 * its domain names.
 * - Read-only. The create itself still resolves on the server and attaches
 *   on a match; this is what lets the window refuse first and link to the
 *   record instead.
 * - Keys are normalized by the same `@spaces/sdk/identity` functions the
 *   alias index stores, so a typed `https://www.Acme.com/` finds `acme.com`.
 * - Outside the server-fn barrel so a test drives it against the database.
 */

export type IdentityKey = 'domain' | 'email' | 'linkedin'

/** A record found by a key, with the page it lives on. */
export type IdentityOwner = {
  readonly id: string
  readonly name: string
  readonly kind: string
  /** Null for a kind with no page. */
  readonly path: string | null
}

export type IdentityMatch = {
  /** The live record that already holds this key. */
  readonly owner: IdentityOwner | null
  /** For an email: the company holding its domain. Null otherwise. */
  readonly company: { readonly id: string; readonly name: string } | null
}

export class FindByIdentityFailed extends Schema.TaggedError<FindByIdentityFailed>()(
  'FindByIdentityFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new FindByIdentityFailed({ cause }),
  })

const NORMALIZE: Record<IdentityKey, (raw: string) => string | null> = {
  domain: normalizeDomain,
  email: normalizeEmail,
  linkedin: normalizeLinkedin,
}

/** The live record an identity alias names, following a merge. */
const holderOf = Effect.fn('holderOf')(function* (
  kind: IdentityKey,
  valueNorm: string,
): Effect.fn.Return<IdentityOwner | null, FindByIdentityFailed> {
  const hit = (yield* query(() =>
    db
      .select({ entityId: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, kind),
          eq(entityAlias.valueNorm, valueNorm),
          eq(entityAlias.isIdentity, true),
        ),
      )
      .limit(1),
  )).at(0)
  if (hit === undefined) return null
  const id = yield* query(() => canonicalId(hit.entityId))
  const row = (yield* query(() =>
    db
      .select({
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
      })
      .from(entity)
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(eq(entity.id, id)),
  )).at(0)
  if (row === undefined) return null
  return {
    id,
    name: row.name,
    kind: row.kind,
    path: recordPath({ kind: row.kind, id, objectSlug: row.objectSlug }),
  }
})

export const findByIdentityProgram = Effect.fn('findByIdentityProgram')(
  function* (input: {
    key: IdentityKey
    value: string
  }): Effect.fn.Return<IdentityMatch, FindByIdentityFailed> {
    const norm = NORMALIZE[input.key](input.value)
    if (norm === null) return { owner: null, company: null }
    const owner = yield* holderOf(input.key, norm)
    if (input.key !== 'email') return { owner, company: null }
    // A free-mail domain names no company: `normalizeDomain` answers null.
    const domain = normalizeDomain(norm.slice(norm.lastIndexOf('@') + 1))
    const holder = domain === null ? null : yield* holderOf('domain', domain)
    return {
      owner,
      company:
        holder?.kind === 'company'
          ? { id: holder.id, name: holder.name }
          : null,
    }
  },
)

/** `findByIdentity`'s body. */
export function findByIdentityHandler(input: {
  key: IdentityKey
  value: string
}): Promise<IdentityMatch> {
  return effectFn(findByIdentityProgram)(input)
}
