import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { MIGRATIONS_FOLDER } from '@spaces/db/migrate'
import {
  attribute,
  attributeEvent,
  entity,
  entityAlias,
  objectDef,
} from '@spaces/db/schema'
import { normalizeLinkedin } from '@spaces/core/entities/normalize'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'

/**
 * The data migration that moved `values.linkedin` on people and companies
 * into `linkedin` identity aliases. The test database is already past it,
 * so the legacy values are written here by raw SQL (the write path refuses
 * them now) and the migration's statements are run again over them.
 */

const MIGRATION = path.join(MIGRATIONS_FOLDER, '0063_linkedin_identity.sql')

const statements = () =>
  readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s !== '')

async function runMigration() {
  for (const statement of statements()) await db.execute(sql.raw(statement))
}

const tag = () => randomUUID().slice(0, 8)

async function aRecord(kind: 'person' | 'company', name: string) {
  const t = tag()
  return (
    await resolveEntity({
      kind,
      name: `${name} ${t}`,
      ...(kind === 'company'
        ? { keys: { domain: `${name.toLowerCase()}-${t}.example` } }
        : {}),
      source: { class: 'manual' },
    })
  ).entityId
}

/** The legacy value, as the `linkedin` url attribute used to hold it. */
async function legacyLinkedin(entityId: string, url: string) {
  await db.execute(
    sql`update entity set "values" = "values" || jsonb_build_object('linkedin', ${url}::text) where id = ${entityId}`,
  )
}

/** The system attribute row the registry used to seed, live. */
async function legacyAttribute(objectSlug: 'people' | 'companies') {
  const object = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, objectSlug))
  ).at(0)
  if (!object) throw new Error(`no ${objectSlug} object`)
  const [row] = await db
    .insert(attribute)
    .values({
      objectId: object.id,
      slug: 'linkedin',
      name: 'LinkedIn',
      type: 'url',
      isSystem: true,
      filterable: true,
      sortable: true,
    })
    .onConflictDoNothing()
    .returning({ id: attribute.id })
  return row.id
}

async function linkedinAliases(entityId: string) {
  return db
    .select({
      valueNorm: entityAlias.valueNorm,
      value: entityAlias.value,
      isIdentity: entityAlias.isIdentity,
      sourceClass: entityAlias.sourceClass,
    })
    .from(entityAlias)
    .where(
      and(eq(entityAlias.entityId, entityId), eq(entityAlias.kind, 'linkedin')),
    )
}

async function valuesOf(id: string) {
  return (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)?.values
}

/**
 * The TS normalizer's answer where Postgres can hold one: a throw (a
 * malformed escape) or a NUL byte can never become an alias.
 */
function tsNorm(url: string): string | null {
  try {
    const norm = normalizeLinkedin(url)
    return norm !== null && norm.includes('\u0000') ? null : norm
  } catch {
    return null
  }
}

const SAMPLES: ReadonlyArray<string> = [
  'https://www.linkedin.com/in/anish-badri/?src=x',
  'linkedin.com/company/SpaceX/',
  'http://www.linkedin.com/company/northwind-robotics',
  '  https://linkedin.com/in/ishaanmehra  ',
  'HTTPS://WWW.LINKEDIN.COM/IN/Mixed_Case.Name',
  'https://in.linkedin.com/in/regional-host',
  'https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa/',
  'https://www.linkedin.com/in/percent%2fslash',
  'https://www.linkedin.com/in/bad%zz',
  'https://www.linkedin.com/in/bad%c3',
  'https://www.linkedin.com/in/nul%00',
  'https://linkedin.com/in/a/linkedin.com/in/b',
  'https://linkedin.com/in/foo?x\ny',
  'https://linkedin.com/in/foo?trk=a#frag',
  'https://linkedin.com/in/foo#frag',
  'https://linkedin.com/in/foo/bar',
  'https://linkedin.com/in/foo/\u00a0',
  'https://linkedin.com/in/',
  'https://linkedin.com/school/iit-madras',
  'https://linkedin.com/in/a.b_c-d',
  'https://linkedin.com/pub/old-style',
  'https://twitter.com/foo',
  'not a url',
  '',
]

describe('migration 0063: LinkedIn becomes identity on people and companies', () => {
  it('spells normalizeLinkedin in SQL: equal over the samples', async () => {
    const [create] = statements()
    await db.execute(sql.raw(create))
    try {
      for (const sample of SAMPLES) {
        const got = (
          await db.execute<{ norm: string | null }>(
            sql`select migrate_normalize_linkedin(${sample}::text) as norm`,
          )
        ).rows.at(0)?.norm
        expect({ sample, norm: got }).toEqual({ sample, norm: tsNorm(sample) })
      }
    } finally {
      await db.execute(
        sql.raw('drop function if exists migrate_normalize_linkedin(text)'),
      )
    }
  })

  it('moves every value to one identity alias, clears the key and archives the attributes', async () => {
    const peopleAttr = await legacyAttribute('people')
    const companiesAttr = await legacyAttribute('companies')
    const t = tag()
    const ishaan = await aRecord('person', 'Ishaan')
    const vayu = await aRecord('company', 'Vayu')
    const blank = await aRecord('person', 'Blank')
    await legacyLinkedin(ishaan, ` https://www.linkedin.com/in/ishaan-${t}/ `)
    await legacyLinkedin(vayu, `https://linkedin.com/company/vayu-${t}`)

    await runMigration()

    expect(await linkedinAliases(ishaan)).toEqual([
      {
        valueNorm: `linkedin.com/in/ishaan-${t}`,
        value: `https://www.linkedin.com/in/ishaan-${t}/`,
        isIdentity: true,
        sourceClass: 'seed',
      },
    ])
    expect(await linkedinAliases(vayu)).toEqual([
      expect.objectContaining({
        valueNorm: `linkedin.com/company/vayu-${t}`,
        isIdentity: true,
      }),
    ])
    expect(await linkedinAliases(blank)).toEqual([])
    for (const id of [ishaan, vayu, blank])
      expect(await valuesOf(id)).not.toHaveProperty('linkedin')

    const archived = await db
      .select({ id: attribute.id, archived: attribute.archived })
      .from(attribute)
      .where(eq(attribute.slug, 'linkedin'))
    expect(archived).toEqual(
      expect.arrayContaining([
        { id: peopleAttr, archived: true },
        { id: companiesAttr, archived: true },
      ]),
    )

    // History keeps the value that left `entity.values`.
    const events = await db
      .select({
        from: attributeEvent.from,
        to: attributeEvent.to,
        actorType: attributeEvent.actorType,
      })
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, ishaan),
          eq(attributeEvent.attrSlug, 'linkedin'),
        ),
      )
    expect(events).toEqual([
      {
        from: ` https://www.linkedin.com/in/ishaan-${t}/ `,
        to: null,
        actorType: 'system',
      },
    ])

    // Running it again changes nothing.
    await runMigration()
    expect(await linkedinAliases(ishaan)).toHaveLength(1)
  })

  it('lets resolveEntity match a person by a URL that only the attribute held', async () => {
    const t = tag()
    const ishaan = await aRecord('person', 'Ishaan')
    await legacyLinkedin(ishaan, `https://linkedin.com/in/ishaan-${t}`)

    await runMigration()

    const again = await resolveEntity({
      kind: 'person',
      name: 'Ishaan Mehra',
      keys: { linkedin: `https://www.linkedin.com/in/Ishaan-${t}/?trk=x` },
      source: { class: 'import' },
    })
    expect(again).toMatchObject({
      entityId: ishaan,
      action: 'attached',
      matchedOn: 'linkedin',
    })
  })

  it('collides with nothing: a held URL and an unreadable one get no alias, and the key still goes', async () => {
    const t = tag()
    // Already somebody's identity before the migration runs.
    const holder = (
      await resolveEntity({
        kind: 'person',
        name: `Holder ${t}`,
        keys: { linkedin: `linkedin.com/in/held-${t}` },
        source: { class: 'manual' },
      })
    ).entityId
    const first = await aRecord('person', 'First')
    const second = await aRecord('person', 'Second')
    const junk = await aRecord('company', 'Junk')
    const late = await aRecord('person', 'Late')
    await legacyLinkedin(late, `https://linkedin.com/in/held-${t}`)
    await legacyLinkedin(first, `https://linkedin.com/in/shared-${t}`)
    await legacyLinkedin(second, `https://www.linkedin.com/in/shared-${t}/`)
    await legacyLinkedin(junk, 'https://twitter.com/junk')

    await runMigration()

    expect(await linkedinAliases(holder)).toHaveLength(1)
    expect(await linkedinAliases(late)).toEqual([])
    expect(await linkedinAliases(first)).toHaveLength(1)
    expect(await linkedinAliases(second)).toEqual([])
    expect(await linkedinAliases(junk)).toEqual([])
    for (const id of [late, first, second, junk])
      expect(await valuesOf(id)).not.toHaveProperty('linkedin')
  })
})
