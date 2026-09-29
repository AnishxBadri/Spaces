import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The zod boundary of the attribute-update server fn (`updateAttributeInput`
 * in `./attributes`): it strips the §3 immutables and carries the option
 * archive flag and the `ai` config. These three cases lived in
 * `lib/attributes/update.test.ts` until that file moved to @spaces/core with
 * `update.ts` (SPA-174/175); they import a server-fn module, which is
 * apps/web's, so they stayed behind as their own file.
 */

describe('updateAttributeInput (zod boundary)', () => {
  it('strips type, slug, targetKind and multi rather than carrying them', async () => {
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
