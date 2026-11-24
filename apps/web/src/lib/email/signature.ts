/**
 * A member's email signature in a draft's body. Pure, so the composer and
 * its tests share it.
 * - It is added once, when a body is first created: a new email, a reply,
 *   a forward, a template applied at open. After that it is ordinary text,
 *   so a held draft reopens as it was saved.
 * - It sits at the foot after a blank line, before any quoted history; an
 *   empty signature adds nothing.
 */

/** The longest signature kept; a pasted email is not a signature. */
export const SIGNATURE_MAX = 2000

/** The signature as it is written into a body: no blank edges. */
export function signatureText(signature: string | null): string {
  return (signature ?? '').trim()
}

/**
 * `written`, then the signature after a blank line, then `quoted` after
 * another. A body with nothing written starts on the blank line, so the
 * caret opens above the signature.
 */
export function signedBody(
  written: string,
  signature: string | null,
  quoted: string = '',
): string {
  const sig = signatureText(signature)
  const head = written.trimEnd()
  if (sig === '') {
    if (quoted === '') return written
    return head === '' ? quoted : `${head}\n\n${quoted}`
  }
  const tail = quoted === '' ? '' : `\n\n${quoted}`
  return `${head}\n\n${sig}${tail}`
}

/** Whether the body still holds the signature as it was added. */
export function holdsSignature(
  body: string,
  signature: string | null,
): boolean {
  const sig = signatureText(signature)
  return sig !== '' && body.includes(sig)
}

/** Whether anything but the signature has been written in the body. */
export function bodyWritten(body: string, signature: string | null): boolean {
  const text = body.trim()
  return text !== '' && text !== signatureText(signature)
}
