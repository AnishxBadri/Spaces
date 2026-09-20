import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

const logInteractionInput = z.object({
  kind: z.enum(['meeting', 'call']),
  subject: z.string().trim().min(1).max(300),
  occurredAt: z.string().datetime({ local: true }).or(z.string().datetime()),
  /** every entity in the room: people, companies, deals */
  attendeeIds: z.array(z.string().uuid()).min(1).max(50),
  /** "Log and write up": create the body note and hand back its id */
  writeUp: z.boolean().optional(),
})

/**
 * The write itself is `logInteractionProgram` in `lib/interactions/log.ts`:
 * this file is re-exported to the client by the server-fns barrel, so an
 * Effect program living beside it would reach the browser bundle
 * (CLAUDE.md → Traps), and out there it is what the suite calls directly.
 */
export const logInteraction = createServerFn({ method: 'POST' })
  .validator(logInteractionInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { interactionLogMessage, logInteractionProgram } =
      await import('../interactions/log')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(logInteractionProgram)(u.id, {
        kind: data.kind,
        subject: data.subject,
        occurredAt: new Date(data.occurredAt),
        attendeeIds: data.attendeeIds,
        writeUp: data.writeUp ?? false,
      })
    } catch (failure) {
      throw new Error(interactionLogMessage(failure))
    }
  })
