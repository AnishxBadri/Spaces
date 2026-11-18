import { joinImportList } from '@spaces/sdk/import-grid'
import { slugifyAttributeName } from '../attributes/registry'
import {
  IDENTITY_KEY_LABELS,
  autoMap,
  mappableAttributes,
} from '../import/mapping'
import type { CoreIdentityKey } from '../attributes/registry'
import type {
  ColumnTarget,
  MappingAttribute,
  MappingRegistry,
} from '../import/mapping'
import type { Json } from '@spaces/db/json'

/**
 * The workspace export's file shapes, pure: which columns an object's
 * CSV carries and how each stored value reads as a cell, the CSV and front
 * matter encoders, and the one line the export job hands back. The program
 * that reads the database and writes the zip is
 * `@spaces/core/writes/export/workspace`.
 */

/** How long a finished zip may be downloaded; the orphan sweep deletes it after. */
export const EXPORT_KEEP_MS = 24 * 60 * 60 * 1000

/** The export queue's one `singletonKey`: one export queued or running at a time. */
export const EXPORT_KEY = 'workspace'

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export type ExportColumn = {
  header: string
  source:
    | { kind: 'name' }
    /** `slug` is the attribute that holds the key's values, when one does. */
    | { kind: 'identity'; key: CoreIdentityKey; slug: string | null }
    | { kind: 'attribute'; attribute: MappingAttribute }
}

const targetOf = (source: ExportColumn['source']): ColumnTarget => {
  switch (source.kind) {
    case 'name':
      return { target: 'name' }
    case 'identity':
      return { target: 'identity', key: source.key }
    case 'attribute':
      return { target: 'attribute', attributeId: source.attribute.id }
  }
}

const sameTarget = (a: ColumnTarget, b: ColumnTarget): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/**
 * An object's CSV columns, in the import's order: the name, each identity
 * key, then every attribute the mapping offers, as the registry orders them.
 * - A derived reference is left out: it stores nothing, and its values are
 *   the owning attribute's column on the other object.
 * - Headers are the names the import shows. One whose name the import would
 *   read as another target (a name that is another attribute's slug) is
 *   headed by its own slug instead, so `autoMap` takes every column back to
 *   where it came from.
 */
export function exportColumns(registry: MappingRegistry): Array<ExportColumn> {
  const columns: Array<ExportColumn> = [
    { header: 'Name', source: { kind: 'name' } },
    ...registry.identityKeys.map((key): ExportColumn => ({
      header: IDENTITY_KEY_LABELS[key],
      source: {
        kind: 'identity',
        key,
        slug:
          registry.attributes.find(
            (a) => !a.archived && a.options.identityKey === key,
          )?.slug ?? null,
      },
    })),
    ...mappableAttributes(registry)
      .filter((a) => a.options.derived !== true)
      .map((attribute): ExportColumn => ({
        header: attribute.name,
        source: { kind: 'attribute', attribute },
      })),
  ]
  const wants = columns.map((c) => targetOf(c.source))
  const slugOf = (c: ExportColumn) =>
    c.source.kind === 'attribute' ? c.source.attribute.slug : c.header
  const misread = (headers: ReadonlyArray<string>) =>
    autoMap(headers, registry).flatMap((got, i) =>
      sameTarget(got, wants[i]) ? [] : [{ i, got }],
    )
  // A column whose header took another column's target goes to its slug
  // first, which frees that target for the column it belongs to; any column
  // still read wrong once nothing is taken goes to its slug too.
  let headers = columns.map((c) => c.header)
  // Each round moves at least one header, so the rounds are bounded.
  let rounds = columns.length
  while (rounds-- > 0) {
    const takers = misread(headers).filter(
      ({ i, got }) =>
        got.target !== 'ignore' && headers[i] !== slugOf(columns[i]),
    )
    if (takers.length === 0) break
    const moved = new Set(takers.map((t) => t.i))
    headers = headers.map((h, i) => (moved.has(i) ? slugOf(columns[i]) : h))
  }
  const still = new Set(misread(headers).map((m) => m.i))
  return columns.map((column, i) => ({
    ...column,
    header: still.has(i) ? slugOf(column) : headers[i],
  }))
}

/** What a reference cell names: a record by its name, a member by email. */
export type ExportLookups = {
  readonly recordNames: ReadonlyMap<string, string>
  readonly memberEmails: ReadonlyMap<string, string>
}

const scalarText = (value: Json): string => {
  if (value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return JSON.stringify(value)
}

const listOf = (value: Json | undefined): Array<Json> =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value]

/**
 * One stored value as the cell the import's `coerce` reads back: an option
 * by its label, a record by its name, a member by their email, a list
 * through `joinImportList`. An id the lookups do not know is written as is.
 */
export function exportCell(
  attribute: Pick<MappingAttribute, 'type' | 'options'>,
  value: Json | undefined,
  lookups: ExportLookups,
): string {
  const items = listOf(value).map(scalarText)
  const labels = (ids: Array<string>) =>
    ids.map(
      (id) => attribute.options.options?.find((o) => o.id === id)?.label ?? id,
    )
  switch (attribute.type) {
    case 'select':
    case 'status':
    case 'multi_select':
      return joinImportList(labels(items))
    case 'record_reference':
      return joinImportList(
        items.map((id) => lookups.recordNames.get(id) ?? id),
      )
    case 'actor_reference':
      return joinImportList(
        items.map((id) => lookups.memberEmails.get(id) ?? id),
      )
    default:
      return Array.isArray(value) ? joinImportList(items) : (items.at(0) ?? '')
  }
}

/** A record's row, cell for cell with `columns`. */
export function exportRow(
  columns: ReadonlyArray<ExportColumn>,
  record: { name: string; values: { [slug: string]: Json } },
  lookups: ExportLookups,
): Array<string> {
  return columns.map((column) => {
    const source = column.source
    switch (source.kind) {
      case 'name':
        return record.name
      case 'identity':
        // The import reads one key per row; the first value is the one that
        // finds the record again.
        return source.slug === null
          ? ''
          : (listOf(record.values[source.slug]).map(scalarText).at(0) ?? '')
      case 'attribute':
        return exportCell(
          source.attribute,
          record.values[source.attribute.slug],
          lookups,
        )
    }
  })
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** The byte-order mark Excel needs to read a CSV as UTF-8; the import drops it. */
export const CSV_BOM = '﻿'

/** One RFC 4180 record, CRLF-terminated, a field quoted only when it must be. */
export function csvLine(cells: ReadonlyArray<string>): string {
  return `${cells
    .map((cell) =>
      /[",\r\n]/.test(cell) || cell !== cell.trim()
        ? `"${cell.replaceAll('"', '""')}"`
        : cell,
    )
    .join(',')}\r\n`
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export type ExportNote = {
  id: string
  title: string
  kind: string
  /** `Name <email>`, or null when the author is no longer a member. */
  author: string | null
  filedOn: ReadonlyArray<string>
  createdAt: Date
  updatedAt: Date
  body: string
}

/** A YAML scalar: JSON's double-quoted string is a valid YAML one. */
const yamlString = (s: string) => JSON.stringify(s)

/** A note as markdown: front matter, then its derived markdown body. */
export function noteMarkdown(note: ExportNote): string {
  const lines = [
    '---',
    `title: ${yamlString(note.title)}`,
    `kind: ${note.kind}`,
    `author: ${note.author === null ? 'null' : yamlString(note.author)}`,
    note.filedOn.length === 0
      ? 'filed_on: []'
      : ['filed_on:', ...note.filedOn.map((r) => `  - ${yamlString(r)}`)].join(
          '\n',
        ),
    `created: ${note.createdAt.toISOString()}`,
    `updated: ${note.updatedAt.toISOString()}`,
    '---',
    '',
  ]
  return `${lines.join('\n')}${note.body}${note.body.endsWith('\n') ? '' : '\n'}`
}

/**
 * `notes/2026-11-18-intro-call-3f2a9c1e.md`: the day it was written, its
 * title, and the head of its id, so two notes with one title never collide.
 */
export function notePath(note: Pick<ExportNote, 'id' | 'title' | 'createdAt'>) {
  const slug = slugifyAttributeName(note.title).slice(0, 60) || 'untitled'
  const day = note.createdAt.toISOString().slice(0, 10)
  return `notes/${day}-${slug.replaceAll('_', '-')}-${note.id.slice(0, 8)}.md`
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const MANIFEST_HEADER = ['Name', 'Size', 'SHA-256', 'Filed on']

/** Where a blob sits in the zip: the local store's own `<aa>/<sha>` tree. */
export const blobEntry = (sha: string) =>
  `documents/blobs/${sha.slice(0, 2)}/${sha}`

// ---------------------------------------------------------------------------
// The job's line
// ---------------------------------------------------------------------------

export type ExportCounts = {
  objects: number
  records: number
  notes: number
  documents: number
}

export type ExportStored = { sha: string; sizeBytes: number }

/**
 * The line the export job closes with: the zip's digest and size first,
 * which `readExportSummary` reads back, then what it holds.
 */
export function exportSummary(stored: ExportStored & ExportCounts): string {
  return `${stored.sha} · ${String(stored.sizeBytes)} bytes · ${String(stored.objects)} objects · ${String(stored.records)} records · ${String(stored.notes)} notes · ${String(stored.documents)} documents`
}

/** The digest and size `exportSummary` wrote, or null for any other line. */
export function readExportSummary(line: string): ExportStored | null {
  const m = /^([a-f0-9]{64}) · (\d+) bytes/.exec(line)
  if (m === null) return null
  return { sha: m[1], sizeBytes: Number(m[2]) }
}
