import { Effect } from 'effect'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attributeEvent, entity, integration } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { Json } from '@spaces/db/json'
import { Receipts } from '@spaces/sdk'
import { toObjectKind } from '../../attributes/registry'
import { ref } from '../../context/ref'
import { decide, enrichedLine, linksOf, written } from '../../enrichment/plan'
import type {
  Decision,
  FieldDecision,
  Holding,
  Link,
  SourceAnswer,
} from '../../enrichment/plan'
import { jsonRecord, jsonString } from '../../json'
import { objectIdForKindAsync } from '../attributes/objects'
import {
  EntityNotFound,
  getRegistryByObjectId,
  setValuesInTx,
} from '../attributes/values'
import type { Tx } from '../attributes/values'
import type { EmbedSource } from '../ai/chunk-sources'
import { INTEGRATION_CONFIDENCE } from '../ports/judgment'
import { ReceiptsLive } from '../ports/receipts'
import { SuggestionInvalid, proposeWith } from '../suggestions/propose'

/**
 * Applies one enrichment run's answers to a record (D76), in one
 * transaction under the entity row lock: the decision is made against the
 * values the lock returned, never a read before it.
 * - Each source's winning fields are written as that source, citing its
 *   receipt; a person's disagreements become one card for the record.
 * - After the commit: the run's receipt (every answer, the losers, the
 *   unlinked keys and each replaced figure with its date) through the
 *   Receipts port on the host's `core.enrichment` row, then one timeline
 *   line naming the sources, the field count and the credits.
 */

/** The host's own integration row: what a run's receipt is bound to. */
export const ENRICHMENT_CAPABILITY = 'core.enrichment'

/** One source the run asked, with what it was asked and what it spent. */
export type RunSource = {
  readonly integrationId: string
  /** The keys it was asked for; null when it answered unasked (its own button). */
  readonly asked: ReadonlyArray<string> | null
  readonly credits: number
  /** Why it was not asked, when it was not. */
  readonly skipped?: string
}

export type RunInput = {
  readonly entityId: string
  readonly reason: string
  readonly sources: ReadonlyArray<RunSource>
  readonly answers: ReadonlyArray<SourceAnswer>
}

export type RunApplied = {
  readonly fields: number
  readonly credits: number
  readonly suggestionId: string | null
  readonly receiptId: string
  readonly reembed: ReadonlyArray<EmbedSource>
}

/** The registry's linked attributes for a record, or [] for a custom object. */
export async function linksForEntity(
  entityId: string,
  on: Tx | typeof db = db,
): Promise<{ links: Array<Link>; kind: 'company' | 'person' | null }> {
  const row = (
    await on
      .select({ kind: entity.kind, objectId: entity.objectId })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)
  if (row === undefined)
    throw new EntityNotFound({ entityId, message: 'Entity not found' })
  const core = toObjectKind(row.kind)
  const kind = core === 'company' || core === 'person' ? core : null
  const objectId =
    row.objectId ?? (core === null ? null : await objectIdForKindAsync(core))
  if (kind === null || objectId === null) return { links: [], kind }
  return { links: linksOf(await getRegistryByObjectId(objectId)), kind }
}

/** What each linked slug holds and who wrote it last, with when. */
export async function holdingsOf(
  on: Tx | typeof db,
  entityId: string,
  values: { readonly [slug: string]: Json },
  links: ReadonlyArray<Link>,
): Promise<Map<string, Holding>> {
  const slugs = links.map((l) => l.def.slug)
  const holdings = new Map<string, Holding>()
  if (slugs.length === 0) return holdings
  const events = await on
    .selectDistinctOn([attributeEvent.attrSlug], {
      slug: attributeEvent.attrSlug,
      actorType: attributeEvent.actorType,
      actorRef: attributeEvent.actorRef,
      at: attributeEvent.at,
    })
    .from(attributeEvent)
    .where(
      and(
        eq(attributeEvent.entityId, entityId),
        inArray(attributeEvent.attrSlug, slugs),
      ),
    )
    .orderBy(attributeEvent.attrSlug, desc(attributeEvent.at))
  for (const slug of slugs) {
    const last = events.find((e) => e.slug === slug)
    holdings.set(slug, {
      value: values[slug] ?? null,
      writer:
        last === undefined
          ? null
          : { type: last.actorType, integrationId: last.actorRef },
      at: last?.at.toISOString() ?? null,
    })
  }
  return holdings
}

/** Display names by integration id: the manifest's name, else the capability. */
async function sourceNames(ids: ReadonlyArray<string>) {
  if (ids.length === 0) return new Map<string, string>()
  const rows = await db
    .select({
      id: integration.id,
      capabilityId: integration.capabilityId,
      manifest: integration.manifest,
    })
    .from(integration)
    .where(inArray(integration.id, [...ids]))
  return new Map(
    rows.map((r) => [
      r.id,
      jsonString(jsonRecord(r.manifest).name) ?? r.capabilityId,
    ]),
  )
}

/** The host's `core.enrichment` row, made on first use. */
async function enrichmentRow() {
  const held = (
    await db
      .select({ id: integration.id, capabilityId: integration.capabilityId })
      .from(integration)
      .where(eq(integration.capabilityId, ENRICHMENT_CAPABILITY))
      .orderBy(asc(integration.createdAt))
      .limit(1)
  ).at(0)
  if (held !== undefined) return held
  const made = (
    await db
      .insert(integration)
      .values({
        capabilityId: ENRICHMENT_CAPABILITY,
        version: '1',
        enabled: true,
        status: 'enabled',
      })
      .returning({ id: integration.id, capabilityId: integration.capabilityId })
  ).at(0)
  if (made === undefined) throw new Error('integration insert returned no row')
  return made
}

const describe = (value: Json) => JSON.stringify(value)

/** One card listing every field a person holds that a source disagrees with. */
async function raiseCard(
  tx: Tx,
  entityId: string,
  disagreements: ReadonlyArray<FieldDecision>,
  names: ReadonlyMap<string, string>,
): Promise<string | null> {
  const first = disagreements.at(0)
  if (first === undefined) return null
  const payload: { [slug: string]: Json } = {}
  for (const f of disagreements)
    payload[f.slug] = {
      value: f.value,
      refs: [ref.event(f.receiptId)],
      confidence: INTEGRATION_CONFIDENCE,
    }
  const rationale = disagreements
    .map(
      (f) =>
        `${f.slug}: ${names.get(f.integrationId) ?? f.integrationId} says ${describe(f.value)}; the record holds ${describe(f.previous?.value ?? null)}`,
    )
    .join('\n')
  try {
    const row = await proposeWith(tx, {
      entityId,
      kind: 'attribute_patch',
      payload,
      rationale,
      refs: [...new Set(disagreements.map((f) => ref.event(f.receiptId)))],
      proposedBy: { type: 'integration', id: first.integrationId },
    })
    return row.id
  } catch (cause) {
    if (cause instanceof SuggestionInvalid) return null
    throw cause
  }
}

/** The receipt of the run: every answer and what became of it. */
const runReceipt = (
  input: RunInput,
  decision: Decision,
  names: ReadonlyMap<string, string>,
  suggestionId: string | null,
): Json => ({
  run: 'enrichment',
  reason: input.reason,
  sources: input.sources.map((s) => ({
    integrationId: s.integrationId,
    name: names.get(s.integrationId) ?? s.integrationId,
    asked: s.asked === null ? null : [...s.asked],
    credits: s.credits,
    ...(s.skipped === undefined ? {} : { skipped: s.skipped }),
  })),
  fields: decision.fields.map((f) => ({
    key: f.key,
    slug: f.slug,
    integrationId: f.integrationId,
    receiptId: f.receiptId,
    value: f.value,
    asOf: f.asOf,
    outcome: f.outcome,
    ...(f.previous === undefined
      ? {}
      : {
          previous: {
            value: f.previous.value,
            at: f.previous.at,
            integrationId: f.previous.integrationId,
          },
        }),
  })),
  losers: decision.losers.map((a) => ({ ...a })),
  unlinked: decision.unlinked.map((a) => ({ ...a })),
  suggestionId,
})

/**
 * Apply a run. Throws `EntityNotFound` for a record that is gone and
 * `AttributeValidationError` only for a value the validator let through
 * `decide` and the write path refused.
 */
export async function applyRun(input: RunInput): Promise<RunApplied> {
  const { entityId } = input
  const ids = [
    ...new Set([
      ...input.sources.map((s) => s.integrationId),
      ...input.answers.map((a) => a.integrationId),
    ]),
  ]
  const names = await sourceNames(ids)
  const applied = await db.transaction(async (tx) => {
    const ent = (
      await tx
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, entityId))
        .for('update')
    ).at(0)
    if (ent === undefined)
      throw new EntityNotFound({ entityId, message: 'Entity not found' })
    const { links } = await linksForEntity(entityId, tx)
    const holdings = await holdingsOf(tx, entityId, ent.values, links)
    const decision = decide(links, holdings, input.answers)
    const reembed: Array<EmbedSource> = []
    for (const source of ids) {
      const fields = written(decision).filter((f) => f.integrationId === source)
      if (fields.length === 0) continue
      const result = await setValuesInTx(tx, {
        entityId,
        patch: Object.fromEntries(fields.map((f) => [f.slug, f.value])),
        actor: { type: 'integration', id: source },
        source: 'enrichment',
        refs: [...new Set(fields.map((f) => ref.event(f.receiptId)))],
      })
      reembed.push(...result.reembed)
    }
    const card = await raiseCard(
      tx,
      entityId,
      decision.fields.filter((f) => f.outcome === 'person'),
      names,
    )
    return { decision, suggestionId: card, reembed }
  })
  const { decision, suggestionId, reembed } = applied

  const row = await enrichmentRow()
  const { receiptId } = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Receipts).store({
        entityId,
        raw: runReceipt(input, decision, names, suggestionId),
      })
    }).pipe(Effect.provide(ReceiptsLive(row))),
  )
  const fields = written(decision).length
  const credits = input.sources.reduce((sum, s) => sum + s.credits, 0)
  const sources = input.sources
    .filter((s) => s.skipped === undefined)
    .map((s) => names.get(s.integrationId) ?? s.integrationId)
  await db.insert(activity).values({
    verb: 'entity.enriched',
    subjectEntityId: entityId,
    meta: {
      line: enrichedLine({ sources, fields, credits }),
      sources,
      fields,
      credits,
      receiptId,
      ...(suggestionId === null ? {} : { suggestionId }),
    },
  })
  return { fields, credits, suggestionId, receiptId, reembed }
}
