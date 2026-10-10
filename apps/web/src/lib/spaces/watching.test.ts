import { Effect, Exit } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  signal,
  space,
  spaceWatch,
} from '@spaces/db/schema'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import { jsonRecord, jsonValue } from '@spaces/core/json'
import {
  addSpaceWatchProgram,
  spaceMovingProgram,
  spaceWatchingProgram,
} from './watching'

/**
 * The space page's watching reads and Add watch's write, against this
 * worker's test database (truncated before the file).
 */

const manifest = (id: string, name: string, watch: boolean) =>
  jsonRecord(
    jsonValue.parse(
      toManifestJson(
        defineManifest({
          manifestVersion: 1,
          id,
          version: '0.1.0',
          sdk: '^1.5',
          name,
          description: 'A test engine.',
          settings: z.object({}),
          jobs: watch
            ? {
                watch: {
                  trigger: 'watch',
                  uses: ['Spaces'],
                  settings: z.object({
                    criteria: z.string().optional(),
                    cap: z.int().min(1).max(100).default(10),
                  }),
                },
              }
            : {
                tick: {
                  trigger: 'schedule',
                  schedule: '0 * * * *',
                  uses: ['Log'],
                },
              },
        }),
      ),
    ),
  )

const anIntegration = async (
  id: string,
  name: string,
  values: {
    watch?: boolean
    enabled?: boolean
    status?: 'enabled' | 'degraded' | 'disabled'
    lastError?: string
  } = {},
) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: id,
        version: '0.1.0',
        enabled: values.enabled ?? true,
        status: values.status ?? 'enabled',
        lastError: values.lastError ?? null,
        manifest: manifest(id, name, values.watch ?? true),
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  return row.id
}

let n = 0
const aSpace = async (
  name: string,
  parent?: { id: string; path: string },
  criteria: string | null = null,
) => {
  n += 1
  const slug = `w${n}`
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  const path = parent === undefined ? slug : `${parent.path}.${slug}`
  await db.insert(space).values({
    entityId: ent.id,
    parentId: parent?.id ?? null,
    slug,
    path,
    criteria,
  })
  return { id: ent.id, path }
}

const aCompany = async (name: string, spaceIds: Array<string>) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no company')
  for (const spaceId of spaceIds)
    await db.insert(entitySpace).values({ entityId: ent.id, spaceId })
  return ent.id
}

const user = async () =>
  (await db.execute<{ id: string }>('select id from "user" limit 1')).rows[0].id

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

describe('Add watch', () => {
  it('saves a manual watch, blanks a setting equal to the criteria, and refuses the same lens twice', async () => {
    const s = await aSpace('Manufacturing', undefined, 'Factories in orbit.')
    const exa = await anIntegration('exa', 'Exa')
    const me = await user()
    const saved = await Effect.runPromise(
      addSpaceWatchProgram(me, {
        spaceId: s.id,
        integrationId: exa,
        values: { criteria: 'Factories in orbit.', cap: '7' },
        cadenceMinutes: null,
      }),
    )
    const row = (
      await db.select().from(spaceWatch).where(eq(spaceWatch.id, saved.id))
    ).at(0)
    expect(row).toMatchObject({
      spaceId: s.id,
      integrationId: exa,
      settings: { cap: 7 },
      cadenceMinutes: null,
      createdBy: me,
    })
    const again = await Effect.runPromiseExit(
      addSpaceWatchProgram(me, {
        spaceId: s.id,
        integrationId: exa,
        values: { criteria: '', cap: '7' },
        cadenceMinutes: 1440,
      }),
    )
    expect(failureOf(again)).toMatchObject({ message: 'Already watching this' })
  })

  it('refuses an engine that is not running, one with no watch, and a setting its schema refuses', async () => {
    const s = await aSpace('Refusals')
    const me = await user()
    const degraded = await anIntegration('degraded', 'Degraded', {
      status: 'degraded',
      lastError: 'Exa key removed',
    })
    const plain = await anIntegration('plain', 'Plain', { watch: false })
    const exa = await anIntegration('exa2', 'Exa')
    const add = (integrationId: string, cap: string) =>
      Effect.runPromiseExit(
        addSpaceWatchProgram(me, {
          spaceId: s.id,
          integrationId,
          values: { cap },
          cadenceMinutes: null,
        }),
      )
    expect(failureOf(await add(degraded, '5'))).toMatchObject({
      message: 'Degraded is not running — Exa key removed',
    })
    expect(failureOf(await add(plain, '5'))).toMatchObject({
      message: 'That plugin offers no watch',
    })
    expect(failureOf(await add(exa, '500'))).toMatchObject({
      errors: { cap: 'must be between 1 and 100' },
    })
    expect(
      await db.select().from(spaceWatch).where(eq(spaceWatch.spaceId, s.id)),
    ).toEqual([])
  })
})

describe('spaceWatchingProgram', () => {
  it('reads the watches and why a stopped engine cannot run, the engines to add with, and the installed ones', async () => {
    const s = await aSpace('Watched')
    const exa = await anIntegration('exa3', 'Exa')
    const harmonic = await anIntegration('harmonic', 'Harmonic', {
      status: 'degraded',
      lastError: 'Harmonic key removed',
    })
    await anIntegration('plain2', 'Plain', { watch: false })
    const insertWatch = async (
      integrationId: string,
      settings: { [k: string]: string | number },
    ) => {
      const row = (
        await db
          .insert(spaceWatch)
          .values({ spaceId: s.id, integrationId, settings })
          .returning({ id: spaceWatch.id })
      ).at(0)
      if (!row) throw new Error('no watch')
      return row.id
    }
    const fabs = await insertWatch(exa, { criteria: 'Orbital fabs', cap: 5 })
    const tugs = await insertWatch(harmonic, { cap: 3 })

    // No run yet: `job_run` is runJob's alone to write, so none is seeded.
    const watching = await Effect.runPromise(spaceWatchingProgram(s.id))
    expect(
      watching.watches.map((w) => ({
        id: w.id,
        engine: w.engine,
        label: w.label,
        run: w.run,
        stopped: w.stopped,
      })),
    ).toEqual([
      {
        id: fabs,
        engine: 'Exa',
        label: 'Orbital fabs',
        run: null,
        stopped: null,
      },
      {
        id: tugs,
        engine: 'Harmonic',
        label: 'Harmonic',
        run: null,
        stopped: 'Harmonic key removed',
      },
    ])
    // Earlier tests in this file left their engines behind; read only ours.
    const ids = watching.engines.map((e) => e.integrationId)
    expect(ids).toContain(exa)
    expect(ids).not.toContain(harmonic)
    expect(
      watching.engines.find((e) => e.integrationId === exa)?.form,
    ).toMatchObject({
      ok: true,
      // jsonb keeps keys shortest first, not in declaration order.
      fields: [{ key: 'cap' }, { key: 'criteria' }],
    })
    expect(watching.installed).toContain('Harmonic')
    expect(watching.installed).not.toContain('Plain')
  })
})

describe('spaceMovingProgram', () => {
  it("lists signals on the space's members and its subspaces' newest first, with the subspace they came via and their source", async () => {
    const root = await aSpace('In-space manufacturing')
    const sub = await aSpace('Pharma in orbit', root)
    const exa = await anIntegration('exa4', 'Exa')
    const varda = await aCompany('Varda', [sub.id])
    const both = await aCompany('Both', [root.id, sub.id])
    const outsider = await aCompany('Outsider', [])
    const emit = (
      entityId: string,
      title: string,
      at: string,
      fromExa: boolean,
    ) => ({
      entityId,
      source: fromExa ? 'exa4' : 'manual',
      payload: {
        kind: 'web',
        title,
        url: 'https://news.example/varda',
        refs: ['event:00000000-0000-4000-8000-000000000009'],
      },
      sourceClass: fromExa ? ('integration' as const) : ('manual' as const),
      sourceRef: fromExa ? exa : null,
      observedAt: new Date(at),
    })
    await db
      .insert(signal)
      .values([
        emit(varda, 'Varda raised', '2026-10-08T09:00:00Z', true),
        emit(varda, 'Varda landed', '2026-10-10T09:00:00Z', true),
        emit(both, 'Both hired', '2026-10-09T09:00:00Z', false),
        emit(outsider, 'Not here', '2026-10-10T10:00:00Z', true),
      ])

    const moving = await Effect.runPromise(spaceMovingProgram(root.id))
    expect(
      moving.map((m) => ({
        record: m.recordName,
        title: m.title,
        via: m.via?.name ?? null,
        source: m.source,
      })),
    ).toEqual([
      {
        record: 'Varda',
        title: 'Varda landed',
        via: 'Pharma in orbit',
        source: 'Exa',
      },
      { record: 'Both', title: 'Both hired', via: null, source: 'manual' },
      {
        record: 'Varda',
        title: 'Varda raised',
        via: 'Pharma in orbit',
        source: 'Exa',
      },
    ])
    expect(moving.at(0)).toMatchObject({
      url: 'https://news.example/varda',
      refs: ['event:00000000-0000-4000-8000-000000000009'],
    })
  })
})
