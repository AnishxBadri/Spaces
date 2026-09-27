import { Readable } from 'node:stream'
import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note, objectDef } from '@spaces/db/schema'
import { MAX_CAPTURE_BYTES, formatBytes } from '@spaces/core/documents'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
} from '#/lib/documents/intake'
import type { DocumentIntakeFailure } from '#/lib/documents/intake'
import { DocumentBirthRejected } from '#/lib/documents/birth'
import { enqueueCaptureReadProgram } from '#/lib/ai/read-deck'
import type { CaptureReadQueued } from '#/lib/ai/read-deck'
import { resolveEntityRefProgram } from '#/lib/mcp/tools'
import { listRegistryProgram } from '#/lib/mcp/tools-read'
import { canRead } from '#/lib/notes/visibility'
import { recordPath } from '#/lib/record-path'
import { describeExternalOrigin } from '#/lib/server/external-origin'
import type { DocumentFilingTarget } from '#/lib/server/shared'
import { ACCEPTED_CAPTURE_SCHEMA_VERSIONS } from './versions'

/**
 * `POST /api/v1/capture` (SPA-111) — CONTEXT.md integration map #8, and
 * `docs/spec-storage-sources.md` §3.1 entry point 8: page text in, a filed
 * document out. What `capture.capture` in `api.ts` runs, with no HttpApi
 * import so the door stays one file (`one-door.test.ts`), the way
 * `./records.ts` holds the read half.
 *
 * **This module writes no bytes and no rows of its own.** The text goes
 * through `intakeDocumentProgram` (`lib/documents/intake.ts`) — stream → sha
 * → blob → `birthDocumentProgram` → `tagged_in` edge → enqueue extract — the
 * same server lane forwarded attachments file through
 * (`lib/arrival/attachment-filing.ts`), and birth is the one writer of
 * `document` (`birth.test.ts`). So:
 *
 * - **A real blob, not a blobless row.** The text is stored as
 *   `text/plain; charset=utf-8`, byte for byte what was posted — plain, not
 *   markdown, because what an extension grabs is a page's visible text and
 *   nothing in it was written as markdown. Preview and download then work
 *   exactly as they do for an uploaded `.txt`, and the unchanged extract job
 *   reads it through its `text` extractor.
 * - **The sha is the text's alone**, so re-posting the same page is §3.4's
 *   sha+target dedupe in birth: filed against the same record it is the same
 *   row. `capturedAt` is validated and deliberately *not* folded into the
 *   bytes — doing so would make every re-post a new digest and defeat that
 *   rule. (An unfiled re-post is two rows, which is birth's existing rule for
 *   every unfiled arrival: no target, nothing to be the same filing as.)
 * - **`url` is the page's address** (`document.url`), and the title is the
 *   canonical name (and the filename, which birth writes from the same
 *   field).
 * - **Provenance is `manual`, `source_ref` null, the actor the token's user.**
 *   A capture is a person clicking a button in their own browser session;
 *   the extension is first-party, which is why the old `document_origin`
 *   `clip` collapsed into `manual` (SPA-137, `packages/db/src/schema/
 *   kinds.ts`; spec §3.1's D1 correction names entry 8 explicitly). The token
 *   is a credential, not an integration: `source_ref` is an FK to
 *   `integration.id`, and the biconditional check refuses a ref on a
 *   `manual` row anyway. The token's user lands in `uploaded_by` and the
 *   activity line, which is where "who filed it" is read.
 * - **`kind` is `article`**, as the URL clip files a page (`clip.ts`).
 *
 * **Extraction (SPA-134).** `object` declares what the page is — `person`
 * for a profile, `company` for a company page, or any object's slug,
 * singular or plural — and is checked against the registry before anything
 * is stored: an object the registry does not hold is refused naming the
 * slug. Declared, the page is queued for the deck reader's program against
 * that object's registry, anchored on the document
 * (`enqueueCaptureReadProgram`); the answer says `queued`. With the extract
 * lane unrouted, or no object declared, the page still lands and nothing is
 * queued: the answer says `skipped`, never an error.
 */

/** The payload as the handler receives it, already schema-decoded. */
export type CaptureInput = {
  readonly captureSchemaVersion: number
  readonly url: string
  readonly title: string
  readonly capturedAt: string
  readonly text: string
  /** A record id, or a record's exact name; omitted for an unfiled capture. */
  readonly target?: string
  /** The registry object the page is read as (SPA-134); omitted, unread. */
  readonly object?: string
}

export type CaptureResult = {
  documentId: string
  /** Where the capture can be seen in the app, on `APP_URL`. */
  url: string
  /** Whether the page was queued to be read against its object (SPA-134). */
  extraction: CaptureReadQueued
}

/** The payload's version is not one this instance reads. */
export class CaptureSchemaUnsupported extends Schema.TaggedError<CaptureSchemaUnsupported>()(
  'CaptureSchemaUnsupported',
  { message: Schema.String },
) {}

/** `text` is over `MAX_CAPTURE_BYTES`; nothing was stored. */
export class CaptureTooLarge extends Schema.TaggedError<CaptureTooLarge>()(
  'CaptureTooLarge',
  { message: Schema.String },
) {}

/** The target names no record this user can see, or names several. */
export class CaptureTargetNotFound extends Schema.TaggedError<CaptureTargetNotFound>()(
  'CaptureTargetNotFound',
  { message: Schema.String },
) {}

/** The target exists but will not take a document — birth's sentence. */
export class CaptureTargetRefused extends Schema.TaggedError<CaptureTargetRefused>()(
  'CaptureTargetRefused',
  { message: Schema.String },
) {}

/** The declared object is not in the registry; nothing was stored. */
export class CaptureObjectUnknown extends Schema.TaggedError<CaptureObjectUnknown>()(
  'CaptureObjectUnknown',
  { message: Schema.String },
) {}

/** A query, the store or the queue broke. A defect at the door (500). */
export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()(
  'CaptureFailed',
  { cause: Schema.Defect() },
) {}

export type CaptureFailure =
  | CaptureSchemaUnsupported
  | CaptureTooLarge
  | CaptureTargetNotFound
  | CaptureTargetRefused
  | CaptureObjectUnknown
  | CaptureFailed

/**
 * Null when `version` is accepted, else the sentence the caller is shown.
 * Pure and parameterized so a known-older version can be asserted accepted
 * before a second version exists.
 */
export function captureSchemaRefusal(
  version: number,
  accepted: ReadonlyArray<number> = ACCEPTED_CAPTURE_SCHEMA_VERSIONS,
): string | null {
  if (accepted.includes(version)) return null
  return `captureSchemaVersion ${version} is not one this instance accepts — update the extension. Accepted versions: ${accepted.join(', ')}.`
}

/** The sentence for text over the cap, the limit named in it. */
export function captureTooLargeMessage(sizeBytes: number): string {
  return `Capture text is ${sizeBytes} bytes, larger than the ${formatBytes(MAX_CAPTURE_BYTES)} limit (${MAX_CAPTURE_BYTES} bytes)`
}

/** Mirrors `lib/arrival/attachment-filing.ts`: the meter counts slices. */
const CHUNK_BYTES = 64 * 1024

function streamOf(bytes: Buffer): Readable {
  return Readable.from(
    (function* () {
      for (let at = 0; at < bytes.length; at += CHUNK_BYTES)
        yield bytes.subarray(at, at + CHUNK_BYTES)
    })(),
  )
}

export const CAPTURE_MIME = 'text/plain; charset=utf-8'

type Target = { id: string; kind: string; objectSlug: string | null }

/**
 * The target, as SPA-23/31 resolve one — an id, or an exact
 * (case-insensitive) name that fits one record — then read once for what the
 * deep link needs. canRead is the token user's: a private note they may not
 * read is not found, never filed onto, whether named or addressed by id.
 */
const resolveTarget = Effect.fn('capture.resolveTarget')(function* (
  reader: { id: string },
  ref: string,
): Effect.fn.Return<Target, CaptureTargetNotFound | CaptureFailed> {
  const id = yield* resolveEntityRefProgram(reader, ref).pipe(
    Effect.catchTag('McpToolRefused', (refused) =>
      Effect.fail(new CaptureTargetNotFound({ message: refused.message })),
    ),
    Effect.catchTag('McpToolQueryFailed', (failure) =>
      Effect.fail(new CaptureFailed({ cause: failure })),
    ),
  )
  const row = yield* Effect.tryPromise({
    try: async () =>
      (
        await db
          .select({
            kind: entity.kind,
            objectSlug: objectDef.slug,
            visibility: note.visibility,
            authorId: note.authorId,
          })
          .from(entity)
          .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
          .leftJoin(note, eq(note.entityId, entity.id))
          .where(eq(entity.id, id))
      ).at(0),
    catch: (cause) => new CaptureFailed({ cause }),
  })
  if (row === undefined || !canRead(reader, row))
    return yield* new CaptureTargetNotFound({
      message: `No record ${ref.trim()}`,
    })
  return { id, kind: row.kind, objectSlug: row.objectSlug }
})

/**
 * The deep link: the record the capture was filed on, or the unfiled inbox
 * (`/documents?filed=unfiled`) it lands in otherwise. A document has no page
 * of its own by decision (spec §3.2), so these are the two places it shows.
 */
function deepLink(target: Target | null): string {
  const { origin } = describeExternalOrigin(process.env.APP_URL)
  if (target === null) return `${origin}/documents?filed=unfiled`
  return `${origin}${recordPath(target) ?? '/documents'}`
}

/**
 * The declared object, as the registry holds it — the read `registry.list`
 * answers, by slug, singular or plural. Unknown, it refuses with the slug
 * named and the slugs there are.
 */
const resolveObject = (ref: string) =>
  // `object` set, the read answers exactly the one object or refuses.
  listRegistryProgram({ object: ref }).pipe(
    Effect.map(([object]) => object),
    Effect.catchTag('McpToolRefused', (refused) =>
      Effect.fail(new CaptureObjectUnknown({ message: refused.message })),
    ),
    Effect.catchTag('McpToolQueryFailed', (failure) =>
      Effect.fail(new CaptureFailed({ cause: failure })),
    ),
  )

/**
 * Birth's refusal is the caller's to read (a space, a document, a merged
 * record); anything else — the store, a query, the meter — is ours.
 */
function intakeFailure(
  failure: DocumentIntakeFailure,
): CaptureTargetRefused | CaptureFailed {
  return failure instanceof DocumentBirthRejected
    ? new CaptureTargetRefused({ message: documentIntakeMessage(failure) })
    : new CaptureFailed({ cause: failure })
}

export const captureProgram = Effect.fn('captureProgram')(function* (
  actor: { id: string },
  input: CaptureInput,
): Effect.fn.Return<CaptureResult, CaptureFailure> {
  const refusal = captureSchemaRefusal(input.captureSchemaVersion)
  if (refusal !== null)
    return yield* new CaptureSchemaUnsupported({ message: refusal })

  // Measured on the text before a byte is streamed or a row is read: an
  // over-cap capture stores nothing at all.
  const bytes = Buffer.from(input.text, 'utf8')
  if (bytes.length > MAX_CAPTURE_BYTES)
    return yield* new CaptureTooLarge({
      message: captureTooLargeMessage(bytes.length),
    })

  const object =
    input.object === undefined ? null : yield* resolveObject(input.object)
  const target =
    input.target === undefined
      ? null
      : yield* resolveTarget(actor, input.target)
  const fileAgainst: Array<DocumentFilingTarget> =
    target === null ? [] : [{ kind: 'record', entityId: target.id }]

  const filed = yield* intakeDocumentProgram({
    stream: streamOf(bytes),
    filename: input.title.trim(),
    url: input.url,
    mime: CAPTURE_MIME,
    declaredSize: bytes.length,
    kind: 'article',
    sourceClass: 'manual',
    sourceRef: null,
    provenance: {},
    fileAgainst,
    actor: { userId: actor.id },
  }).pipe(Effect.mapError(intakeFailure))

  const extraction =
    object === null
      ? 'skipped'
      : yield* enqueueCaptureReadProgram({
          documentId: filed.id,
          userId: actor.id,
          objectId: object.id,
        })

  return { documentId: filed.id, url: deepLink(target), extraction }
})
