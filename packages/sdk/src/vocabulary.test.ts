import { Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'
import { Facts } from './ports.ts'
import { FactsTest } from './testing/index.ts'
import {
  ENRICHMENT_VOCABULARY,
  VOCABULARY_KEYS,
  vocabularyProblem,
} from './vocabulary.ts'

describe('ENRICHMENT_VOCABULARY', () => {
  it('names each key with its kind as the prefix, a type and whether it changes', () => {
    for (const key of VOCABULARY_KEYS) {
      const entry = ENRICHMENT_VOCABULARY[key]
      expect(key.startsWith(`${entry.kind}.`)).toBe(true)
    }
    expect(ENRICHMENT_VOCABULARY['company.headcount']).toEqual({
      kind: 'company',
      type: 'number',
      changing: true,
    })
    expect(ENRICHMENT_VOCABULARY['person.title'].changing).toBe(false)
  })

  it('refuses a key it lacks, naming it, and a value of the wrong shape', () => {
    expect(vocabularyProblem('company.mood', 'sunny')).toBe(
      'company.mood is not in the enrichment vocabulary',
    )
    expect(vocabularyProblem('company.headcount', '120')).toBe(
      'company.headcount takes a number',
    )
    expect(vocabularyProblem('company.keywords', ['a', 'b'])).toBeNull()
  })
})

describe('FactsTest.answer', () => {
  it('holds answers by key and refuses one outside the vocabulary', async () => {
    const facts = FactsTest({ linked: ['company.headcount'] })
    const answer = (answers: { [key: string]: number }) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          return yield* (yield* Facts).answer({
            entityId: 'e',
            answers,
            receiptId: 'r',
          })
        }).pipe(Effect.provide(facts.layer)),
      )
    const ok = await answer({ 'company.headcount': 120, 'company.revenue': 9 })
    expect(Exit.isSuccess(ok) && ok.value).toEqual({
      linked: ['company.headcount'],
      unlinked: ['company.revenue'],
    })
    expect(facts.answers.get('e')).toEqual({
      'company.headcount': 120,
      'company.revenue': 9,
    })
    expect(Exit.isFailure(await answer({ 'company.mood': 1 }))).toBe(true)
  })
})
