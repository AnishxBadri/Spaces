import { Context, Effect, Layer, Schema } from 'effect'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, space } from '@spaces/db/schema'
import { Discover, JobPermanent, JobRetryable } from '@spaces/sdk'
import type { DiscoverClaim } from '@spaces/sdk'
import { parseRef } from '../../context/ref'
import type { Json } from '../../json'
import { normalizeDomain } from '@spaces/sdk/identity'
import type { Actor } from '../attributes/values'
import { EntityNotFound } from '../attributes/values'
import { previewResolve } from '../entities/resolve'
import type {
  PreviewResolveInput,
  PreviewResolveResult,
} from '../entities/resolve'
import {
  SuggestionInvalid,
  asFailure,
  invalid,
  isDismissed,
  proposeDiscoveryWith,
} from '../suggestions/propose'
import type { Suggestion, SuggestionFailure } from '../suggestions/propose'
import type { BoundIntegration } from './binding'

/**
 * DiscoverLive: a watch's hand-back, one candidate company for its space.
 * Every candidate passes three checks, in this order:
 * - **dismissed**: a domain dismissed from the space returns at once,
 *   before any identity lookup;
 * - **member**: `previewResolve` over the identity normalizers — held and
 *   filed in the space or a descendant is dropped, held elsewhere is a
 *   `file_record` card, unknown an `add_record` card;
 * - **open card**: the propose path merges into the space's open card for
 *   the domain rather than proposing again.
 * The proposer is the bound integration and the finding watch is the one
 * the host bound this invocation to — never anything the claim says.
 */

/** What a candidate came to. */
export type Discovered =
  | { outcome: 'dismissed' }
  | { outcome: 'member'; entityId: string }
  | { outcome: 'proposed' | 'merged'; suggestion: Suggestion }

export type DiscoverInput = {
  readonly claim: DiscoverClaim
  /** Who proposes: the bound integration, or the person who asked (Find). */
  readonly proposedBy: Actor
  /** The watch that found it; null for a find with no watch. */
  readonly watchId: string | null
}

/** The identity lookup the member check runs; a test hands in a spy. */
export type DiscoverDeps = {
  readonly preview: (
    input: PreviewResolveInput,
  ) => Promise<PreviewResolveResult>
}

const liveDeps: DiscoverDeps = { preview: previewResolve }

/** Refused: the space is gone, merged away or archived. Cards stop. */
export class DiscoverSpaceRefused extends Schema.TaggedError<DiscoverSpaceRefused>()(
  'DiscoverSpaceRefused',
  { spaceId: Schema.String, reason: Schema.String },
) {}

/** The space's ltree path when it is live; null when it is not. */
async function livePath(spaceId: string): Promise<string | null> {
  const row = (
    await db
      .select({ path: space.path })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        and(
          eq(space.entityId, spaceId),
          isNull(entity.mergedIntoId),
          sql`not exists (
            select 1 from space arch
            where arch.path @> ${space.path} and arch.archived_at is not null
          )`,
        ),
      )
  ).at(0)
  return row?.path ?? null
}

/** Whether the record is filed in the space at `path` or any descendant. */
async function filedUnder(entityId: string, path: string): Promise<boolean> {
  const hit = (
    await db
      .select({ id: entitySpace.spaceId })
      .from(entitySpace)
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .where(
        and(
          eq(entitySpace.entityId, entityId),
          sql`${space.path} <@ ${path}::ltree`,
        ),
      )
      .limit(1)
  ).at(0)
  return hit !== undefined
}

/**
 * Where a candidate stands against what is held, read only — the checks a
 * card would pass, without proposing one. Ask's Find table reads its rows
 * through it.
 * - With a space: dismissed from it, filed in it or below, held elsewhere,
 *   or unknown.
 * - Without one (`path` null): held or unknown; nothing is dismissed and
 *   nothing filed.
 */
export type Standing =
  | { standing: 'dismissed' }
  | { standing: 'filed'; entityId: string }
  | { standing: 'held'; entityId: string }
  | { standing: 'unknown' }

async function standingOf(
  candidate: { name: string; domain: string },
  within: { id: string; path: string } | null,
  deps: DiscoverDeps,
): Promise<Standing> {
  if (within !== null && (await isDismissed(db, within.id, candidate.domain)))
    return { standing: 'dismissed' }
  const preview = await deps.preview({
    kind: 'company',
    name: candidate.name,
    keys: { domain: candidate.domain },
  })
  if (preview.verdict === 'refused')
    throw invalid([{ slug: 'domain', message: preview.reason }])
  if (preview.verdict === 'create') return { standing: 'unknown' }
  return within !== null && (await filedUnder(preview.entityId, within.path))
    ? { standing: 'filed', entityId: preview.entityId }
    : { standing: 'held', entityId: preview.entityId }
}

/**
 * One found company's standing for a space, or for none. A space that is
 * gone, merged away or archived reads as none; a domain that names no
 * company is refused.
 */
export async function standingWith(
  candidate: { name: string; domain: string; spaceId: string | null },
  deps: DiscoverDeps = liveDeps,
): Promise<Standing> {
  const domain = normalizeDomain(candidate.domain)
  if (domain === null)
    throw invalid([
      {
        slug: 'domain',
        message: `domain: ${candidate.domain} names no company`,
      },
    ])
  const path =
    candidate.spaceId === null ? null : await livePath(candidate.spaceId)
  return standingOf(
    { name: candidate.name, domain },
    candidate.spaceId === null || path === null
      ? null
      : { id: candidate.spaceId, path },
    deps,
  )
}

/**
 * Run one candidate through the three checks and, when it survives them,
 * propose or merge its card. Throws the propose path's typed refusals, and
 * `DiscoverSpaceRefused` for a space that takes no cards.
 */
export async function discoverWith(
  input: DiscoverInput,
  deps: DiscoverDeps = liveDeps,
): Promise<Discovered> {
  const { claim } = input
  const domain = normalizeDomain(claim.domain)
  if (domain === null)
    throw invalid([
      { slug: 'domain', message: `domain: ${claim.domain} names no company` },
    ])
  const path = await livePath(claim.spaceId)
  if (path === null)
    throw new DiscoverSpaceRefused({
      spaceId: claim.spaceId,
      reason: 'the space is missing, merged away or archived',
    })
  const standing = await standingOf(
    { name: claim.name, domain },
    { id: claim.spaceId, path },
    deps,
  )
  if (standing.standing === 'dismissed') return { outcome: 'dismissed' }
  if (standing.standing === 'filed')
    return { outcome: 'member', entityId: standing.entityId }

  const evidence: Array<Json> = claim.evidence.map((e) =>
    e.title === undefined ? { url: e.url } : { url: e.url, title: e.title },
  )
  const common = {
    spaceId: claim.spaceId,
    domain,
    name: claim.name,
    evidence,
    watchIds: input.watchId === null ? [] : [input.watchId],
  }
  const proposed = await proposeDiscoveryWith(db, {
    ...(standing.standing === 'held'
      ? {
          kind: 'file_record',
          payload: { ...common, entityId: standing.entityId },
        }
      : {
          kind: 'add_record',
          payload: {
            ...common,
            aliases: [...(claim.aliases ?? [])],
            subspaceHint: claim.subspaceHint ?? null,
          },
        }),
    refs: [...(claim.refs ?? [])],
    proposedBy: input.proposedBy,
  })
  return proposed
}

export const standingProgram = Effect.fn('standingProgram')(function* (
  candidate: { name: string; domain: string; spaceId: string | null },
  deps?: DiscoverDeps,
): Effect.fn.Return<Standing, SuggestionFailure> {
  return yield* Effect.tryPromise({
    try: () => standingWith(candidate, deps),
    catch: asFailure,
  })
})

export const discoverProgram = Effect.fn('discoverProgram')(function* (
  input: DiscoverInput,
  deps?: DiscoverDeps,
): Effect.fn.Return<Discovered, SuggestionFailure | DiscoverSpaceRefused> {
  return yield* Effect.tryPromise({
    try: () => discoverWith(input, deps),
    catch: (cause) =>
      cause instanceof DiscoverSpaceRefused ? cause : asFailure(cause),
  })
})

/** The watch run a `Discover` is bound to: its watch and its space. */
export type DiscoverBinding = {
  readonly watchId: string
  readonly spaceId: string
}

/** The host's handle on a built DiscoverLive: a `Discover` bound to one watch run. */
export class DiscoverBinder extends Context.Service<
  DiscoverBinder,
  { readonly bind: (watch: DiscoverBinding | null) => Discover['Service'] }
>()('spaces/core/writes/ports/DiscoverBinder') {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const toJobError = (
  cause: SuggestionFailure | DiscoverSpaceRefused,
): JobPermanent | JobRetryable => {
  if (cause instanceof DiscoverSpaceRefused)
    return new JobPermanent({
      reason: `Discover.candidate: ${cause.reason}`,
    })
  if (cause instanceof SuggestionInvalid || cause instanceof EntityNotFound)
    return new JobPermanent({
      reason: `Discover.candidate: ${cause.message}`,
    })
  return new JobRetryable({
    reason: `Discover.candidate failed: ${cause._tag === 'SuggestionWriteFailed' && cause.cause instanceof Error ? cause.cause.message : cause._tag}`,
  })
}

/**
 * The Layer for one (integration, job). `Discover` as built answers only a
 * watch run: the host replaces it per invocation with
 * `DiscoverBinder.bind({ watchId, spaceId })`, and a claim about any other
 * space is refused permanently.
 */
export const DiscoverLive = (
  row: Pick<BoundIntegration, 'id'>,
  deps: DiscoverDeps = liveDeps,
): Layer.Layer<Discover | DiscoverBinder> => {
  const proposedBy: Actor = { type: 'integration', id: row.id }
  const bind = (watch: DiscoverBinding | null): Discover['Service'] =>
    Discover.of({
      candidate: Effect.fn('Discover.candidate')(function* (
        claim: DiscoverClaim,
      ) {
        if (watch === null)
          return yield* new JobPermanent({
            reason:
              'Discover.candidate: only a watch run hands back candidates',
          })
        if (claim.spaceId !== watch.spaceId || !UUID.test(claim.spaceId))
          return yield* new JobPermanent({
            reason: `Discover.candidate: this run watches space ${watch.spaceId}, not ${claim.spaceId}`,
          })
        const unparsed = (claim.refs ?? []).filter((r) => parseRef(r) === null)
        if (unparsed.length > 0)
          return yield* new JobPermanent({
            reason: `Discover.candidate: not a ref: ${unparsed.join(', ')}`,
          })
        const found = yield* discoverProgram(
          { claim, proposedBy, watchId: watch.watchId },
          deps,
        ).pipe(Effect.mapError(toJobError))
        return {
          suggestionId:
            found.outcome === 'proposed' || found.outcome === 'merged'
              ? found.suggestion.id
              : null,
        }
      }),
    })
  return Layer.succeedContext(
    Context.make(Discover, bind(null)).pipe(
      Context.add(DiscoverBinder, DiscoverBinder.of({ bind })),
    ),
  )
}
