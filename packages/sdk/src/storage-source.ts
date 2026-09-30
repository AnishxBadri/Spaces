/**
 * The storage-source provider interface (docs/spec-plugin-sdk.md §5). Not a
 * job and not a trigger: core calls into it, it calls nothing. A plugin that
 * implements it says `provides: 'storage-source'` in its manifest.
 *
 * TODO(storage area, project 20): the body is the storage area's to write —
 * argument and return types, cursors, the change feed, the picker. It is
 * declared here only so the name and the method list are part of the
 * contract before any provider exists; until then every member is an opaque
 * function a provider cannot yet meaningfully implement. Owner: the storage
 * area (`docs/spec-storage-sources.md`).
 */
export type StorageSource = {
  readonly resolveLink: (...args: never) => unknown
  readonly listFolder: (...args: never) => unknown
  readonly getFile: (...args: never) => unknown
  readonly changes: (...args: never) => unknown
  readonly putFile: (...args: never) => unknown
  readonly move: (...args: never) => unknown
  readonly rename: (...args: never) => unknown
  readonly ensureFolder: (...args: never) => unknown
  readonly pickerConfig: (...args: never) => unknown
}
