import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Effect, Schema } from 'effect'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import { storage } from '#/lib/storage'
import { birthDocumentProgram, documentBirthMessage } from './birth'
import type { Readable } from 'node:stream'
import type { DocumentKind } from '@spaces/core/documents'
import type { SourceClass } from '@spaces/db/schema'
import type { DocumentFilingTarget } from '#/lib/server/shared'
import type {
  DocumentActor,
  DocumentBirthFailure,
  DocumentProvenance,
} from './birth'

/**
 * **The server byte lane** (SPA-130) — every arrival that is not a browser
 * PUT. The URL clip's PDF response, a plugin filing a document through the
 * SDK, a pasted Drive link, the Drive walker: four slices across three areas
 * all hold a `Readable` server-side and hold **no sha**, and this is the half
 * `birthDocumentProgram` deliberately cannot do. Built exactly once, which is
 * the point of the cluster.
 *
 * **The other lane is `lib/documents/upload.ts`,** and browser uploads must
 * keep using it: the page hashes with WebCrypto and PUTs straight at storage
 * through a presigned URL, which is what keeps a 200 MB deck out of Node
 * (CONTEXT.md → Storage). The presigned PUT lands at
 * `routes/api/blob/$key.ts`, which re-hashes through
 * `LocalStorage.putContentAddressed` because there the key is a *client's
 * claim*. Here the digest is something we measured ourselves, so the port's
 * plain `put` is the right call and `putContentAddressed` stays local-only —
 * promoting it onto the `Storage` port would offer S3 a verification it
 * cannot perform.
 *
 * Two constraints the shape exists for, and both are easy to get wrong:
 *
 * - **The sha is unknown until the bytes are read** (spec §4: bytes are
 *   hashed on arrival, always — no provider hash is trusted across
 *   providers). So the stream lands in a temp file under `os.tmpdir()` while
 *   a hash+meter transform runs over it, and only then is `put` called under
 *   the measured digest. Never a Buffer: 250 MB of deck must not become 250
 *   MB of RSS. The temp directory is `mkdtemp`'d and removed on **every**
 *   path — success, refusal, failure, interruption — by `acquireUseRelease`.
 *   Not `<DATA_DIR>/blobs/.incoming`, which is a local-driver detail while
 *   the store may well be S3.
 * - **`MAX_UPLOAD_BYTES` is enforced while streaming.** `declaredSize` is
 *   advisory and routinely absent — a Drive Docs export reports no size at
 *   all — so the meter is the guard that counts, and passing the limit
 *   destroys the source mid-transfer and leaves no blob behind.
 *
 * It lives in `lib/documents/` and not in `lib/server/` for birth's reason: a
 * plain export from a module the server-fns barrel re-exports ships to the
 * browser (CLAUDE.md → Traps, SPA-155), and a test has to call this without a
 * request. It is never re-exported from `src/lib/server-fns.ts`.
 */

export type DocumentIntakeInput = {
  /** The bytes, still unread. Consumed exactly once. */
  stream: Readable
  filename: string
  mime: string | null
  /**
   * What the provider said the size was, or null when it said nothing — a
   * Drive Docs export is the null case. Advisory only: the row records what
   * the meter counted, never this.
   */
  declaredSize: number | null
  kind: DocumentKind
  /** The eight-value class, never a vendor (D1). `integration` + a ref here. */
  sourceClass: SourceClass
  sourceRef: string | null
  provenance: DocumentProvenance
  fileAgainst: Array<DocumentFilingTarget>
  actor: DocumentActor
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
 * The stream, metered and hashed on its way to disk — the `local.ts`
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

const storeAndBirth = Effect.fn('documentIntake.storeAndBirth')(function* (
  dir: string,
  input: DocumentIntakeInput,
): Effect.fn.Return<{ id: string; deduped: boolean }, DocumentIntakeFailure> {
  const path = join(dir, 'arriving')
  const { sha, sizeBytes } = yield* drainToTempFile(input.stream, path)

  // The same deck arriving from two providers costs one blob: content
  // addressing means the stored bytes are already these bytes, and the
  // document row is still born — §3.4's dedupe is about a *target*, and it is
  // birth's rule to apply, not ours.
  const stored = yield* io(() => storage().exists(sha))
  if (!stored) {
    // `put`, not `putContentAddressed`: the key is the digest this module
    // measured, not a claim anybody made. If intake ever registers a
    // `pending_blob` row (SPA-54), its delete belongs on the line below.
    const meta = input.mime === null ? {} : { mime: input.mime }
    yield* io(() => storage().put(sha, createReadStream(path), meta))
  }

  return yield* birthDocumentProgram({
    blobSha: sha,
    filename: input.filename,
    mime: input.mime,
    // What we counted, never what the provider declared.
    sizeBytes,
    kind: input.kind,
    sourceClass: input.sourceClass,
    sourceRef: input.sourceRef,
    provenance: input.provenance,
    fileAgainst: input.fileAgainst,
    actor: input.actor,
  })
})

/**
 * Stream → sha + size → blob (or not, when the digest is already stored) →
 * `birthDocumentProgram`. Answers exactly what birth answered, so a caller
 * can tell a fresh filing from a dedupe.
 */
export const intakeDocumentProgram = Effect.fn('intakeDocumentProgram')(
  function* (
    input: DocumentIntakeInput,
  ): Effect.fn.Return<{ id: string; deduped: boolean }, DocumentIntakeFailure> {
    // A provider that declares an over-limit size is refused before a byte is
    // read. This is the cheap half of the guard, not the guard: most of the
    // callers this lane exists for declare nothing.
    if (input.declaredSize !== null && input.declaredSize > MAX_UPLOAD_BYTES) {
      input.stream.destroy()
      return yield* new DocumentTooLarge({ limitBytes: MAX_UPLOAD_BYTES })
    }

    return yield* Effect.acquireUseRelease(
      makeTempDir,
      (dir) => storeAndBirth(dir, input),
      (dir) => removeTempDir(dir),
    )
  },
)
