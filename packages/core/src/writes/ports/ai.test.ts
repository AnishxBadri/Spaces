import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { aiLanesFor, toJsonSchema } from './ai'

/**
 * AiLive's two pure halves. The port itself — the subject binding, the
 * sensitivity gate, the cap and the `ai_usage` row — is proved through the
 * worker's loader against built fixture bundles.
 */

describe('aiLanesFor', () => {
  it('lets a schedule job classify only, and every other trigger every lane', () => {
    expect(aiLanesFor('schedule')).toEqual(['classify'])
    for (const trigger of ['action', 'event', 'webhook', 'file'] as const)
      expect(aiLanesFor(trigger)).toEqual(['extract', 'classify', 'synthesize'])
  })
})

describe('toJsonSchema', () => {
  it("reads a plugin's zod schema into the subset core hands a provider", () => {
    const schema = z.object({
      topic: z.enum(['funding', 'hiring']).describe('What it is about'),
      score: z.number().min(0).max(1),
      tags: z.array(z.string().min(1)),
      note: z.string().nullable(),
    })
    expect(toJsonSchema(z.toJSONSchema(schema))).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['topic', 'score', 'tags', 'note'],
      properties: {
        topic: {
          type: 'string',
          enum: ['funding', 'hiring'],
          description: 'What it is about',
        },
        score: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', items: { type: 'string', minLength: 1 } },
        // `anyOf` is outside the subset: the provider is told less, and the
        // answer is still parsed by the plugin's schema.
        note: {},
      },
    })
  })

  it('reads anything that is not a schema object as no constraint', () => {
    expect(toJsonSchema(null)).toEqual({})
    expect(toJsonSchema({ type: 'null', enum: [1, 'a'] })).toEqual({
      enum: ['a'],
    })
  })
})
