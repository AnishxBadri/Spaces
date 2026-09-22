import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The suggestion card's two verbs (SPA-98), over SPA-46's programs in
 * `lib/ai/propose.ts`. Accept writes through the one write path with the
 * signed-in user as actor and the suggestion as the receipt; reject closes
 * the row and writes nothing else, and a rejected row never reappears.
 *
 * The programs' tagged errors carry no sentence a toast can print, so a
 * refusal is rethrown as `suggestionMessage()`'s — that is what the card
 * shows, and the row stays open for the queue.
 */

const byId = z.object({ id: z.string().uuid() })

export const acceptSuggestion = createServerFn({ method: 'POST' })
  .validator(byId)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { acceptProgram, suggestionMessage } = await import('../ai/propose')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(acceptProgram)(data.id, { type: 'user', id: u.id })
    } catch (err) {
      throw new Error(suggestionMessage(err))
    }
    return { ok: true }
  })

export const rejectSuggestion = createServerFn({ method: 'POST' })
  .validator(byId)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { rejectProgram, suggestionMessage } = await import('../ai/propose')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(rejectProgram)(data.id, { type: 'user', id: u.id })
    } catch (err) {
      throw new Error(suggestionMessage(err))
    }
    return { ok: true }
  })
