import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { attributeEvent, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { workspace } from '@spaces/db/schema/workspace'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import { jsonRecord, jsonValue } from '@spaces/core/json'
import {
  enrichmentSettingsOf,
  scopeFor,
  withBuiltIn,
} from '@spaces/core/enrichment/settings'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import { updateAttributeProgram } from '@spaces/core/writes/attributes/update'
import { enrichmentRow } from '@spaces/core/writes/enrichment/apply'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { integrationDetailProgram } from '#/lib/integrations/ledger'
import {
  enrichmentPageProgram,
  saveAutoEnrichProgram,
  saveReuseDaysProgram,
  saveSourceOrderProgram,
} from './enrichment-page'
import { whereFromProgram } from './enrichment-record'

/**
 * Settings → Integrations → Enrichment against a real database: the order
 * and auto-enrich written where the run and the auto checks read them,
 * What fills what, Apollo's page, and a filled headcount's where-from. (D76)
 */

const manifestFor = (id: string, name: string) =>
  jsonRecord(
    jsonValue.parse(
      toManifestJson(
        defineManifest({
          manifestVersion: 1,
          id,
          version: '0.1.0',
          sdk: '^1.4',
          name,
          roles: ['enrichment'],
          description: `${name} enrichment.`,
          settings: z.object({
            cacheDays: z.int().min(0).default(90),
            dailyCreditCap: z.int().min(0).default(100),
            phone: z.boolean().default(false),
          }),
          jobs: {
            enrichCompany: { trigger: 'action', uses: ['Facts'] },
            autoEnrich: {
              trigger: 'event',
              on: ['deal.linked'],
              uses: ['Facts'],
            },
          },
          actions: [
            {
              id: 'enrich-company',
              label: 'Enrich',
              on: 'company',
              job: 'enrichCompany',
              answers: ['company.headcount', 'company.description'],
            },
          ],
        }),
      ),
    ),
  )

const install = async (id: string, name: string) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: id,
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        manifest: manifestFor(id, name),
      })
      .returning({ id: integration.id })
  ).at(0)
  if (row === undefined) throw new Error('no row')
  return row.id
}

const run = <T, TError>(program: Effect.Effect<T, TError>) =>
  Effect.runPromise(program)

const storedSettings = async () =>
  (await db.select({ settings: workspace.settings }).from(workspace)).at(0)
    ?.settings ?? {}

let apollo: string
let exa: string
let website: string
let employees: { id: string; slug: string }

beforeAll(async () => {
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund' })
    .onConflictDoNothing({ target: workspace.id })
  apollo = await install('apollo', 'Apollo')
  exa = await install('exa', 'Exa')
  website = (await enrichmentRow()).id
  const fixtureUser = (await db.select({ id: user.id }).from(user).limit(1)).at(
    0,
  )
  if (fixtureUser === undefined) throw new Error('no fixture user')
  employees = await run(
    createAttributeProgram({
      objectKind: 'company',
      name: 'Employees',
      type: 'number',
      createdBy: fixtureUser.id,
    }),
  )
})

describe('the sources in order', () => {
  it('writes the order the run follows, the Website kept, a left-out source off', async () => {
    await run(saveSourceOrderProgram([apollo, website]))
    const settings = enrichmentSettingsOf(await storedSettings())
    expect(settings.sources).toEqual([apollo, website])
    // The run's own composition: Apollo is asked before the Website, Exa not at all.
    expect(
      withBuiltIn(settings, { id: website }, [{ id: apollo }, { id: exa }]).map(
        (s) => s.id,
      ),
    ).toEqual([apollo, website])

    const page = await run(enrichmentPageProgram())
    expect(page.sources.map((s) => [s.name, s.on])).toEqual([
      ['Apollo', true],
      ['Website', true],
      ['Exa', false],
    ])
    expect(page.sources[0].sends).toBe('domain')
    expect(page.sources[1]).toMatchObject({
      builtIn: true,
      sends: 'nothing out · free',
      integrationId: null,
    })
    expect(page.sources[2].state).toBe('off')
  })

  it('refuses a source that is not installed', async () => {
    await expect(
      run(saveSourceOrderProgram(['00000000-0000-4000-8000-0000000000ff'])),
    ).rejects.toThrow('That source is not installed')
  })
})

describe('auto-enrich and reuse', () => {
  it('writes one scope for every paid source and the reuse days the checks read', async () => {
    await run(saveAutoEnrichProgram({ scopes: ['deal', 'space'], spaces: [] }))
    await run(saveReuseDaysProgram(30))
    const settings = enrichmentSettingsOf(await storedSettings())
    expect(scopeFor(settings, apollo, {}).scopes).toEqual(['deal', 'space'])
    expect(scopeFor(settings, exa, {}).scopes).toEqual(['deal', 'space'])
    expect(settings.reuseDays).toBe(30)
    // The Website keeps its own scope: every new record.
    expect(settings.scopes.has(website)).toBe(false)

    const page = await run(enrichmentPageProgram())
    expect(page.auto.scopes).toEqual(['deal', 'space'])
    expect(page.reuse).toEqual({ days: 30, stored: true })
  })
})

describe('What fills what', () => {
  it('shows an unlinked attribute as not linked, and once linked, the first source in order', async () => {
    const before = await run(enrichmentPageProgram())
    const companies = before.grids.find((g) => g.kind === 'company')
    const row = companies?.rows.find((r) => r.slug === employees.slug)
    expect(row).toMatchObject({ key: null, filledBy: null })

    await run(
      updateAttributeProgram({
        id: employees.id,
        config: { enrichmentKey: 'company.headcount' },
      }),
    )
    const after = await run(enrichmentPageProgram())
    const grid = after.grids.find((g) => g.kind === 'company')
    expect(grid?.sources.map((s) => s.name)).toEqual([
      'Apollo',
      'Website',
      'Exa',
    ])
    const linked = grid?.rows.find((r) => r.slug === employees.slug)
    expect(linked).toMatchObject({
      key: 'company.headcount',
      keyWord: 'headcount',
      filledBy: 'Apollo',
      cells: ['fills', 'none', 'could'],
    })
    // Linked rows come before the unlinked ones.
    const keys = grid?.rows.map((r) => r.key) ?? []
    const firstUnlinked = keys.indexOf(null)
    if (firstUnlinked >= 0)
      expect(keys.slice(firstUnlinked).every((k) => k === null)).toBe(true)
  })
})

describe('a source’s own page', () => {
  it('carries the daily limit and the phone opt-in, leaves reuse and scope to the Enrichment page, and counts what it can fill', async () => {
    const detail = await run(integrationDetailProgram(apollo))
    const keys = detail.form.ok ? detail.form.fields.map((f) => f.key) : []
    expect([...keys].sort()).toEqual(['dailyCreditCap', 'phone'])
    expect(detail.autoEnrichForm).toBeNull()
    expect(detail.capabilities).toEqual([
      {
        what: expect.stringMatching(/^Can fill \d+ fields?$/),
        owner: 'enrichment',
      },
    ])
  })
})

describe('the where-from', () => {
  it('names the source, the day and the earlier headcount with its day', async () => {
    const co = (
      await resolveEntity({
        kind: 'company',
        name: 'Flent',
        source: { class: 'manual' },
      })
    ).entityId
    await db.insert(attributeEvent).values([
      {
        entityId: co,
        attrSlug: employees.slug,
        from: null,
        to: 42,
        actorType: 'integration',
        actorRef: apollo,
        source: 'enrichment',
        at: new Date('2026-07-12T09:00:00Z'),
      },
      {
        entityId: co,
        attrSlug: employees.slug,
        from: 42,
        to: 57,
        actorType: 'integration',
        actorRef: apollo,
        source: 'enrichment',
        at: new Date('2026-10-04T09:00:00Z'),
      },
    ])
    const found = await run(whereFromProgram(co))
    expect(found[employees.slug]).toEqual({
      source: 'Apollo',
      at: '2026-10-04T09:00:00.000Z',
      earlier: [{ value: '42', at: '2026-07-12T09:00:00.000Z' }],
    })
    await db.delete(attributeEvent).where(eq(attributeEvent.entityId, co))
  })
})
