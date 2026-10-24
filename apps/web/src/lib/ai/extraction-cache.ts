import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { extractionCache } from '@spaces/db/schema'
import type { JsonSchema } from '@spaces/core/ai/schema'
import type { ContextItem } from '@spaces/core/context/types'
import { jsonValue } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'
import { completeProgram, laneTargetProgram } from './complete'
import type {
  CompleteFailure,
  CompleteOptions,
  CompleteOutput,
} from './complete'
import type { AiTarget } from './route'

/**
 * The extraction cache's read-through for extract-lane calls over a
 * document's bytes: a hit returns the stored answer with no provider call (so
 * no `ai_usage` row); a miss calls, stores and returns. It sits beside the
 * extract call, not inside `complete()`, which cannot know its items are one
 * blob's text. Key parts, each guarding one kind of staleness:
 * - `blob_sha`: the bytes, not the `document` row, so one blob filed twice is read once.
 * - `schema_key`: `extractionSchemaKey`, so a registry change misses.
 * - `model_id`: the lane's current route, so re-routing re-asks.
 * - The routing policy runs on a hit too (a now-sensitive record is refused);
 *   the spend cap does not. Not the in-process query-embedding cache; never merge them.
 */

/** Stands in for the reading document's id inside a stored answer. */
const DOCUMENT_PLACEHOLDER = '$document'

/** A stable serialisation: object keys sorted, arrays in order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical(Reflect.get(value, k) ?? null)}`,
      )
      .join(',')}}`
  return value === undefined ? 'null' : JSON.stringify(value)
}

/**
 * The digest of what the model is asked to fill: the compiled registry schema
 * (`schemaFor`) under a purpose that names the feature and its prompt's
 * version. Any change to the registry the schema carries — an attribute, an
 * option, a description — is a different key; two features that happen to
 * compile the same schema are not.
 */
export function extractionSchemaKey(
  purpose: string,
  schema: JsonSchema,
): string {
  return createHash('sha256')
    .update(canonical({ purpose, schema }))
    .digest('hex')
}

/** The routed target as the cache keys it — provider-qualified. */
export const extractionModelId = (target: AiTarget): string =>
  `${target.provider}:${target.model}`

/** Every string in `value`, `doc:<from>#…` rewritten to `doc:<to>#…`. */
function reDocument(value: Json, from: string, to: string): Json {
  if (typeof value === 'string')
    return value.startsWith(`doc:${from}#`)
      ? `doc:${to}#${value.slice(`doc:${from}#`.length)}`
      : value
  if (Array.isArray(value)) return value.map((v) => reDocument(v, from, to))
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, reDocument(v, from, to)]),
    )
  return value
}

/**
 * A stored answer, its citations narrowed to what this read would have shown
 * the model. The answer may have been read through another document row over
 * the same blob, or against another record's context; a ref neither this
 * deck nor this record's context carries is dropped rather than cited.
 */
function citedOnly(value: Json, known: ReadonlySet<string>): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return value
  return Object.fromEntries(
    Object.entries(value).map(([slug, field]) => {
      if (typeof field !== 'object' || field === null || Array.isArray(field))
        return [slug, field]
      const refs = field.refs
      return [
        slug,
        Array.isArray(refs)
          ? {
              ...field,
              refs: refs.filter((r) => typeof r === 'string' && known.has(r)),
            }
          : field,
      ]
    }),
  )
}

export type ExtractSource = {
  /** The bytes the context was read from; null reads straight through. */
  blobSha: string | null
  /** The document reading them — its citations are stored blob-relative. */
  documentId: string
  /** The feature and its prompt version, e.g. `read-deck/v1`. */
  purpose: string
}

export type CachedExtractResult = {
  output: CompleteOutput
  target: AiTarget
  /** When the stored answer was written — null when this run called. */
  cachedAt: string | null
  /** What the call reported; both null on a hit, which made no call. */
  usage: { tokensIn: number | null; tokensOut: number | null }
  /** The key the call resolved; null on a hit or for an injected model. */
  credentialId: string | null
}

const NO_CALL = {
  usage: { tokensIn: null, tokensOut: null },
  credentialId: null,
} as const

export const cachedExtractProgram = Effect.fn('cachedExtract')(function* (
  source: ExtractSource,
  items: ReadonlyArray<ContextItem>,
  schema: JsonSchema,
  opts: CompleteOptions,
): Effect.fn.Return<CachedExtractResult, CompleteFailure> {
  const { blobSha, documentId } = source
  if (blobSha === null) {
    const answered = yield* completeProgram('extract', items, schema, opts)
    return {
      output: answered.output,
      target: answered.target,
      cachedAt: null,
      usage: answered.usage,
      credentialId: answered.credentialId,
    }
  }

  const target = yield* laneTargetProgram('extract', opts)
  const schemaKey = extractionSchemaKey(source.purpose, schema)
  const modelId = extractionModelId(target)
  const key = and(
    eq(extractionCache.blobSha, blobSha),
    eq(extractionCache.schemaKey, schemaKey),
    eq(extractionCache.modelId, modelId),
  )

  // A cache that cannot be read is a miss, not a failure: the call it would
  // have saved is still there to make.
  const hit = yield* Effect.tryPromise(() =>
    db
      .select({ patch: extractionCache.patch, at: extractionCache.at })
      .from(extractionCache)
      .where(key),
  ).pipe(
    Effect.map((rows) => rows.at(0)),
    Effect.catch((error) =>
      Effect.logWarning('extraction cache read failed; calling', error).pipe(
        Effect.as(undefined),
      ),
    ),
  )
  if (hit !== undefined) {
    const known = new Set(items.map((i) => i.ref))
    return {
      output: {
        kind: 'object',
        object: citedOnly(
          reDocument(hit.patch, DOCUMENT_PLACEHOLDER, documentId),
          known,
        ),
      },
      target,
      cachedAt: hit.at.toISOString(),
      ...NO_CALL,
    }
  }

  const answered = yield* completeProgram('extract', items, schema, {
    ...opts,
    route: target,
  })
  const stored =
    answered.output.kind === 'object'
      ? jsonValue.safeParse(answered.output.object)
      : null
  if (stored?.success === true)
    yield* Effect.tryPromise(() =>
      db
        .insert(extractionCache)
        .values({
          blobSha,
          schemaKey,
          modelId,
          patch: reDocument(stored.data, documentId, DOCUMENT_PLACEHOLDER),
        })
        // Two reads of one blob racing each other asked the same question;
        // the first answer stored is as good as the second.
        .onConflictDoNothing(),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning('extraction cache write failed', error),
      ),
    )
  return {
    output: answered.output,
    target: answered.target,
    cachedAt: null,
    usage: answered.usage,
    credentialId: answered.credentialId,
  }
})
