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

export type { OpenSuggestionCount } from '../inbox/queue'

/**
 * Open suggestions on one record, grouped by kind (SPA-114) — the record
 * rail's "Waiting" chips. One query, called once from each record route's
 * loader beside its other reads. Empty when nothing waits, and the rail then
 * draws no section at all.
 */
export const countOpenSuggestions = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { countOpenSuggestionsProgram } = await import('../inbox/queue')
    const { effectFn } = await import('./effect')
    return effectFn(countOpenSuggestionsProgram)(data.entityId)
  })

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

export type { BatchOutcome } from '../ai/propose'

/**
 * The two bulk verbs (SPA-110, spec §10): "accept all on this record" and
 * "accept this column". Each item goes through `acceptProgram` on its own,
 * never one transaction, and the answer is one outcome per item — a failed
 * item carries `suggestionMessage()`'s sentence, and its row stays open.
 */
export const acceptSuggestionsForRecord = createServerFn({ method: 'POST' })
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { acceptRecordProgram, suggestionMessage } =
      await import('../ai/propose')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(acceptRecordProgram)({
        entityId: data.entityId,
        actorId: u.id,
      })
    } catch (err) {
      throw new Error(suggestionMessage(err))
    }
  })

export const acceptSuggestionColumn = createServerFn({ method: 'POST' })
  .validator(z.object({ attributeSlug: z.string().min(1) }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { acceptColumnProgram, suggestionMessage } =
      await import('../ai/propose')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(acceptColumnProgram)({
        attributeSlug: data.attributeSlug,
        actorId: u.id,
      })
    } catch (err) {
      throw new Error(suggestionMessage(err))
    }
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
