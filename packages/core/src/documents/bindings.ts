/**
 * The bind-time guards of a storage binding (docs/spec-storage-sources.md
 * §5.6): one folder, one owner node. Pure; the writer is
 * `bindFolderProgram`.
 * - Containment is membership in a folder's path of ids (its ancestry from
 *   `getFolder`, then itself), in both directions. Not a whole-path prefix:
 *   each side's ancestry stops where its binder's account stops seeing, so
 *   two paths to one folder can share only their tail.
 */

/** The kinds a folder may be bound to: §5.1's space, company, deal or custom record. */
export const BINDABLE_KINDS: ReadonlyArray<string> = [
  'company',
  'deal',
  'space',
  'custom',
]

export function isBindableKind(kind: string): boolean {
  return BINDABLE_KINDS.includes(kind)
}

/** A folder as the guard reads it: its id, its ancestry root first, its path. */
export type BindingFolder = {
  readonly folderId: string
  readonly ancestorIds: ReadonlyArray<string>
  readonly path: string
}

/** A binding already in place, with the names its refusal is worded in. */
export type ExistingBinding = BindingFolder & {
  readonly targetName: string
  readonly binderName: string | null
}

export type BindingConflict =
  | { readonly _tag: 'same'; readonly existing: ExistingBinding }
  | { readonly _tag: 'inside'; readonly existing: ExistingBinding }
  | { readonly _tag: 'contains'; readonly existing: ExistingBinding }

const idPath = (folder: BindingFolder): ReadonlyArray<string> => [
  ...folder.ancestorIds,
  folder.folderId,
]

/**
 * The first binding the candidate collides with, or null: the same folder,
 * a folder inside a bound one, or a parent of a bound one.
 */
export function bindingConflict(
  candidate: BindingFolder,
  existing: ReadonlyArray<ExistingBinding>,
): BindingConflict | null {
  const mine = idPath(candidate)
  for (const other of existing) {
    if (other.folderId === candidate.folderId)
      return { _tag: 'same', existing: other }
    if (mine.includes(other.folderId))
      return { _tag: 'inside', existing: other }
    if (idPath(other).includes(candidate.folderId))
      return { _tag: 'contains', existing: other }
  }
  return null
}

/** The refusal a conflict is shown as, naming the binding, its target and, for the same folder, its binder. */
export function bindingConflictMessage(
  candidate: BindingFolder,
  conflict: BindingConflict,
): string {
  const { existing } = conflict
  switch (conflict._tag) {
    case 'same':
      return `${existing.path} is already linked to ${existing.targetName}${existing.binderName === null ? '' : ` by ${existing.binderName}`}.`
    case 'inside':
      return `${candidate.path} is inside ${existing.path}, which is linked to ${existing.targetName}. A folder has one owner.`
    case 'contains':
      return `${candidate.path} holds ${existing.path}, which is linked to ${existing.targetName}. A folder has one owner.`
  }
}
