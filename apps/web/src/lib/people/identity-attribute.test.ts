import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, entityAlias } from '@spaces/db/schema'
import { SYSTEM_ATTRIBUTES } from '@spaces/core/attributes/registry'
import { setValues } from '@spaces/core/writes/attributes/values'
import * as resolveModule from '@spaces/core/writes/entities/resolve'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * Identity is a unique attribute (D75): a person's `emails` and a company's
 * `domains` live in `entity.values`, and `setValues` is the only door that
 * writes their `is_identity` aliases. Three locks:
 * - the registry seeds both as multi-valued identity attributes, and
 *   LinkedIn as a plain `url` on both;
 * - no source inserts into `entity_alias` but the alias writer behind
 *   `claimIdentityAlias` (module-private) and the name-alias writers, and
 *   only `setValues` calls `claimIdentityAlias` — seeds and plugins included;
 * - turbo hashes the worker and plugin sources into this package's test task.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

const ROOTS = ['apps/web/src', 'apps/worker/src', 'packages', 'plugins']

const walk = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = join(dir, e.name)
    if (e.isDirectory())
      return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(file)
    return /\.(ts|tsx)$/.test(e.name) &&
      !/\.test\.(ts|tsx)$/.test(e.name) &&
      !e.name.endsWith('.d.ts')
      ? [file]
      : []
  })

/**
 * Who may write an alias row: the identity writer behind
 * `claimIdentityAlias` and `recordNameAlias` share `resolve.ts`; a term's
 * names are `kind: 'name'`, never identity.
 */
const ALIAS_INSERTERS = new Set([
  'packages/core/src/writes/entities/resolve.ts',
  'apps/web/src/lib/glossary/write-term.ts',
])

/** Who may claim: the one write path, and the module that defines the claim. */
const CLAIMERS = new Set([
  'packages/core/src/writes/attributes/values.ts',
  'packages/core/src/writes/entities/resolve.ts',
])

const ALIAS_INSERT =
  /\.insert\(\s*entityAlias\s*\)|insert\s+into\s+"?entity_alias"?/gi
const CLAIM_CALL = /\bclaimIdentityAlias\s*\(/g

/** `line:column` of every match of `pattern` in `text`. */
function hits(text: string, pattern: RegExp): Array<string> {
  const out: Array<string> = []
  for (const m of text.matchAll(pattern)) {
    const before = text.slice(0, m.index)
    const line = before.split('\n').length
    const column = m.index - before.lastIndexOf('\n')
    out.push(`${line}:${column}`)
  }
  return out
}

const sources = () =>
  ROOTS.map((r) => join(repoRoot, r))
    .filter((dir) => existsSync(dir))
    .flatMap(walk)
    .map((file) => ({
      file: relative(repoRoot, file),
      text: readFileSync(file, 'utf8'),
    }))

const actor = { type: 'user', id: FIXTURE_ACTOR.id } as const

describe('identity is a unique attribute (D75)', () => {
  it('seeds emails and domains as identity attributes, LinkedIn as a plain url', () => {
    expect(
      SYSTEM_ATTRIBUTES.person.find((a) => a.slug === 'emails'),
    ).toMatchObject({
      type: 'email',
      options: { multi: true, identityKey: 'email' },
    })
    expect(
      SYSTEM_ATTRIBUTES.company.find((a) => a.slug === 'domains'),
    ).toMatchObject({
      type: 'domain',
      options: { multi: true, identityKey: 'domain' },
    })
    for (const kind of ['person', 'company'] as const)
      expect(
        SYSTEM_ATTRIBUTES[kind].find((a) => a.slug === 'linkedin'),
      ).toEqual({ slug: 'linkedin', name: 'LinkedIn', type: 'url' })
  })

  it('keeps the alias writer private: only claimIdentityAlias reaches it', () => {
    expect('addIdentityAlias' in resolveModule).toBe(false)
    expect(typeof resolveModule.claimIdentityAlias).toBe('function')
  })

  it('recognises the shapes it is looking for', () => {
    expect(hits('await tx.insert(entityAlias).values({', ALIAS_INSERT)).toEqual(
      ['1:9'],
    )
    expect(hits('on.insert( entityAlias )', ALIAS_INSERT)).toHaveLength(1)
    expect(
      hits('sql`INSERT INTO entity_alias (kind)`', ALIAS_INSERT),
    ).toHaveLength(1)
    expect(hits('db.insert(entityAliasOld)', ALIAS_INSERT)).toEqual([])
    expect(hits('await claimIdentityAlias(tx, id', CLAIM_CALL)).toEqual(['1:7'])
  })

  it('has no other alias writer in any package, plugin or seed', () => {
    const all = sources()
    // The seeds and Apollo are where alias writers used to live.
    expect(all.some((s) => s.file.endsWith('lib/seeds/dev.ts'))).toBe(true)
    expect(all.some((s) => s.file.endsWith('plugins/apollo/src/map.ts'))).toBe(
      true,
    )

    const inserts = all
      .filter((s) => !ALIAS_INSERTERS.has(s.file))
      .flatMap((s) => hits(s.text, ALIAS_INSERT).map((at) => `${s.file}:${at}`))
    expect(inserts).toEqual([])

    const claims = all
      .filter((s) => !CLAIMERS.has(s.file))
      .flatMap((s) => hits(s.text, CLAIM_CALL).map((at) => `${s.file}:${at}`))
    expect(claims).toEqual([])

    // Inside the identity module: two name-alias inserts (the birth's and
    // `recordNameAlias`) and the private identity insert, and
    // `claimIdentityAlias` only where it is defined.
    const resolve = all.find((s) =>
      s.file.endsWith('packages/core/src/writes/entities/resolve.ts'),
    )
    expect(hits(resolve?.text ?? '', ALIAS_INSERT)).toHaveLength(3)
    expect(hits(resolve?.text ?? '', CLAIM_CALL)).toHaveLength(1)
  })

  it('writes an email through setValues: value, alias and claim together', async () => {
    const { resolveEntity } = resolveModule
    const tag = crypto.randomUUID().slice(0, 8)
    const { entityId } = await resolveEntity({
      kind: 'person',
      name: `Guard ${tag}`,
      keys: { linkedin: `https://www.linkedin.com/in/guard-${tag}` },
      source: { class: 'manual' },
    })
    await setValues({
      entityId,
      patch: { emails: [`guard-${tag}@example.com`] },
      actor,
    })
    const aliases = await db
      .select({ kind: entityAlias.kind, valueNorm: entityAlias.valueNorm })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.entityId, entityId),
          eq(entityAlias.isIdentity, true),
        ),
      )
    // The LinkedIn URL is a plain value: no alias, no claim.
    expect(aliases).toEqual([
      { kind: 'email', valueNorm: `guard-${tag}@example.com` },
    ])
    const row = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0)
    expect(row?.values).toMatchObject({
      emails: [`guard-${tag}@example.com`],
      linkedin: `https://www.linkedin.com/in/guard-${tag}`,
    })
  })
})
