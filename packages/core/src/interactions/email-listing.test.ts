import { describe, expect, it } from 'vitest'
import type { EmailMeta } from '@spaces/db/schema/interactions'
import { EMAIL_SUMMARY_MAX, clean, emailListing } from './email-listing'

const meta = (extra: Partial<EmailMeta> = {}): EmailMeta => ({
  kind: 'email',
  from: 'a@acme.example',
  to: [],
  cc: [],
  date: '2026-10-01T09:00:00.000Z',
  mime_blob_sha: null,
  ...extra,
})

describe('an email’s listing', () => {
  it('lists the summary and drops the snippet once there is one', () => {
    expect(
      emailListing(
        meta({ summary: 'Asks for the deck.', snippet: 'Hi there' }),
        true,
      ),
    ).toEqual({ summary: 'Asks for the deck.', snippet: null, categories: [] })
  })

  it('falls back to the snippet when no lane has written a summary', () => {
    expect(emailListing(meta({ snippet: '  Hi   there ' }), true)).toEqual({
      summary: null,
      snippet: 'Hi there',
      categories: [],
    })
  })

  it('keeps only the categories it knows, and never the mailbox’s labels', () => {
    expect(
      emailListing(
        meta({ labels: ['Inbox'], categories: ['pitch', 'shouting'] }),
        true,
      ).categories,
    ).toEqual(['pitch'])
  })

  it('hides all three from a reader who may not read the body (D67)', () => {
    expect(
      emailListing(
        meta({ summary: 's', snippet: 'p', categories: ['intro'] }),
        false,
      ),
    ).toEqual({ summary: null, snippet: null, categories: [] })
  })

  it('reads nothing off a meeting or a missing meta', () => {
    expect(emailListing(null, true).summary).toBeNull()
  })

  it('cuts a long line on a word, under the ceiling', () => {
    const long = 'word '.repeat(100)
    const cut = clean(long)
    expect(cut?.length).toBeLessThanOrEqual(EMAIL_SUMMARY_MAX)
    expect(cut?.endsWith('word…')).toBe(true)
    expect(clean('   ')).toBeNull()
  })
})
