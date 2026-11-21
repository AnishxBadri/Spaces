/**
 * Where a synced attachment's file sits in the mailbox: `document.external_id`
 * is `<Gmail message id>/<sha256 of the part>`, beside the row's
 * `connection_id`.
 * - The digest is the attachment id. Gmail's own `attachmentId` is minted
 *   per read, so it cannot find the part again; the digest can, and it
 *   proves the bytes fetched back are the bytes whose text was read.
 * - The digest also stands in for the empty `blob_sha` wherever a row is
 *   matched by its bytes: dedupe on arrival, the re-delivery rejoin, the
 *   viewer's cache. Pure: client and server share it.
 */

export type AttachmentPointer = {
  /** The mailbox's own id for the message (Gmail's, never the RFC Message-ID). */
  readonly messageId: string
  readonly sha: string
}

const SHA = /^[a-f0-9]{64}$/

export function attachmentExternalId(messageId: string, sha: string): string {
  return `${messageId}/${sha}`
}

/** The pointer an `external_id` names; null when it is not an attachment's. */
export function attachmentPointerOf(
  externalId: string | null,
): AttachmentPointer | null {
  if (externalId === null) return null
  const slash = externalId.lastIndexOf('/')
  if (slash <= 0) return null
  const sha = externalId.slice(slash + 1)
  return SHA.test(sha) ? { messageId: externalId.slice(0, slash), sha } : null
}
