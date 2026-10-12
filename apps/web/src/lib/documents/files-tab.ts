import { formatBytes } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import { formatDurationMs, formatSince } from '@spaces/core/format'
import { storageLinkProvider } from './storage-link'

/**
 * What a record's Files tab prints about a file, as pure functions: the
 * glyph's type, the kind groups, the mono end lane and the state word. (D66)
 * Client-safe: no server import, so the tab and its tests share one copy.
 */

/** The kind groups, in the order the tab draws them. */
export const KIND_ORDER: ReadonlyArray<DocumentKind> = [
  'deck',
  'cap_table',
  'dd',
  'legal',
  'article',
  'other',
]

/** The glyph a file wears: its type, never its kind. */
export type FileType =
  | 'pdf'
  | 'doc'
  | 'xls'
  | 'ppt'
  | 'img'
  | 'txt'
  | 'zip'
  | 'eml'
  | 'file'
  | 'google-doc'
  | 'google-sheet'
  | 'google-slides'

const BY_EXTENSION: Readonly<Record<string, FileType>> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  rtf: 'doc',
  pages: 'doc',
  xls: 'xls',
  xlsx: 'xls',
  csv: 'xls',
  tsv: 'xls',
  ods: 'xls',
  numbers: 'xls',
  ppt: 'ppt',
  pptx: 'ppt',
  key: 'ppt',
  odp: 'ppt',
  png: 'img',
  jpg: 'img',
  jpeg: 'img',
  gif: 'img',
  webp: 'img',
  avif: 'img',
  bmp: 'img',
  svg: 'img',
  heic: 'img',
  txt: 'txt',
  md: 'txt',
  markdown: 'txt',
  html: 'txt',
  htm: 'txt',
  json: 'txt',
  zip: 'zip',
  gz: 'zip',
  tar: 'zip',
  '7z': 'zip',
  rar: 'zip',
  eml: 'eml',
  msg: 'eml',
}

const GOOGLE_MIMES: Readonly<Record<string, FileType>> = {
  'application/vnd.google-apps.document': 'google-doc',
  'application/vnd.google-apps.spreadsheet': 'google-sheet',
  'application/vnd.google-apps.presentation': 'google-slides',
}

const GOOGLE_PATHS: ReadonlyArray<readonly [string, FileType]> = [
  ['/document/', 'google-doc'],
  ['/spreadsheets/', 'google-sheet'],
  ['/presentation/', 'google-slides'],
]

type Typed = {
  readonly filename: string
  readonly mime: string | null
  readonly externalUrl: string | null
}

/** A Google Doc, Sheet or Slides file, by its native mime or its docs.google.com link. */
export function googleNative(doc: Typed): FileType | null {
  if (doc.mime !== null && Object.hasOwn(GOOGLE_MIMES, doc.mime))
    return GOOGLE_MIMES[doc.mime]
  if (doc.externalUrl === null || !URL.canParse(doc.externalUrl)) return null
  const url = new URL(doc.externalUrl)
  if (url.hostname !== 'docs.google.com') return null
  return (
    GOOGLE_PATHS.find(([path]) => url.pathname.startsWith(path))?.[1] ?? null
  )
}

export function fileType(doc: Typed): FileType {
  const native = googleNative(doc)
  if (native !== null) return native
  const dot = doc.filename.lastIndexOf('.')
  const ext = dot < 0 ? '' : doc.filename.slice(dot + 1).toLowerCase()
  if (Object.hasOwn(BY_EXTENSION, ext)) return BY_EXTENSION[ext]
  const mime = doc.mime?.toLowerCase() ?? ''
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'img'
  if (mime.startsWith('text/')) return 'txt'
  if (mime === 'message/rfc822') return 'eml'
  return 'file'
}

type Laned = Typed & {
  readonly sizeBytes: number | null
  readonly createdAt: string
  readonly sourceCapability: string | null
  readonly sourcePath: string | null
  /** The readable email it came attached to; omitted by lists that have none. */
  readonly email?: { readonly subject: string | null } | null
}

/**
 * The mono end lane: `from <path> · 4.1 MB · 09-02 · via gmail`.
 * - The provider path only outside a bound folder, whose tree already says it.
 * - `via` names a plugin that filed it, unless the state lane links there.
 * - An email attachment is `via <subject> · 4.1 MB · 09-02`: the email is
 *   its provenance, not the mailbox.
 */
export function endLane(doc: Laned, inFolder = false): string {
  if (doc.email != null)
    return [
      `via ${doc.email.subject || 'Untitled'}`,
      formatBytes(doc.sizeBytes) || null,
      doc.createdAt.slice(5, 10),
    ]
      .filter((part) => part !== null)
      .join(' · ')
  return [
    !inFolder && doc.sourcePath !== null ? `from ${doc.sourcePath}` : null,
    formatBytes(doc.sizeBytes) || null,
    doc.createdAt.slice(5, 10),
    doc.sourceCapability !== null && doc.externalUrl === null
      ? `via ${doc.sourceCapability}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

export type StateWord = {
  readonly text: string
  readonly tone: 'ink' | 'graphite' | 'warning' | 'destructive'
  /** Set when the word is a link out: `google ↗`, `drive ↗`. */
  readonly href: string | null
  /** The detail behind the word, for a failure. */
  readonly title: string | null
  /** A word that names a file, given more of the lane than the 96px. */
  readonly wide?: true
}

type Stated = Typed & {
  /** The newer version that supersedes this file (D59). */
  readonly replacedBy?: { readonly id: string; readonly name: string } | null
  readonly blobSha: string | null
  readonly url: string | null
  readonly extractionStatus: string
  readonly extractionError: string | null
  readonly externalStatus: 'linked' | 'gone' | null
  readonly sourceCapability: string | null
  readonly lastRun: {
    readonly attempt: number
    readonly durationMs: number | null
    readonly sinceMs: number
  } | null
}

const word = (
  text: string,
  tone: StateWord['tone'],
  title: string | null = null,
): StateWord => ({ text, tone, href: null, title })

/**
 * The lowercase mono state word a filed row ends on; null when nothing is
 * happening. The first that holds wins: in-flight work, then what went
 * wrong, then the newer version that replaced it, then where the file lives
 * elsewhere.
 */
export function stateWord(doc: Stated, inFolder = false): StateWord | null {
  if (doc.extractionStatus === 'pending')
    return doc.url !== null && doc.blobSha === null
      ? word('fetching.', 'ink')
      : word('reading text.', 'ink')
  if (doc.externalStatus === 'gone')
    return word('■ gone', 'warning', 'Deleted in the source. Our copy stays.')
  if (doc.extractionStatus === 'failed')
    return word(
      'read failed',
      'destructive',
      [doc.extractionError, runNote(doc.lastRun)]
        .filter((part) => part !== null)
        .join(' · '),
    )
  if (doc.replacedBy != null) {
    const text = `Replaced by → ${doc.replacedBy.name}`
    return { text, tone: 'graphite', href: null, title: text, wide: true }
  }
  if (doc.extractionStatus === 'unsupported')
    return word('no text', 'graphite', doc.extractionError)
  const native = googleNative(doc)
  if (native !== null && !inFolder) return word('following', 'ink')
  if (doc.externalUrl !== null) {
    const where =
      native !== null
        ? 'google'
        : (storageLinkProvider(doc.externalUrl)?.label ??
          doc.sourceCapability ??
          'source')
    return {
      text: `${where.toLowerCase()} ↗`,
      tone: 'ink',
      href: doc.externalUrl,
      title: null,
    }
  }
  if (doc.url !== null && doc.blobSha === null)
    return { text: 'page ↗', tone: 'ink', href: doc.url, title: null }
  return null
}

/** The extract job's last attempt, read back from the run ledger. */
export function runNote(run: Stated['lastRun']): string | null {
  if (run === null) return null
  return [
    `attempt ${String(run.attempt)}`,
    run.durationMs === null ? null : `took ${formatDurationMs(run.durationMs)}`,
    `${formatSince(run.sinceMs)} ago`,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** One folder of a bound Drive tree: its files, then its subfolders. */
export type FolderNode<T> = {
  readonly name: string
  readonly path: string
  readonly files: Array<T>
  readonly folders: Array<FolderNode<T>>
  /** Every file at or under this folder. */
  readonly count: number
}

/**
 * A bound folder's own Drive tree, from each document's `source_path`
 * (`Data room / Financials`), rooted at the bound folder's path.
 */
export function folderTree<T extends { readonly sourcePath: string | null }>(
  rootPath: string,
  rows: ReadonlyArray<T>,
): FolderNode<T> {
  const name = rootPath.split(' / ').at(-1) ?? rootPath
  const own = rows.filter((r) => r.sourcePath === rootPath)
  const below = rows.filter((r) => r.sourcePath?.startsWith(`${rootPath} / `))
  const childNames = [
    ...new Set(
      below.map(
        (r) => (r.sourcePath ?? '').slice(rootPath.length + 3).split(' / ')[0],
      ),
    ),
  ].sort((a, b) => a.localeCompare(b))
  const folders = childNames.map((child) =>
    folderTree(`${rootPath} / ${child}`, below),
  )
  return {
    name,
    path: rootPath,
    files: own,
    folders,
    count: own.length + folders.reduce((n, f) => n + f.count, 0),
  }
}
