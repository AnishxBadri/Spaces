import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import { pendingBlob } from '@spaces/db/schema'
import { MAX_UPLOAD_BYTES, formatBytes } from '../../documents'
import { storage } from '../storage'
import { birthDocumentProgram, documentBirthMessage } from './birth'
import { proposeNewerVersionProgram } from './newer-version'
import type { Readable } from 'node:stream'
import type { SourceClass } from '@spaces/db/schema'
import type { DocumentKind } from '../../documents'
import type { DocumentFilingTarget } from '../../documents/filing'
import type { Enqueue } from '../../queue/enqueue'
import type {
  DocumentActor,
  DocumentBirthFailure,
  DocumentPrivacy,
  DocumentProvenance,
} from './birth'

/**
 * **The server byte lane** — every arrival that is not a browser PUT and has
 * **no row yet** (a plugin's `Content.fileDocument`, a pasted Drive link, the
 * Drive walker): a server-side `Readable`, **no sha**, and a document born at
 * the end — the half `birthDocumentProgram` deliberately cannot do.
 * - **Not the URL clip's PDF**: `clip-document.ts` already has its row, so
 *   routing it here would mint a second document. It `put`s the bytes itself.
 * - **Browser uploads stay on the presigned lane**, which keeps a 200 MB deck
 *   out of Node; its blob route re-hashes via `putContentAddressed` because
 *   the key is a client's claim. Here we measured the digest, so plain `put`.
 * - **The sha is unknown until the bytes are read**; no provider hash is
 *   trusted. The stream lands in a `mkdtemp` dir under `os.tmpdir()` (not the
 *   local driver's dir: the store may be S3), removed on **every** path by
 *   `acquireUseRelease`. Never a Buffer: 250 MB of deck must not be RSS.
 * - **`MAX_UPLOAD_BYTES` is enforced while streaming.** `declaredSize` is
 *   advisory and often absent, so the meter is the guard; passing the limit
 *   destroys the source mid-transfer and leaves no blob.
 * - Imports nothing from apps/web. Never re-export it from the client
 *   server-fns barrel.
 */

export type DocumentIntakeInput = {
  /** The bytes, still unread. Consumed exactly once. */
  stream: Readable
  filename: string
  /**
   * The page these bytes are the text of, for the one server-lane arrival
   * that has one: a capture stores the page's text as a blob *and*
   * keeps its address, which birth writes to `document.url`. Every other
   * caller omits it.
   */
  url?: string | null
  mime: string | null
  /**
   * What the provider said the size was, or null when it said nothing — a
   * Drive Docs export is the null case. Advisory only: the row records what
   * the meter counted, never this.
   */
  declaredSize: number | null
  kind: DocumentKind
  /** The eight-value class, never a vendor. `integration` + a ref here. */
  sourceClass: SourceClass
  sourceRef: string | null
  provenance: DocumentProvenance
  fileAgainst: Array<DocumentFilingTarget>
  actor: DocumentActor
  /** Birth's `privacy`; omitted is shared. */
  privacy?: DocumentPrivacy
}

/** The stream passed `MAX_UPLOAD_BYTES`; nothing was stored. */
export class DocumentTooLarge extends Schema.TaggedError<DocumentTooLarge>()(
  'DocumentTooLarge',
  { limitBytes: Schema.Number },
) {}

/** The read, the temp write or the store write broke. */
export class DocumentIntakeFailed extends Schema.TaggedError<DocumentIntakeFailed>()(
  'DocumentIntakeFailed',
  { cause: Schema.Defect() },
) {}

export type DocumentIntakeFailure =
  DocumentTooLarge | DocumentIntakeFailed | DocumentBirthFailure

/**
 * The sentence a caller shows. `Schema.TaggedError` carries no `message`, so
 * a refusal allowed through as-is arrives empty — the rule `ledgerVoidMessage`
 * set and `documentBirthMessage` repeats. The too-large sentence is
 * byte-identical to the browser lane's, because it is the same limit.
 */
export function documentIntakeMessage(failure: unknown): string {
  if (failure instanceof DocumentTooLarge)
    return `Larger than the ${formatBytes(failure.limitBytes)} limit`
  if (failure instanceof DocumentIntakeFailed)
    return 'Could not store this file'
  return documentBirthMessage(failure)
}

const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DocumentIntakeFailed({ cause }),
  })

/** A private directory nobody else can collide with, under the OS temp dir. */
const makeTempDir = Effect.tryPromise({
  try: () => mkdtemp(join(tmpdir(), 'spaces-intake-')),
  catch: (cause) => new DocumentIntakeFailed({ cause }),
})

/**
 * Removed on every path, including a failed or interrupted one. A cleanup
 * that throws must not replace the real error, so it is swallowed here rather
 * than raised as a defect.
 */
const removeTempDir = (dir: string) =>
  Effect.promise(() =>
    rm(dir, { recursive: true, force: true }).catch(() => undefined),
  )

/**
 * The stream, metered and hashed on its way to disk — the
 * `putContentAddressed` pattern, except that here the digest is the *answer*
 * rather than something to check a claim against.
 *
 * Passing the limit fails the transform, and `stream/promises`' `pipeline`
 * destroys every stream in the chain on error — including the source, which
 * is what stops a hostile or runaway provider from continuing to send. The
 * half-written temp file goes with the directory.
 */
const drainToTempFile = Effect.fn('documentIntake.drainToTempFile')(function* (
  stream: Readable,
  path: string,
): Effect.fn.Return<
  { sha: string; sizeBytes: number },
  DocumentTooLarge | DocumentIntakeFailed
> {
  const hash = createHash('sha256')
  let seen = 0
  // The flag, not the error identity: `pipeline` may surface a premature
  // close from the destroyed source instead of the transform's own error.
  let exceeded = false

  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length
      if (seen > MAX_UPLOAD_BYTES) {
        exceeded = true
        done(new Error(`Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`))
        return
      }
      hash.update(chunk)
      done(null, chunk)
    },
  })

  yield* Effect.tryPromise({
    try: () =>
      pipeline(stream, meter, createWriteStream(path, { mode: 0o600 })),
    catch: (cause) =>
      exceeded
        ? new DocumentTooLarge({ limitBytes: MAX_UPLOAD_BYTES })
        : new DocumentIntakeFailed({ cause }),
  })

  return { sha: hash.digest('hex'), sizeBytes: seen }
})

/**
 * The blob half of the lane: drain, hash, and `put` under the measured digest
 * unless the store already holds it. Shared by `storeAndBirth` below and by
 * `putBlobProgram`, so this module stays the one `storage().put(` site of the
 * server lane.
 *
 * `intent` is the `pending_blob` row, written **before** the bytes
 * and only when they are new — the order `prepareBlobUploadProgram` keeps, so
 * no crash can leave stored bytes the orphan sweep has not heard of. Intake
 * passes none: birth follows in the same program and clears nothing it did
 * not write.
 */
const storeBlob = Effect.fn('documentIntake.storeBlob')(function* (
  dir: string,
  stream: Readable,
  mime: string | null,
  intent: { preparedBy: string | null } | null,
): Effect.fn.Return<
  { sha: string; sizeBytes: number; stored: boolean },
  DocumentTooLarge | DocumentIntakeFailed
> {
  const path = join(dir, 'arriving')
  const { sha, sizeBytes } = yield* drainToTempFile(stream, path)

  // The same deck arriving from two providers costs one blob: content
  // addressing means the stored bytes are already these bytes.
  const stored = yield* io(() => storage().exists(sha))
  if (!stored) {
    if (intent !== null) {
      yield* io(() =>
        db
          .insert(pendingBlob)
          .values({ sha, sizeBytes, preparedBy: intent.preparedBy })
          .onConflictDoUpdate({
            target: pendingBlob.sha,
            set: {
              sizeBytes,
              preparedBy: intent.preparedBy,
              preparedAt: new Date(),
            },
          }),
      )
    }
    // `put`, not `putContentAddressed`: the key is the digest this module
    // measured, not a claim anybody made.
    const meta = mime === null ? {} : { mime }
    yield* io(() => storage().put(sha, createReadStream(path), meta))
  }
  return { sha, sizeBytes, stored: !stored }
})

const storeAndBirth = Effect.fn('documentIntake.storeAndBirth')(function* (
  dir: string,
  input: DocumentIntakeInput,
): Effect.fn.Return<
  { id: string; deduped: boolean },
  DocumentIntakeFailure,
  Enqueue
> {
  const { sha, sizeBytes } = yield* storeBlob(
    dir,
    input.stream,
    input.mime,
    null,
  )

  // The document row is still born on a stored blob — the dedupe is about
  // a *target*, and it is birth's rule to apply, not ours.
  return yield* birthDocumentProgram({
    blobSha: sha,
    filename: input.filename,
    url: input.url ?? null,
    mime: input.mime,
    // What we counted, never what the provider declared.
    sizeBytes,
    kind: input.kind,
    sourceClass: input.sourceClass,
    sourceRef: input.sourceRef,
    provenance: input.provenance,
    fileAgainst: input.fileAgainst,
    actor: input.actor,
    ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
  })
})

export type PutBlobInput = {
  /** The bytes, still unread. Consumed exactly once. */
  stream: Readable
  mime: string | null
  /** Who is storing them; null for a lane that acts as an integration. */
  preparedBy: string | null
}

/**
 * **Bytes to a blob and nothing else** — the lane for a payload
 * that must never become a document: a spreadsheet staged for import is a
 * portfolio ledger, and a `document` row would queue extraction, chunks and
 * embeddings, which is exactly what must not happen to it. Same drain, same
 * meter, same digest as intake; it stops at the store.
 *
 * A new blob gets its `pending_blob` intent row, so the caller clears it when
 * the row that names these bytes is written (`import_batch` names them;
 * `blobIsReferenced` counts it). Returns the digest, the metered size, and
 * whether this call stored the bytes or found them already held.
 */
export const putBlobProgram = Effect.fn('putBlobProgram')(function* (
  input: PutBlobInput,
): Effect.fn.Return<
  { sha: string; sizeBytes: number; stored: boolean },
  DocumentTooLarge | DocumentIntakeFailed
> {
  return yield* Effect.acquireUseRelease(
    makeTempDir,
    (dir) =>
      storeBlob(dir, input.stream, input.mime, {
        preparedBy: input.preparedBy,
      }),
    (dir) => removeTempDir(dir),
  )
})

/**
 * Stream → sha + size → blob (or not, when the digest is already stored) →
 * `birthDocumentProgram` → the newer-version suggestion, when it files on a
 * record. Answers exactly what birth answered, so a caller can tell a fresh
 * filing from a dedupe.
 */
export const intakeDocumentProgram = Effect.fn('intakeDocumentProgram')(
  function* (
    input: DocumentIntakeInput,
  ): Effect.fn.Return<
    { id: string; deduped: boolean },
    DocumentIntakeFailure,
    Enqueue
  > {
    // A provider that declares an over-limit size is refused before a byte is
    // read. This is the cheap half of the guard, not the guard: most of the
    // callers this lane exists for declare nothing.
    if (input.declaredSize !== null && input.declaredSize > MAX_UPLOAD_BYTES) {
      input.stream.destroy()
      return yield* new DocumentTooLarge({ limitBytes: MAX_UPLOAD_BYTES })
    }

    const born = yield* Effect.acquireUseRelease(
      makeTempDir,
      (dir) => storeAndBirth(dir, input),
      (dir) => removeTempDir(dir),
    )
    // Filed on a record that holds one of its kind: suggest, never link.
    if (input.fileAgainst.some((t) => t.kind === 'record'))
      yield* proposeNewerVersionProgram(born.id)
    return born
  },
)
