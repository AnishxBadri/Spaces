import { Effect } from 'effect'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attributeEvent,
  entity,
  entitySpace,
  integration,
  pendingBlob,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { Json } from '@spaces/db/json'
import { ENRICHMENT_VOCABULARY, Receipts, isVocabularyKey } from '@spaces/sdk'
import { toObjectKind } from '../../attributes/registry'
import { ref } from '../../context/ref'
import {
  companyDomainOf,
  decide,
  enrichedLine,
  linksOf,
  written,
} from '../../enrichment/plan'
import { WEBSITE_NAME } from '../../enrichment/website'
import type { SkipNote } from '../../enrichment/sources'
import {
  PICTURE_NAMES,
  PICTURE_KEYS,
  isPictureKey,
} from '../../enrichment/picture'
import type { PictureRefusal } from '../../enrichment/picture'
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
import { previewResolve } from '../entities/resolve'
import { DiscoverSpaceRefused, discoverWith } from '../ports/discover'
import { INTEGRATION_CONFIDENCE } from '../ports/judgment'
import { ReceiptsLive } from '../ports/receipts'
import { SuggestionInvalid, proposeWith } from '../suggestions/propose'
import type { PictureFetched } from './picture'

/**
 * Applies one enrichment run's answers to a record, in one
 * transaction under the entity row lock: the decision is made against the
 * values the lock returned, never a read before it.
 * - Each source's winning fields are written as that source, citing its
 *   receipt; a person's disagreements become one card for the record.
 * - A stored picture is set in the same transaction, only while the
 *   record has none and no person held it; its `pending_blob` row goes then.
 * - A company answer is looked up by its domain before the transaction and
 *   never resolved into a new record. An empty link to a company nobody
 *   holds becomes one add card per space the record is filed in, after the
 *   commit, proposed by the answering source; a record filed nowhere gets
 *   none, and the receipt says so.
 * - After the commit: the run's receipt (every answer, the losers, the
 *   unlinked keys, the picture, the add cards and each replaced figure with
 *   its date) through the Receipts port on the host's `core.enrichment`
 *   row, then one timeline line naming the sources, the field count and the
 *   credits.
 */

/** The host's own integration row: what a run's receipt is bound to, and the Website source's identity. */
export const ENRICHMENT_CAPABILITY = 'core.enrichment'

/** One source the run asked, with what it was asked and what it spent. */
export type RunSource = {
  readonly integrationId: string
  /** The keys it was asked for; null when it answered unasked (its own button). */
  readonly asked: ReadonlyArray<string> | null
  readonly credits: number
  /** Why it was not asked, when it was not. */
  readonly skipped?: string
  /** The skip in the run's timeline line, when the owner should see it ("sensitive"). */
  readonly line?: string
  /** Its name on the timeline line when it says which part ran ("Website (markup)"). */
  readonly name?: string
  /** A part it skipped that the owner should see, though it ran. */
  readonly notes?: ReadonlyArray<SkipNote>
}

export type RunInput = {
  readonly entityId: string
  readonly reason: string
  readonly sources: ReadonlyArray<RunSource>
  readonly answers: ReadonlyArray<SourceAnswer>
  /** The run's picture answer, fetched; null when none was wanted or given. */
  readonly picture?: PictureFetched | null
}

/** What became of an unknown company's add card in one space, or why none was made. */
export type CompanyCard = {
  readonly key: string
  readonly name: string
  readonly domain: string
  readonly integrationId: string
  readonly spaceId: string | null
  /** `proposed`, `merged`, `dismissed`, `member`, or why no card was made. */
  readonly outcome: string
  readonly suggestionId?: string
}

/** What became of the picture: set, found taken under the lock, or refused. */
export type PictureOutcome = 'set' | 'taken' | PictureRefusal

export type RunApplied = {
  readonly fields: number
  readonly credits: number
  readonly suggestionId: string | null
  readonly receiptId: string
  readonly reembed: ReadonlyArray<EmbedSource>
  readonly picture: PictureOutcome | null
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

/** Display names by integration id: the Website for the host's row, the manifest's name, else the capability. */
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
      r.capabilityId === ENRICHMENT_CAPABILITY
        ? WEBSITE_NAME
        : (jsonString(jsonRecord(r.manifest).name) ?? r.capabilityId),
    ]),
  )
}

/** The host's `core.enrichment` row, made on first use: the run's receipts and the Website source. */
export async function enrichmentRow() {
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
  picture: PictureOutcome | null,
  cards: ReadonlyArray<CompanyCard>,
): Json => ({
  run: 'enrichment',
  reason: input.reason,
  sources: input.sources.map((s) => ({
    integrationId: s.integrationId,
    name: s.name ?? names.get(s.integrationId) ?? s.integrationId,
    asked: s.asked === null ? null : [...s.asked],
    credits: s.credits,
    ...(s.skipped === undefined ? {} : { skipped: s.skipped }),
    ...(s.line === undefined ? {} : { line: s.line }),
    ...(s.notes === undefined ? {} : { notes: s.notes.map((n) => ({ ...n })) }),
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
  unlinked: decision.unlinked
    .filter((a) => !isPictureKey(a.key))
    .map((a) => ({ ...a })),
  picture:
    input.picture == null || picture === null
      ? null
      : {
          key: input.picture.key,
          url: input.picture.url,
          integrationId: input.picture.integrationId,
          receiptId: input.picture.receiptId,
          outcome: picture,
          ...(input.picture.outcome === 'stored'
            ? { sha: input.picture.sha }
            : { reason: input.picture.reason }),
        },
  suggestionId,
  ...(cards.length === 0 ? {} : { cards: cards.map((c) => ({ ...c })) }),
})

/** Set a stored picture while the record has none and no person held it. */
async function setPicture(
  tx: Tx,
  entityId: string,
  fetched: PictureFetched | null | undefined,
): Promise<PictureOutcome | null> {
  if (fetched == null) return null
  if (fetched.outcome === 'refused') return fetched.why
  const took = await tx
    .update(entity)
    .set({ pictureSha: fetched.sha })
    .where(
      and(
        eq(entity.id, entityId),
        isNull(entity.pictureSha),
        eq(entity.pictureHeld, false),
      ),
    )
    .returning({ id: entity.id })
  if (took.length === 0) return 'taken'
  await tx.delete(pendingBlob).where(eq(pendingBlob.sha, fetched.sha))
  return 'set'
}

/** Each company answer's domain → the company holding it, by identity only. */
async function heldCompanies(
  answers: ReadonlyArray<SourceAnswer>,
): Promise<Map<string, string>> {
  const domains = new Set(
    answers.flatMap((a) =>
      Object.entries(a.answers).flatMap(([key, value]) =>
        isVocabularyKey(key) && ENRICHMENT_VOCABULARY[key].type === 'company'
          ? (companyDomainOf(value) ?? [])
          : [],
      ),
    ),
  )
  const held = new Map<string, string>()
  for (const domain of domains) {
    const found = await previewResolve({ kind: 'company', keys: { domain } })
    if (found.verdict === 'attach') held.set(domain, found.entityId)
  }
  return held
}

const nameOfCompany = (value: Json, domain: string): string => {
  const name =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value.name
      : null
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : domain
}

/**
 * One add card per space the record is filed in, for each unknown company,
 * through the same checks a watch's find passes (dismissed, member, open
 * card). A space that takes no cards is noted, not fatal.
 */
async function proposeCompanies(
  entityId: string,
  unknown: ReadonlyArray<FieldDecision>,
): Promise<Array<CompanyCard>> {
  if (unknown.length === 0) return []
  const spaces = (
    await db
      .select({ spaceId: entitySpace.spaceId })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, entityId))
  ).map((r) => r.spaceId)
  const cards: Array<CompanyCard> = []
  for (const field of unknown) {
    const domain = companyDomainOf(field.value)
    if (domain === null) continue
    const base = {
      key: field.key,
      name: nameOfCompany(field.value, domain),
      domain,
      integrationId: field.integrationId,
    }
    if (spaces.length === 0) {
      cards.push({ ...base, spaceId: null, outcome: 'not filed in a space' })
      continue
    }
    for (const spaceId of spaces) {
      try {
        const found = await discoverWith({
          claim: {
            spaceId,
            name: base.name,
            domain,
            evidence: [],
            refs: [`event:${field.receiptId}`],
          },
          proposedBy: { type: 'integration', id: field.integrationId },
          watchId: null,
        })
        cards.push({
          ...base,
          spaceId,
          outcome: found.outcome,
          ...(found.outcome === 'proposed' || found.outcome === 'merged'
            ? { suggestionId: found.suggestion.id }
            : {}),
        })
      } catch (cause) {
        if (
          !(cause instanceof DiscoverSpaceRefused) &&
          !(cause instanceof SuggestionInvalid)
        )
          throw cause
        cards.push({
          ...base,
          spaceId,
          outcome:
            cause instanceof DiscoverSpaceRefused
              ? cause.reason
              : cause.message,
        })
      }
    }
  }
  return cards
}

const pictureName = (key: string) =>
  key === PICTURE_KEYS.person ? PICTURE_NAMES.person : PICTURE_NAMES.company

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
  const companies = await heldCompanies(input.answers)
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
    const decision = decide(links, holdings, input.answers, companies)
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
    const picture = await setPicture(tx, entityId, input.picture)
    return { decision, suggestionId: card, reembed, picture }
  })
  const { decision, suggestionId, reembed, picture } = applied
  const cards = await proposeCompanies(
    entityId,
    decision.fields.filter((f) => f.outcome === 'unknown'),
  )

  const row = await enrichmentRow()
  const { receiptId } = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Receipts).store({
        entityId,
        raw: runReceipt(input, decision, names, suggestionId, picture, cards),
      })
    }).pipe(Effect.provide(ReceiptsLive(row))),
  )
  const fields = written(decision).length
  const credits = input.sources.reduce((sum, s) => sum + s.credits, 0)
  const nameOf = (s: RunSource) =>
    s.name ?? names.get(s.integrationId) ?? s.integrationId
  const sources = input.sources
    .filter((s) => s.skipped === undefined)
    .map(nameOf)
  const skipped = [
    ...input.sources.flatMap((s) =>
      s.skipped === undefined || s.line === undefined
        ? []
        : [{ name: nameOf(s), why: s.line }],
    ),
    ...input.sources.flatMap((s) => s.notes ?? []),
    ...(input.picture?.outcome === 'refused'
      ? [{ name: pictureName(input.picture.key), why: input.picture.why }]
      : []),
  ]
  const pictureSet =
    picture === 'set' && input.picture != null
      ? pictureName(input.picture.key).toLowerCase()
      : null
  await db.insert(activity).values({
    verb: 'entity.enriched',
    subjectEntityId: entityId,
    meta: {
      line: enrichedLine({
        sources,
        fields,
        credits,
        skipped,
        ...(pictureSet === null ? {} : { picture: pictureSet }),
      }),
      sources,
      fields,
      credits,
      receiptId,
      ...(skipped.length === 0 ? {} : { skipped }),
      ...(suggestionId === null ? {} : { suggestionId }),
      ...(picture === null ? {} : { picture }),
    },
  })
  return { fields, credits, suggestionId, receiptId, reembed, picture }
}
