import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
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
import { resolveEntity } from '@spaces/core/writes/entities/resolve'

/**
 * The data migration that made identity a unique attribute: every live
 * person's email aliases become `values.emails`, every company's domain
 * aliases `values.domains`, LinkedIn aliases on either go back to the plain
 * `values.linkedin`, and `cin` leaves `alias_kind`. The test database is past
 * it, so the legacy shape is written here by raw SQL and the migration's
 * statements are run again over it.
 */

const MIGRATION = path.join(MIGRATIONS_FOLDER, '0064_identity_values.sql')

async function runMigration() {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  for (const statement of statements) await db.execute(sql.raw(statement))
}

const tag = () => randomUUID().slice(0, 8)

/** A record as it stood before: identity in aliases only, none in values. */
async function legacy(
  kind: 'person' | 'company',
  name: string,
  aliases: Array<{ kind: 'email' | 'domain' | 'linkedin'; value: string }>,
) {
  const { entityId } = await resolveEntity({
    kind,
    name,
    source: { class: 'manual' },
  })
  let at = Date.parse('2026-01-01T00:00:00Z')
  for (const a of aliases) {
    at += 60_000
    await db.insert(entityAlias).values({
      entityId,
      kind: a.kind,
      value: a.value,
      valueNorm: a.value.toLowerCase().replace(/^https?:\/\/(www\.)?/, ''),
      isIdentity: true,
      createdAt: new Date(at),
    })
  }
  return entityId
}

async function valuesOf(id: string) {
  return (
    (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, id))
    ).at(0)?.values ?? {}
  )
}

async function eventsOf(id: string, slug: string) {
  return db
    .select({
      from: attributeEvent.from,
      to: attributeEvent.to,
      actorType: attributeEvent.actorType,
      source: attributeEvent.source,
    })
    .from(attributeEvent)
    .where(
      and(eq(attributeEvent.entityId, id), eq(attributeEvent.attrSlug, slug)),
    )
}

describe('migration 0064: identity is a unique attribute', () => {
  it('writes values from the aliases, oldest first, once', async () => {
    const t = tag()
    const ishaan = await legacy('person', `Ishaan ${t}`, [
      { kind: 'email', value: `ishaan-${t}@vayuorbital.com` },
      { kind: 'email', value: `Ishaan.${t}@Gmail.com` },
      { kind: 'linkedin', value: `linkedin.com/in/ishaan-${t}` },
    ])
    const vayu = await legacy('company', `Vayu ${t}`, [
      { kind: 'domain', value: `vayu-${t}.com` },
      { kind: 'domain', value: `vayu-${t}.in` },
      { kind: 'linkedin', value: `https://linkedin.com/company/vayu-${t}` },
    ])

    await runMigration()

    expect(await valuesOf(ishaan)).toMatchObject({
      emails: [`ishaan-${t}@vayuorbital.com`, `Ishaan.${t}@Gmail.com`],
      linkedin: `https://linkedin.com/in/ishaan-${t}`,
    })
    expect(await valuesOf(vayu)).toMatchObject({
      domains: [`vayu-${t}.com`, `vayu-${t}.in`],
      linkedin: `https://linkedin.com/company/vayu-${t}`,
    })
    expect(await eventsOf(ishaan, 'emails')).toEqual([
      {
        from: null,
        to: [`ishaan-${t}@vayuorbital.com`, `Ishaan.${t}@Gmail.com`],
        actorType: 'system',
        source: 'seed',
      },
    ])
    expect(await eventsOf(vayu, 'linkedin')).toHaveLength(1)

    // No LinkedIn alias is left on people or companies; the rest stand.
    const left = await db
      .select({ kind: entityAlias.kind })
      .from(entityAlias)
      .where(
        and(
          inArray(entityAlias.entityId, [ishaan, vayu]),
          eq(entityAlias.isIdentity, true),
        ),
      )
    expect(left.map((a) => a.kind).sort()).toEqual([
      'domain',
      'domain',
      'email',
      'email',
    ])

    // Run again: nothing changes and nothing more is logged.
    await runMigration()
    expect(await eventsOf(ishaan, 'emails')).toHaveLength(1)
    expect(await eventsOf(vayu, 'domains')).toHaveLength(1)
    expect(await eventsOf(vayu, 'linkedin')).toHaveLength(1)
  })

  it('leaves a merged-away record alone and unarchives LinkedIn', async () => {
    const t = tag()
    const gone = await legacy('person', `Gone ${t}`, [])
    const keeper = await legacy('person', `Keeper ${t}`, [
      { kind: 'email', value: `keeper-${t}@acme.example` },
    ])
    await db
      .update(entity)
      .set({ mergedIntoId: keeper })
      .where(eq(entity.id, gone))
    await db
      .update(attribute)
      .set({ archived: true })
      .where(
        and(
          eq(attribute.slug, 'linkedin'),
          inArray(
            attribute.objectId,
            db
              .select({ id: objectDef.id })
              .from(objectDef)
              .where(inArray(objectDef.slug, ['people', 'companies'])),
          ),
        ),
      )

    await runMigration()

    expect((await valuesOf(gone)).emails).toBeUndefined()
    expect((await valuesOf(keeper)).emails).toEqual([
      `keeper-${t}@acme.example`,
    ])
    const linkedin = await db
      .select({ archived: attribute.archived })
      .from(attribute)
      .where(eq(attribute.slug, 'linkedin'))
    expect(linkedin.length).toBeGreaterThanOrEqual(2)
    expect(linkedin.every((a) => !a.archived)).toBe(true)
  })

  it('leaves no cin in alias_kind', async () => {
    const result = await db.execute<{ label: string }>(
      sql`select unnest(enum_range(null::alias_kind))::text as label`,
    )
    expect(result.rows.map((r) => r.label)).toEqual([
      'name',
      'domain',
      'email',
      'linkedin',
    ])
  })
})
