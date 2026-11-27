import { fileDocument, unfileDocument } from '#/lib/server-fns'

/** A record or a space a file is filed under. */
export type FilingTarget = { kind: 'record' | 'space'; entityId: string }

/**
 * One tick in the `File under…` popover: checked files the file under the
 * target, unchecked unfiles it, through the same server fns as every other
 * filing (an email attachment filed by hand keeps its copy). Unfiling the
 * last filing leaves the file Unfiled; it never deletes it. Answers the ids
 * the file is filed under afterwards, as the popover's ticks read them.
 */
export async function setFiled(
  documentId: string,
  target: FilingTarget,
  checked: boolean,
  filed: ReadonlyArray<string>,
): Promise<Array<string>> {
  if (checked) {
    await fileDocument({ data: { documentId, target } })
    return filed.includes(target.entityId)
      ? [...filed]
      : [...filed, target.entityId]
  }
  await unfileDocument({ data: { documentId, target } })
  return filed.filter((id) => id !== target.entityId)
}
