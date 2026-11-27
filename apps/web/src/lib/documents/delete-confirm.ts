import { formatBytes } from '@spaces/core/documents'
import { fileType } from './files-tab'
import type { FileType } from './files-tab'
import { storageLinkProvider } from './storage-link'

/**
 * What the delete confirm says about one file. Every field is already on
 * the row or the open view, so the confirm opens at once with no fetch.
 */
export type DeletableFile = {
  readonly id: string
  readonly filename: string
  readonly mime: string | null
  readonly externalUrl: string | null
  readonly sizeBytes: number | null
  /** The lane that brought it: `gmail`, `google-drive`; null for an upload. */
  readonly sourceCapability: string | null
  /** The provider's folder path, verbatim. */
  readonly sourcePath: string | null
  /** Brought by a linked Drive folder's sync, which will not bring it back. */
  readonly inSyncedFolder: boolean
  /** The revisions that go with it, itself included; 1 for a file with none. */
  readonly versions: number
  /** Each record and space it is filed under, with its kind word. */
  readonly filings: ReadonlyArray<{
    readonly name: string
    readonly kind: string
  }>
}

/** The drawn confirm's words: the name, one facts line, the list, the foot. */
export type DeleteFileWords = {
  readonly name: string
  readonly facts: string
  readonly rows: Array<{ name: string; meta: string }>
  readonly note: string
}

const TYPE_WORDS: Readonly<Record<FileType, string | null>> = {
  pdf: 'PDF',
  doc: 'DOC',
  xls: 'XLS',
  ppt: 'PPT',
  img: 'IMG',
  txt: 'TXT',
  zip: 'ZIP',
  eml: 'EML',
  file: null,
  'google-doc': 'Google Doc',
  'google-sheet': 'Google Sheet',
  'google-slides': 'Google Slides',
}

/** Where a copy outlives the delete: the mailbox or the Drive it came from. */
export function keptIn(
  file: Pick<DeletableFile, 'sourceCapability' | 'externalUrl'>,
): 'Gmail' | 'Google Drive' | null {
  if (file.sourceCapability === 'gmail') return 'Gmail'
  if (file.sourceCapability === 'google-drive') return 'Google Drive'
  const link =
    file.externalUrl === null ? null : storageLinkProvider(file.externalUrl)
  return link?.product === 'drive' ? 'Google Drive' : null
}

/**
 * The confirm's words, from board 07:
 * - Facts: the type and size, then `both versions` when kept revisions go
 *   with it, or `the only copy` when nothing outside keeps one.
 * - The list: each filing with its kind, then a synced folder's path with
 *   `Won't sync back`. An unfiled file has none.
 * - The foot: the one fact about getting it back.
 */
export function deleteFileWords(file: DeletableFile): DeleteFileWords {
  const kept = keptIn(file)
  const copies =
    file.versions === 2
      ? 'both versions'
      : file.versions > 2
        ? `all ${String(file.versions)} versions`
        : kept === null
          ? 'the only copy'
          : null
  return {
    name: file.filename,
    facts: [
      TYPE_WORDS[fileType(file)],
      formatBytes(file.sizeBytes) || null,
      copies,
    ]
      .filter((part) => part !== null)
      .join(' · '),
    rows: [
      ...file.filings.map((f) => ({ name: f.name, meta: f.kind })),
      ...(file.inSyncedFolder && file.sourcePath !== null
        ? [{ name: file.sourcePath, meta: "Won't sync back" }]
        : []),
    ],
    note: kept === null ? "Can't be undone" : `Stays in ${kept}`,
  }
}

/** A filing's kind word: `Company`, `Deal`, `Space`; `Record` for a custom one. */
export function filingKind(
  edge: { kind: 'space' } | { kind: 'record'; entityKind: string },
): string {
  if (edge.kind === 'space') return 'Space'
  switch (edge.entityKind) {
    case 'company':
      return 'Company'
    case 'person':
      return 'Person'
    case 'deal':
      return 'Deal'
    default:
      return 'Record'
  }
}
