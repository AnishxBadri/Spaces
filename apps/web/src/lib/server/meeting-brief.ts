import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

/**
 * The brief card's way into Ask: the brief as a new thread of the reader's.
 * The program is imported inside the handler so its database code never
 * reaches the client bundle.
 */

/** "Ask about this": a thread that opens on the brief, scoped to the meeting's records. */
export const askAboutBrief = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        interactionId: Schema.String.check(Schema.isUUID()),
        body: Schema.Trim.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(200_000),
        ),
        route: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { briefThreadProgram } = await import('../interactions/meeting-prep')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(briefThreadProgram)(
        user.id,
        data.interactionId,
        data.body,
        data.route,
      )
    } catch (failure) {
      throw new Error(
        failure instanceof Error && failure.message
          ? failure.message
          : 'Could not open the brief in Ask',
      )
    }
  })
