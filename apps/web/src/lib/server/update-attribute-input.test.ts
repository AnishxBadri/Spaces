import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The zod boundary of the attribute-update server fn (`updateAttributeInput`):
 * it strips the immutable fields and carries the option archive flag and the
 * `ai` config. Kept in apps/web because it imports a server-fn module.
 */

describe('updateAttributeInput (zod boundary)', () => {
  it('strips type, slug, targetKind and config.multi rather than carrying them', async () => {
    const { updateAttributeInput } = await import('./attributes')
    const parsed = updateAttributeInput.parse({
      id: randomUUID(),
      name: 'Renamed',
      type: 'text',
      slug: 'renamed',
      config: { code: 'eur', targetKind: 'company', multi: true },
    })
    expect(parsed).toEqual({
      id: parsed.id,
      name: 'Renamed',
      config: { code: 'EUR' },
    })
  })

  it('carries the widening flag at the top level only (D69)', async () => {
    const { updateAttributeInput } = await import('./attributes')
    const parsed = updateAttributeInput.parse({
      id: randomUUID(),
      multi: true,
      config: { multi: true },
    })
    expect(parsed.multi).toBe(true)
    expect(parsed.config).toEqual({})
  })

  it('carries an option archive flag', async () => {
    const { updateAttributeInput } = await import('./attributes')
    const parsed = updateAttributeInput.parse({
      id: randomUUID(),
      options: [{ id: 'a', label: 'A', archived: true }],
    })
    expect(parsed.options).toEqual([{ id: 'a', label: 'A', archived: true }])
  })
})

describe('updateAttributeInput (ai config)', () => {
  it('the zod boundary carries ai and its null', async () => {
    const { updateAttributeInput } = await import('./attributes')
    const id = randomUUID()
    expect(
      updateAttributeInput.parse({
        id,
        config: { ai: { mode: 'summarize', prompt: ' Why now? ' } },
      }).config,
    ).toEqual({ ai: { mode: 'summarize', prompt: 'Why now?' } })
    expect(
      updateAttributeInput.parse({ id, config: { ai: null } }).config,
    ).toEqual({ ai: null })
  })
})
