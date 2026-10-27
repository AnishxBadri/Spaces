import { describe, expect, it } from 'vitest'
import { composeDealName } from './deal-name'

describe('composeDealName', () => {
  it('names a deal by its company and stage label', () => {
    expect(composeDealName('Pixxel', 'Series B')).toBe('Pixxel — Series B')
  })

  it('is empty until a company is picked', () => {
    expect(composeDealName('  ', 'Pre-lead')).toBe('')
  })

  it('is the company alone when the stage has no label', () => {
    expect(composeDealName(' Orbital ', '')).toBe('Orbital')
  })
})
