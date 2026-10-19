import { describe, expect, it } from 'vitest'
import type { CallMeta, EmailMeta } from '@spaces/db/schema/interactions'
import { readInteractionMeta } from './json'

/** `readInteractionMeta`: the boundary every `interaction.meta` read crosses. */

const email: EmailMeta = {
  kind: 'email',
  from: 'priya@ohmium.example',
  to: ['anish@fund.example'],
  cc: [],
  date: '2026-10-08T09:12:00.000Z',
  mime_blob_sha: null,
}

const call: CallMeta = {
  kind: 'call',
  provider_event_id: 'evt_123',
  duration_seconds: 1800,
}

const meeting = {
  kind: 'meeting',
  ends_at: '2026-10-08T10:30:00.000Z',
  status: 'scheduled',
  conference_url: null,
  organizer: null,
  recurring_instance_id: 'rec_1',
  rsvp: { 'priya@ohmium.example': 'tentative' },
}

describe('readInteractionMeta', () => {
  it('reads each kind’s shape on its own row', () => {
    expect(readInteractionMeta('email', email)).toEqual({
      ok: true,
      meta: email,
    })
    expect(readInteractionMeta('call', call)).toEqual({ ok: true, meta: call })
    expect(readInteractionMeta('meeting', meeting)).toEqual({
      ok: true,
      meta: meeting,
    })
  })

  it('reads an email’s snippet, summary and categories (D67)', () => {
    const derived: EmailMeta = {
      ...email,
      labels: ['Inbox'],
      snippet: 'Hi — the deck is attached',
      summary: 'Sends the deck ahead of Thursday.',
      categories: ['pitch'],
    }
    expect(readInteractionMeta('email', derived)).toEqual({
      ok: true,
      meta: derived,
    })
  })

  it('reads null as no metadata', () => {
    expect(readInteractionMeta('email', null)).toEqual({ ok: true, meta: null })
  })

  it('refuses a meeting shape on an email row', () => {
    expect(readInteractionMeta('email', meeting)).toEqual({
      ok: false,
      reason: 'meta is a meeting shape; the row is email',
    })
  })

  it('refuses an RSVP outside the four answers, and a stray key', () => {
    const maybe = readInteractionMeta('meeting', {
      ...meeting,
      rsvp: { 'priya@ohmium.example': 'maybe' },
    })
    expect(maybe.ok).toBe(false)
    const stray = readInteractionMeta('email', { ...email, bcc: [] })
    expect(stray.ok).toBe(false)
  })
})
