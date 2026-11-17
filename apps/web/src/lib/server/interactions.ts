import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { EMAIL_SUMMARY_MAX } from '@spaces/core/interactions/email-listing'
import { input } from './input'
import { requireUser } from './shared'

const uuid = Schema.String.check(Schema.isUUID())

/** The `datetime-local` control's value, or an instant in UTC. */
const moment = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?$/, {
    message: 'Expected a date and time',
  }),
)

const logInteractionInput = Schema.Struct({
  kind: Schema.Literals(['meeting', 'call']),
  subject: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  occurredAt: moment,
  /** every entity in the room: people, companies, deals */
  attendeeIds: Schema.Array(uuid).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
  /** "Log and write up": create the body note and hand back its id */
  writeUp: Schema.optional(Schema.Boolean),
  /** The row's second line; as long as the row prints, two lines at most. */
  summary: Schema.optional(
    Schema.Trim.check(Schema.isMaxLength(EMAIL_SUMMARY_MAX)),
  ),
})

/**
 * The write itself is `logInteractionProgram`, kept out of this file: it is
 * re-exported to the client by the server-fns barrel, so an Effect program
 * beside it would reach the browser bundle. Tests call the program directly.
 */
export const logInteraction = createServerFn({ method: 'POST' })
  .validator(input(logInteractionInput))
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
        attendeeIds: [...data.attendeeIds],
        writeUp: data.writeUp ?? false,
        // A blank Summary is no summary.
        summary:
          data.summary === undefined || data.summary === ''
            ? null
            : data.summary,
      })
    } catch (failure) {
      throw new Error(interactionLogMessage(failure))
    }
  })

const writeUpInteractionInput = Schema.Struct({ interactionId: uuid })

/**
 * Write up an interaction that was logged without a body — the
 * timeline row's "Write up" affordance. Idempotent: an interaction that
 * already has a note answers with that note's id, so a double click lands
 * in one editor rather than forking a second body.
 */
export const writeUpInteraction = createServerFn({ method: 'POST' })
  .validator(input(writeUpInteractionInput))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { writeUpInteractionProgram, writeUpMessage } =
      await import('../interactions/write-up')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(writeUpInteractionProgram)(u.id, data.interactionId)
    } catch (failure) {
      throw new Error(writeUpMessage(failure))
    }
  })

const interactionEdgeInput = Schema.Struct({
  interactionId: uuid,
  entityId: uuid,
})

/** File on a deal… from a thread's row: one more record it belongs to. */
export const fileInteractionOnEntity = createServerFn({ method: 'POST' })
  .validator(input(interactionEdgeInput))
  .handler(async ({ data }) => {
    await requireUser()
    const { fileInteractionOnEntityProgram, interactionEdgeMessage } =
      await import('../interactions/file-on')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(fileInteractionOnEntityProgram)(
        data.interactionId,
        data.entityId,
      )
    } catch (failure) {
      throw new Error(interactionEdgeMessage(failure))
    }
  })

/** Unlink from <record>… from a thread's row: that one edge goes. */
export const unlinkInteractionFromEntity = createServerFn({ method: 'POST' })
  .validator(input(interactionEdgeInput))
  .handler(async ({ data }) => {
    await requireUser()
    const { unlinkInteractionFromEntityProgram, interactionEdgeMessage } =
      await import('../interactions/file-on')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(unlinkInteractionFromEntityProgram)(
        data.interactionId,
        data.entityId,
      )
    } catch (failure) {
      throw new Error(interactionEdgeMessage(failure))
    }
  })
