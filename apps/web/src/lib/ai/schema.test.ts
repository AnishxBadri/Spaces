import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The app-side half of the registry → JSON-schema compiler's tests (SPA-21).
 * The compiler itself is `@spaces/core/ai/schema` and its snapshot suite runs
 * in core with no database; this file holds the two claims that need the
 * app: a user-built object compiles with zero AI-specific code, and a
 * proposal round-trips into the one write path's `planPatch`.
 *
 * The Fund is built through `createObjectProgram` and `createAttributeProgram`
 * — the same programs the settings UI calls — so the registry the compiler
 * reads is exactly the rows a user would have made. `planPatch` is pure; the
 * round trip below touches no table after the registry is read.
 */

describe('registry → JSON schema, on a user-built object', () => {
  it('compiles a "Fund" with a select, a currency and a record_reference, and round-trips a proposal through planPatch', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram } =
      await import('#/lib/attributes/object-registry')
    const { createAttributeProgram } = await import('#/lib/attributes/create')
    const { getRegistryByObjectId, planPatch } =
      await import('#/lib/attributes/values')
    const { schemaFor, toPatch, validateProposal } =
      await import('@spaces/core/ai/schema')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')

    const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!actor) throw new Error('the test seed has no user')
    const tag = randomUUID().slice(0, 8)

    const fund = await Effect.runPromise(
      createObjectProgram({
        singular: `Fund ${tag}`,
        plural: `Funds ${tag}`,
        createdBy: actor.id,
      }),
    )
    const attr = (input: Parameters<typeof createAttributeProgram>[0]) =>
      Effect.runPromise(createAttributeProgram(input))
    await attr({
      objectId: fund.id,
      name: 'Strategy',
      type: 'select',
      description: 'How the fund deploys capital',
      options: [{ label: 'Venture' }, { label: 'Growth' }],
      createdBy: actor.id,
    })
    await attr({
      objectId: fund.id,
      name: 'Fund size',
      type: 'currency',
      config: { code: 'USD' },
      createdBy: actor.id,
    })
    await attr({
      objectId: fund.id,
      name: 'General partner',
      type: 'record_reference',
      config: { targetKind: 'person' },
      createdBy: actor.id,
    })

    const registry = await getRegistryByObjectId(fund.id)
    const schema = schemaFor(registry, `Fund ${tag}`)

    expect(Object.keys(schema.properties ?? {})).toEqual([
      'strategy',
      'fund_size',
      'general_partner',
    ])
    const value = (slug: string) => schema.properties?.[slug]?.properties?.value
    expect(schema.properties?.strategy.description).toBe(
      'How the fund deploys capital',
    )
    expect(value('strategy')?.enum).toEqual(['venture', 'growth'])
    expect(value('fund_size')?.type).toBe('number')
    expect(value('general_partner')?.required).toEqual(['name'])

    // schema → proposal: what a provider answering this schema returns.
    const raw = {
      strategy: { value: 'venture', refs: ['doc:lpa#p2'], confidence: 0.9 },
      fund_size: { value: 250_000_000, refs: ['doc:lpa#p1'], confidence: 0.7 },
      general_partner: {
        value: { name: 'Ada Lovelace', email: 'ada@example.com' },
        refs: ['doc:lpa#p4'],
        confidence: 0.6,
      },
    }
    const checked = validateProposal(registry, raw)
    if (!checked.ok) throw new Error(JSON.stringify(checked.issues))

    // → toPatch: values for planPatch, the claim held for identity resolution.
    const { patch, claims } = toPatch(registry, checked.proposal)
    expect(claims).toEqual({
      general_partner: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
    })

    // → planPatch, pure: the Change[] the write path would apply.
    const changes = Effect.runSync(planPatch(registry, {}, patch))
    expect(
      changes.map(({ slug, before, value: v }) => ({ slug, before, value: v })),
    ).toEqual([
      { slug: 'strategy', before: null, value: 'venture' },
      { slug: 'fund_size', before: null, value: 250_000_000 },
    ])
  })
})
