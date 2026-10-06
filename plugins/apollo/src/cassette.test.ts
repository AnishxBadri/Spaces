import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  apolloMessage,
  organizationEnrichment,
  personEnrichment,
} from './map.ts'
import { fixtureText } from './test-fixtures.ts'

/**
 * The cassette (`fixtures/cassette/`) is what `SPACES_FAKE_PROVIDERS=1` and
 * the worker's chaos suite answer in Apollo's place, so every answer in it
 * must be one this plugin reads: each response maps through the plugin's own
 * mapper, a wildcard answer claims the domain or email it was asked about
 * and no other key, and nothing in it is key material.
 */

const cassette = z
  .object({
    keyHeader: z.string(),
    interactions: z.array(
      z.object({
        method: z.string(),
        url: z.url(),
        status: z.int(),
        file: z.string(),
      }),
    ),
    revoked: z.object({ status: z.int(), file: z.string() }),
  })
  .parse(JSON.parse(fixtureText('cassette/cassette.json')))

/** A response file with its `{{name}}` placeholders filled from `SAMPLE`. */
const answer = (file: string): unknown =>
  JSON.parse(
    fixtureText(file).replace(
      /\{\{([\w-]+)\}\}/g,
      (whole, name: string) => SAMPLE.get(name) ?? whole,
    ),
  )

const SAMPLE = new Map([
  ['domain', 'acme-tools.example'],
  ['email', 'ana@acme-tools.example'],
  ['linkedin_url', 'https://www.linkedin.com/in/ana-acme'],
])

const KEYISH = /api_?key|token|secret|password|authorization/i

describe('the Apollo cassette', () => {
  it('reads its key from the header the plugin sends it in', () => {
    expect(cassette.keyHeader).toBe('x-api-key')
  })

  it.each(cassette.interactions.map((i): [string, typeof i] => [i.url, i]))(
    '%s maps through the plugin’s own reader',
    (_url, interaction) => {
      const raw = z.json().parse(answer(interaction.file))
      const read = interaction.url.includes('/organizations/enrich')
        ? organizationEnrichment('entity-1', raw)
        : personEnrichment('entity-1', raw)
      expect(read.receipt.raw).toEqual(raw)
    },
  )

  it('answers any company with the domain it was asked about, and no other key', () => {
    const wildcard = cassette.interactions.find((i) =>
      i.url.endsWith('organizations/enrich?domain=*'),
    )
    if (wildcard === undefined) throw new Error('no wildcard organization')
    const read = organizationEnrichment(
      'entity-1',
      z.json().parse(answer(wildcard.file)),
    )
    expect(read.matched).toBe(true)
    expect(read.alias?.keys).toEqual({ domain: SAMPLE.get('domain') })
  })

  it('answers any person with the email it was asked about, and no other key', () => {
    const wildcard = cassette.interactions.find((i) =>
      i.url.endsWith('people/match?email=*'),
    )
    if (wildcard === undefined) throw new Error('no wildcard person')
    const read = personEnrichment(
      'entity-1',
      z.json().parse(answer(wildcard.file)),
    )
    expect(read.alias?.keys).toEqual({ email: SAMPLE.get('email') })
  })

  it('says why a revoked key is refused in Apollo’s own words', () => {
    expect(cassette.revoked.status).toBe(401)
    expect(apolloMessage(fixtureText(cassette.revoked.file))).toBe(
      'Invalid access credentials.',
    )
  })

  it.each([
    ...new Set([
      ...cassette.interactions.map((i) => i.file),
      cassette.revoked.file,
    ]),
  ])('%s carries no key material', (file) => {
    const names: Array<string> = []
    JSON.parse(fixtureText(file), (key: string, value: unknown) => {
      names.push(key)
      return value
    })
    expect(names.filter((k) => KEYISH.test(k))).toEqual([])
  })
})
