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

  it('takes a picture key as an http(s) image URL', () => {
    expect(ENRICHMENT_VOCABULARY['company.logo'].type).toBe('image')
    expect(ENRICHMENT_VOCABULARY['person.photo'].kind).toBe('person')
    expect(
      vocabularyProblem('company.logo', 'https://flent.in/logo.png'),
    ).toBeNull()
    expect(vocabularyProblem('person.photo', 'data:image/png;base64,AA')).toBe(
      'person.photo takes an image',
    )
  })
})

describe('the funding stage and the company keys', () => {
  it('takes a funding stage as text, matched to an option by the host', () => {
    expect(ENRICHMENT_VOCABULARY['company.funding_stage']).toEqual({
      kind: 'company',
      type: 'text',
      changing: false,
    })
  })

  it('takes a person’s company by name and domain, nothing else', () => {
    expect(ENRICHMENT_VOCABULARY['person.company'].type).toBe('company')
    expect(
      vocabularyProblem('person.company', {
        name: 'Flent',
        domain: 'flent.in',
      }),
    ).toBeNull()
    for (const value of [
      'flent.in',
      { name: 'Flent' },
      { name: 'Flent', domain: 'flent.in', id: 'x' },
    ])
      expect(vocabularyProblem('person.company', value)).toBe(
        'person.company takes a company by name and domain',
      )
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
