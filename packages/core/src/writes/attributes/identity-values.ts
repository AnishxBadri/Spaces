import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { CORE_IDENTITY, identityNorm } from '../../attributes/registry'
import type { CoreIdentityKey } from '../../attributes/registry'
import { canonicalId } from '../entities/sweep'
import type { ResolveSource } from '../entities/resolve'
import { setValuesInTx } from './values'
import type { Actor, EventSource } from './values'

export type AddIdentityValueInput = {
  entityId: string
  key: CoreIdentityKey
  value: string
  actor: Actor
  source?: EventSource
  identitySource?: ResolveSource
}

export type AddIdentityValueOutcome =
  'added' | 'already_own' | 'suggested_duplicate'

/**
 * One more email on a person, or domain on a company, through the one write
 * path: the element is appended to `emails` / `domains` and claimed by
 * `setValues`, so the value, its `attribute_event` and its alias land in one
 * transaction. A key another record holds is refused at that element and
 * raised as a `duplicate_candidate`.
 * - The row is locked before it is read, so two appends cannot lose one.
 * - Throws when the record is not a company or a person, or when the key is
 *   not the one its kind is identified by.
 */
export async function addIdentityValue(
  input: AddIdentityValueInput,
): Promise<{ outcome: AddIdentityValueOutcome }> {
  return db.transaction(async (tx) => {
    const id = await canonicalId(input.entityId, tx)
    const row = (
      await tx
        .select({ kind: entity.kind, values: entity.values })
        .from(entity)
        .where(eq(entity.id, id))
        .for('update')
    ).at(0)
    if (row?.kind !== 'company' && row?.kind !== 'person')
      throw new Error(`${input.entityId} is not a company or a person`)
    const { key, slug } = CORE_IDENTITY[row.kind]
    if (key !== input.key)
      throw new Error(`A ${row.kind} is not identified by ${input.key}`)
    const norm = identityNorm(key, input.value)
    if (norm === null) throw new Error(`Invalid ${key}: ${input.value}`)

    const held = row.values[slug]
    const elements = Array.isArray(held)
      ? held.filter((v): v is string => typeof v === 'string')
      : []
    const result = await setValuesInTx(tx, {
      entityId: id,
      patch: { [slug]: [...elements, input.value] },
      actor: input.actor,
      ...(input.source ? { source: input.source } : {}),
      ...(input.identitySource ? { identitySource: input.identitySource } : {}),
    })
    const claim = (result.identityClaims[slug] ?? []).find(
      (c) => c.value === norm,
    )
    const outcome = claim?.outcome
    return {
      outcome:
        outcome === 'added' || outcome === 'suggested_duplicate'
          ? outcome
          : 'already_own',
    }
  })
}
