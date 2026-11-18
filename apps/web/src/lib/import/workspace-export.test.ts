import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { unzipSync, strFromU8 } from 'fflate'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  document,
  entity,
  link,
  note,
  objectDef,
  pendingBlob,
} from '@spaces/db/schema'
import { storage } from '@spaces/core/writes/storage'
import { exportWorkspaceProgram } from '@spaces/core/writes/export/workspace'
import { importObjectOf } from '@spaces/core/writes/import/registry'
import {
  EXPORT_KEEP_MS,
  EXPORT_KEY,
  exportSummary,
} from '@spaces/core/export/workspace'
import { autoMap, validateMapping } from '@spaces/core/import/mapping'
import { readGrid } from '@spaces/core/import/read'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { seedDemoData } from '../seeds/demo'
import { beginImportMappingProgram } from './mapping'
import { stageImportProgram } from './stage'
import {
  WorkspaceExportGone,
  startWorkspaceExportProgram,
  workspaceExportProgram,
  workspaceExportUrlProgram,
} from './workspace-export'
import type { WorkspaceExport } from '@spaces/core/writes/export/workspace'

/**
 * The workspace export, end to end against the demo seed: the zip holds one
 * CSV per object, the shared notes and the manifest with its blobs; nothing
 * private; a company CSV goes back through Import with every column mapped;
 * and the settings row's state follows the job and the zip's day.
 */

type Job = {
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'
  output: object | null
  createdOn: Date
}

const queue = vi.hoisted(() => ({
  jobs: new Array<Job>(),
  sent: new Array<{ name: string; data: object; key: string | undefined }>(),
}))

vi.mock('#/lib/queue', () => ({
  enqueue: (
    name: string,
    data: object,
    options?: { singletonKey?: string },
  ) => {
    queue.sent.push({ name, data, key: options?.singletonKey })
    return Promise.resolve('job')
  },
  jobsByKey: () => Promise.resolve(queue.jobs),
}))

const ME = FIXTURE_ACTOR.id

const shaOf = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

async function objectIdOf(slug: string): Promise<string> {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, slug))
  ).at(0)
  if (!row) throw new Error(`${slug} missing`)
  return row.id
}

async function addNote(input: {
  title: string
  body: string
  visibility: 'shared' | 'private'
  filedOn: string | null
}) {
  const born = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: input.title })
      .returning({ id: entity.id })
  ).at(0)
  if (!born) throw new Error('note insert returned no row')
  await db.insert(note).values({
    entityId: born.id,
    title: input.title,
    bodyMd: input.body,
    authorId: ME,
    visibility: input.visibility,
  })
  if (input.filedOn !== null)
    await db.insert(link).values({
      fromEntityId: born.id,
      toEntityId: input.filedOn,
      relation: 'tagged_in',
    })
}

async function addDocument(input: {
  filename: string
  bytes: string
  visibility: 'shared' | 'private'
  filedOn: string | null
}): Promise<string> {
  const bytes = new TextEncoder().encode(input.bytes)
  const sha = shaOf(bytes)
  await storage().put(sha, Buffer.from(bytes), {})
  const born = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: input.filename })
      .returning({ id: entity.id })
  ).at(0)
  if (!born) throw new Error('document insert returned no row')
  await db.insert(document).values({
    entityId: born.id,
    blobSha: sha,
    filename: input.filename,
    sizeBytes: bytes.byteLength,
    visibility: input.visibility,
    authorId: ME,
  })
  if (input.filedOn !== null)
    await db.insert(link).values({
      fromEntityId: born.id,
      toEntityId: input.filedOn,
      relation: 'tagged_in',
    })
  return sha
}

let exported: WorkspaceExport
let files: Map<string, Uint8Array>
let deckSha: string
let privateSha: string

beforeAll(async () => {
  expect(await seedDemoData(ME)).toEqual({ seeded: true })
  const company = (
    await db
      .select({ id: entity.id, name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.kind, 'company'))
      .limit(1)
  ).at(0)
  if (!company) throw new Error('the demo seeded no company')
  await addNote({
    title: 'Intro call',
    body: 'They ship in March.',
    visibility: 'shared',
    filedOn: company.id,
  })
  await addNote({
    title: 'Partner only',
    body: 'PRIVATE-NOTE-BODY',
    visibility: 'private',
    filedOn: company.id,
  })
  deckSha = await addDocument({
    filename: 'deck.pdf',
    bytes: 'the deck bytes',
    visibility: 'shared',
    filedOn: company.id,
  })
  privateSha = await addDocument({
    filename: 'attachment.pdf',
    bytes: 'a private attachment',
    visibility: 'private',
    filedOn: null,
  })
  exported = await Effect.runPromise(
    exportWorkspaceProgram({ requestedBy: ME }),
  )
  files = new Map(
    Object.entries(unzipSync(await storage().getBytes(exported.sha))),
  )
})

const text = (name: string) => {
  const bytes = files.get(name)
  if (bytes === undefined) throw new Error(`${name} is not in the zip`)
  return strFromU8(bytes)
}

describe('the zip', () => {
  it('holds one CSV per object, each headed by the columns the import reads', async () => {
    const objects = await db
      .select({ id: objectDef.id, slug: objectDef.slug })
      .from(objectDef)
    expect(objects.length).toBeGreaterThanOrEqual(3)
    expect(exported.objects).toBe(objects.length)
    for (const o of objects) {
      const grid = readGrid(
        files.get(`${o.slug}.csv`) ?? new Uint8Array(),
        'x.csv',
      )
      const sheet = grid.sheets.at(0)
      if (!sheet) throw new Error(`${o.slug}.csv has no sheet`)
      const object = await Effect.runPromise(importObjectOf(o.id))
      if (!object) throw new Error(`${o.slug} has no registry`)
      const header = sheet.rows.at(0) ?? []
      expect(header.at(0)).toBe('Name')
      // Every column maps back with no hand on the mapping.
      const mapping = autoMap(header, object.registry)
      expect(mapping.filter((t) => t.target === 'ignore')).toEqual([])
      expect(validateMapping(mapping, object.registry, header)).toEqual([])
    }
    const companies = readGrid(
      files.get('companies.csv') ?? new Uint8Array(),
      'x',
    ).sheets.at(0)
    const names = (companies?.rows ?? []).slice(1).map((r) => r.at(0))
    const demo = await db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.kind, 'company'))
    expect(names.sort()).toEqual(demo.map((d) => d.name).sort())
  })

  it('writes each shared note as markdown with front matter, and no private one', () => {
    const notes = [...files.keys()].filter((f) => f.startsWith('notes/'))
    const intro = notes.find((f) => f.includes('intro-call'))
    if (intro === undefined) throw new Error('the shared note is missing')
    const md = text(intro)
    expect(md.startsWith('---\ntitle: "Intro call"\nkind: note\n')).toBe(true)
    expect(md).toContain('author: "Test Fixture <fixture@spaces.test>"')
    expect(md).toMatch(/filed_on:\n {2}- "[^"]+"/)
    expect(md).toMatch(/created: \d{4}-\d{2}-\d{2}T/)
    expect(md).toContain('They ship in March.')
    expect(notes.some((f) => f.includes('partner-only'))).toBe(false)
    for (const f of [...files.keys()])
      expect(strFromU8(files.get(f) ?? new Uint8Array())).not.toContain(
        'PRIVATE-NOTE-BODY',
      )
    expect(exported.notes).toBe(notes.length)
  })

  it('lists the shared documents in the manifest beside their blob tree, and no private one', () => {
    const manifest = readGrid(
      files.get('documents/manifest.csv') ?? new Uint8Array(),
      'manifest.csv',
    ).sheets.at(0)
    expect(manifest?.rows.at(0)).toEqual([
      'Name',
      'Size',
      'SHA-256',
      'Filed on',
    ])
    const deck = manifest?.rows.find((r) => r.at(0) === 'deck.pdf')
    expect(deck?.slice(1, 3)).toEqual([String(14), deckSha])
    expect(deck?.at(3)).not.toBe('')
    expect(
      strFromU8(
        files.get(`documents/blobs/${deckSha.slice(0, 2)}/${deckSha}`) ??
          new Uint8Array(),
      ),
    ).toBe('the deck bytes')
    expect(manifest?.rows.some((r) => r.at(0) === 'attachment.pdf')).toBe(false)
    expect([...files.keys()].some((f) => f.endsWith(privateSha))).toBe(false)
  })

  it('is held under a pending_blob row, so the orphan sweep deletes it after a day', async () => {
    const row = (
      await db
        .select({ by: pendingBlob.preparedBy, size: pendingBlob.sizeBytes })
        .from(pendingBlob)
        .where(eq(pendingBlob.sha, exported.sha))
    ).at(0)
    expect(row).toEqual({ by: ME, size: exported.sizeBytes })
  })
})

describe('re-importing a company CSV', () => {
  it('maps every column through Import with no manual mapping', async () => {
    const staged = await Effect.runPromise(
      stageImportProgram({
        filename: 'companies.csv',
        bytes: files.get('companies.csv') ?? new Uint8Array(),
        mime: 'text/csv',
        mode: 'records',
        targetObjectId: await objectIdOf('companies'),
        allowDuplicate: true,
        userId: ME,
      }),
    )
    if (staged.kind !== 'staged') throw new Error('the CSV did not stage')
    const mapping = await Effect.runPromise(
      beginImportMappingProgram(staged.batchId),
    )
    expect(mapping.length).toBeGreaterThan(5)
    expect(mapping.filter((t) => t.target === 'ignore')).toEqual([])
    expect(mapping.at(0)).toEqual({ target: 'name' })
    expect(mapping.at(1)).toEqual({ target: 'identity', key: 'domain' })
  })
})

describe("the settings row's state", () => {
  const read = (now?: Date) => Effect.runPromise(workspaceExportProgram(now))

  it('is none before any export, and running once sent', async () => {
    queue.jobs = []
    expect(await read()).toEqual({ state: 'none' })
    queue.jobs = [{ state: 'created', output: null, createdOn: new Date() }]
    expect(await Effect.runPromise(startWorkspaceExportProgram(ME))).toEqual({
      state: 'running',
    })
    expect(queue.sent.at(-1)).toEqual({
      name: QUEUES.exportWorkspace,
      data: { requestedBy: ME },
      key: EXPORT_KEY,
    })
  })

  it('offers the zip with its size for a day, then nothing', async () => {
    queue.jobs = [
      {
        state: 'completed',
        output: { kind: 'completed', reason: exportSummary(exported) },
        createdOn: new Date(),
      },
      { state: 'failed', output: { reason: 'older' }, createdOn: new Date(0) },
    ]
    const ready = await read()
    expect(ready).toMatchObject({
      state: 'ready',
      sizeBytes: exported.sizeBytes,
    })
    const { url } = await Effect.runPromise(workspaceExportUrlProgram())
    expect(url).toContain(exported.sha)
    expect(url).toMatch(/spaces-export-\d{4}-\d{2}-\d{2}\.zip/)

    const later = new Date(Date.now() + EXPORT_KEEP_MS + 60_000)
    expect(await read(later)).toEqual({ state: 'none' })
    const gone = await Effect.runPromise(
      Effect.flip(workspaceExportUrlProgram(later)),
    )
    expect(gone).toBeInstanceOf(WorkspaceExportGone)
  })

  it('says why a failed export failed', async () => {
    queue.jobs = [
      {
        state: 'cancelled',
        output: {
          kind: 'permanent',
          reason: 'The export could not be written: disk full',
        },
        createdOn: new Date(),
      },
    ]
    expect(await read()).toEqual({
      state: 'failed',
      reason: 'The export could not be written: disk full',
    })
  })
})
