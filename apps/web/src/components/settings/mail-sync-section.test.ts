import { describe, expect, it } from 'vitest'
import { addedEntries, listOf } from './mail-sync-section'

describe('the mail sync lists as typed', () => {
  it('splits on commas and lines, dropping blanks', () => {
    expect(listOf(' noreply@, acme.example\n\nPromotions ,')).toEqual([
      'noreply@',
      'acme.example',
      'Promotions',
    ])
  })

  it('names what a save adds, case aside — the entries that remove mail', () => {
    expect(
      addedEntries(['noreply@', 'Promotions'], ['promotions', 'acme.example']),
    ).toEqual(['acme.example'])
    expect(addedEntries(['a.example'], [])).toEqual([])
  })
})
