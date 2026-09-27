import { describe, expect, it } from 'vitest'
import { isRoleSender, refusal } from './noise'
import type { NoiseInput, NoiseReason } from './noise'

/**
 * SPA-56: the noise refusals, as a fixture table and nothing else — no
 * database, no parser. Each row is one header shape a mailbox really sees and
 * the verdict it must get; `null` is "write it".
 */

const clean: NoiseInput = {
  messageId: 'CAF=abc123@mail.gmail.com',
  autoSubmitted: null,
  xAutoreply: false,
  listUnsubscribe: false,
  precedence: null,
  sender: 'jane@acme.io',
  subject: 'Seed round — deck attached',
}

const TABLE: ReadonlyArray<{
  name: string
  input: Partial<NoiseInput>
  verdict: NoiseReason | null
}> = [
  { name: 'a founder writing to the fund', input: {}, verdict: null },
  {
    name: 'no Message-ID header',
    input: { messageId: null },
    verdict: 'no-message-id',
  },
  {
    name: 'an empty Message-ID',
    input: { messageId: '  ' },
    verdict: 'no-message-id',
  },
  {
    name: 'Auto-Submitted: auto-replied (an out-of-office)',
    input: { autoSubmitted: 'auto-replied' },
    verdict: 'auto-submitted',
  },
  {
    name: 'Auto-Submitted: auto-generated (a system notice)',
    input: { autoSubmitted: 'auto-generated' },
    verdict: 'auto-submitted',
  },
  {
    name: 'Auto-Submitted: no is a human',
    input: { autoSubmitted: 'no' },
    verdict: null,
  },
  {
    name: 'X-Autoreply',
    input: { xAutoreply: true },
    verdict: 'auto-submitted',
  },
  {
    name: 'a forwarded out-of-office, headers lost, subject kept',
    input: { subject: 'Automatic reply: Seed round' },
    verdict: 'auto-submitted',
  },
  {
    name: 'an Out of Office subject',
    input: { subject: 'Out of Office: back on the 3rd' },
    verdict: 'auto-submitted',
  },
  {
    name: 'a newsletter with List-Unsubscribe',
    input: { listUnsubscribe: true },
    verdict: 'list-mail',
  },
  {
    name: 'Precedence: bulk',
    input: { precedence: 'bulk' },
    verdict: 'list-mail',
  },
  {
    name: 'Precedence: list',
    input: { precedence: 'List' },
    verdict: 'list-mail',
  },
  {
    name: 'noreply@',
    input: { sender: 'noreply@docsend.com' },
    verdict: 'role-sender',
  },
  {
    name: 'no-reply+tag@',
    input: { sender: 'no-reply+abc@accounts.google.com' },
    verdict: 'role-sender',
  },
  {
    name: 'mailer-daemon@ (a bounce)',
    input: { sender: 'MAILER-DAEMON@mx.example' },
    verdict: 'role-sender',
  },
  {
    name: 'calendar-notification@',
    input: { sender: 'calendar-notification@google.com' },
    verdict: 'role-sender',
  },
  {
    name: 'hello@ is a founder, not a machine',
    input: { sender: 'hello@acme.io' },
    verdict: null,
  },
  {
    name: 'founders@ is a founder, not a machine',
    input: { sender: 'founders@acme.io' },
    verdict: null,
  },
  {
    name: 'no Message-ID outranks a list header',
    input: { messageId: null, listUnsubscribe: true },
    verdict: 'no-message-id',
  },
]

describe('refusal — the noise table', () => {
  it.each(TABLE)('$name', ({ input, verdict }) => {
    expect(refusal({ ...clean, ...input })?.reason ?? null).toBe(verdict)
  })

  it('says why, in words the job_run row can carry', () => {
    expect(refusal({ ...clean, autoSubmitted: 'auto-replied' })?.detail).toBe(
      'Auto-Submitted: auto-replied',
    )
    expect(refusal({ ...clean, sender: 'noreply@x.io' })?.detail).toBe(
      'sent by noreply@x.io',
    )
  })
})

describe('isRoleSender', () => {
  it('reads the local part only, before any +tag', () => {
    expect(isRoleSender('notifications+deals@github.com')).toBe(true)
    expect(isRoleSender('noreply.person@acme.io')).toBe(false)
    expect(isRoleSender('not-an-address')).toBe(false)
  })
})
