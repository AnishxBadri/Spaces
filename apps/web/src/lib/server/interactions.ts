import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '@spaces/db'
import { interaction, interactionEntity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { requireUser } from './shared'

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
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(interaction)
        .values({
          kind: data.kind,
          source: 'manual',
          subject: data.subject,
          occurredAt: new Date(data.occurredAt),
        })
        .returning({ id: interaction.id })
      for (const entityId of new Set(data.attendeeIds)) {
        await tx
          .insert(interactionEntity)
          .values({ interactionId: row.id, entityId })
          .onConflictDoNothing()
      }
      await tx.insert(activity).values({
        actorId: u.id,
        verb: `interaction.${data.kind}`,
        subjectEntityId: data.attendeeIds[0],
        meta: { interactionId: row.id },
      })
      return { id: row.id }
    })
  })
