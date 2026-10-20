import { describe, expect, it } from 'vitest'
import type { CallMeta, EmailMeta } from '@spaces/db/schema/interactions'
import {
  readEmailTemplateBody,
  readInteractionMeta,
  readRecorderSettings,
  recorderSettingsJson,
} from './json'

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
    const stray = readInteractionMeta('email', { ...email, reply_to: [] })
    expect(stray.ok).toBe(false)
  })

  it('reads a sent message’s Bcc', () => {
    const sent = readInteractionMeta('email', {
      ...email,
      bcc: ['priya@fund.example'],
    })
    expect(sent).toMatchObject({
      ok: true,
      meta: { bcc: ['priya@fund.example'] },
    })
  })
})

describe('readRecorderSettings', () => {
  it('reads nothing ticked and both opt-ins off until chosen', () => {
    expect(readRecorderSettings(null)).toEqual({
      folderIds: [],
      typedNotes: false,
      transcript: false,
    })
  })

  it('round-trips the stored form, and a malformed key reads as its default', () => {
    const stored = recorderSettingsJson({
      folderIds: ['fld_deals', 'fld_portfolio', 'fld_deals'],
      typedNotes: true,
      transcript: false,
    })
    expect(stored).toEqual({
      folder_ids: ['fld_deals', 'fld_portfolio'],
      typed_notes: true,
      transcript: false,
    })
    expect(readRecorderSettings(stored).folderIds).toEqual([
      'fld_deals',
      'fld_portfolio',
    ])
    expect(
      readRecorderSettings({ folder_ids: 'fld_deals', transcript: 'yes' }),
    ).toEqual({ folderIds: [], typedNotes: false, transcript: false })
  })
})

describe('readEmailTemplateBody', () => {
  const body = {
    subject: 'Intro: {{company.name}}',
    body_md: 'Hi {{name.first}},',
    attachments: [{ documentId: '00000000-0000-4000-8000-0000000000a1' }],
  }

  it('reads the subject, the body and the files', () => {
    expect(readEmailTemplateBody(body)).toEqual(body)
  })

  it('refuses another kind of body, and a stray key', () => {
    expect(readEmailTemplateBody({ values: {} })).toBeNull()
    expect(readEmailTemplateBody({ ...body, cc: [] })).toBeNull()
    expect(
      readEmailTemplateBody({ ...body, attachments: [{ documentId: 'x' }] }),
    ).toBeNull()
  })
})
