import { Readable } from 'node:stream'
import { Effect } from 'effect'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
} from '#/lib/documents/intake'
import type { MailAttachment, SortedAttachments } from './attachments'

/**
 * Forwarded attachments file themselves (SPA-115) — entry point 6 of
 * `docs/spec-storage-sources.md` §3.1, "attachments → matched company, else
 * unfiled".
 *
 * **This lane adds nothing to the byte path.** Every part goes through
 * `intakeDocumentProgram` (`lib/documents/intake.ts`) — stream → sha → blob →
 * `birthDocumentProgram` → edge → enqueue extract — which is the one writer
 * of `document` (`birth.test.ts`) and whose §3.4 rule is what makes the same
 * deck forwarded twice one row on the company, and the same deck on two
 * companies one blob and two rows. Nothing here inserts a row
 * (`one-door.test.ts`).
 *
 * - **Provenance** is the mailbox's: `source_class = 'integration'`, the one
 *   `core.mailbox` integration as `source_ref` and as the actor (the user
 *   columns stay null — a mailbox is not a person), and the message subject
 *   as `source_path`, which is the label the Files row's "via core.mailbox"
 *   sits beside. No new lane on the row.
 * - **The target** is one company or none, decided by `file.ts` inside the
 *   interaction's transaction (`chooseFilingCompany`). None is an unfiled
 *   document: no `link`, no `entity_space`, exactly the state
 *   `/documents?filed=unfiled` and Today's Unfiled count already read.
 * - **`kind` stays `other`.** The classify lane (SPA-62,
 *   `onDocumentExtracted`) proposes "this looks like a deck" after
 *   extraction; proposing it here too would put two suggestions on one
 *   document.
 * - **A refusal is per part, and never the message's.** Over
 *   `MAX_UPLOAD_BYTES` the intake meter destroys the stream mid-transfer and
 *   stores nothing; that part's reason goes on the poll's `job_run.summary`
 *   line and the rest of the message — its interaction, its body, its other
 *   attachments — has already landed or still lands. A store that is down is
 *   recorded the same way rather than failing the poll: the interaction is
 *   committed and is the dedupe key, so a retried poll would read it as a
 *   duplicate and file nothing either way.
 */

export type AttachmentFilingContext = {
  /** The core mailbox integration — `source_ref` and actor on every row. */
  integrationId: string
  /** The message subject, stored verbatim as `document.source_path`. */
  subject: string | null
  /** The company the thread files onto, or null for unfiled. */
  companyId: string | null
}

export type AttachmentOutcome = {
  /** Filed onto the company — a fresh row, or the one §3.4 answered. */
  filed: number
  /** Written with no edge at all. */
  unfiled: number
  /** Inline and signature images, never handed to the pipeline. */
  skipped: number
  /** Refused, with the sentence the summary line carries. */
  refused: Array<{ filename: string; reason: string }>
}

export const NO_ATTACHMENTS: AttachmentOutcome = {
  filed: 0,
  unfiled: 0,
  skipped: 0,
  refused: [],
}

/**
 * The decoded part, handed over in slices so the intake meter counts it the
 * way it counts any provider's stream — and stops reading at the limit.
 * `subarray` is a view: no copy of the bytes mailparser already holds.
 */
const CHUNK_BYTES = 64 * 1024

function streamOf(content: MailAttachment['content']): Readable {
  return Readable.from(
    (function* () {
      for (let at = 0; at < content.length; at += CHUNK_BYTES)
        yield content.subarray(at, at + CHUNK_BYTES)
    })(),
  )
}

export const fileAttachmentsProgram = Effect.fn('fileAttachments')(function* (
  attachments: SortedAttachments,
  ctx: AttachmentFilingContext,
): Effect.fn.Return<AttachmentOutcome> {
  const outcome: AttachmentOutcome = {
    filed: 0,
    unfiled: 0,
    skipped: attachments.skipped.length,
    refused: [],
  }
  for (const part of attachments.file) {
    const result = yield* intakeDocumentProgram({
      stream: streamOf(part.content),
      filename: part.filename,
      mime: part.mime,
      // Not declared: the meter is this lane's one guard, the same one every
      // server-side arrival passes through, and it refuses mid-stream.
      declaredSize: null,
      kind: 'other',
      sourceClass: 'integration',
      sourceRef: ctx.integrationId,
      provenance: { sourcePath: ctx.subject },
      fileAgainst:
        ctx.companyId === null
          ? []
          : [{ kind: 'record', entityId: ctx.companyId }],
      actor: { integrationId: ctx.integrationId },
    }).pipe(
      Effect.map(() => null),
      Effect.catch((failure) => Effect.succeed(documentIntakeMessage(failure))),
    )
    if (result !== null)
      outcome.refused.push({ filename: part.filename, reason: result })
    else if (ctx.companyId === null) outcome.unfiled++
    else outcome.filed++
  }
  return outcome
})
