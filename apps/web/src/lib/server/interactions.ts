import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser, writeInteraction } from './shared'

const logInteractionInput = z.object({
  kind: z.enum(['meeting', 'call']),
  subject: z.string().trim().min(1).max(300),
  occurredAt: z.string().datetime({ local: true }).or(z.string().datetime()),
  /** every entity in the room: people, companies, deals */
  attendeeIds: z.array(z.string().uuid()).min(1).max(50),
})

export const logInteraction = createServerFn({ method: 'POST' })
  .validator(logInteractionInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    // The write itself is `writeInteraction` in server/shared.ts: this file
    // is re-exported to the client by the server-fns barrel, and the helper
    // is what the test calls (CLAUDE.md → Traps).
    return writeInteraction({
      kind: data.kind,
      subject: data.subject,
      occurredAt: new Date(data.occurredAt),
      attendeeIds: data.attendeeIds,
      actorId: u.id,
    })
  })
