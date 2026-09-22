import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The record header's Sensitive switch (SPA-61). Any member may flag a
 * record — `requireUser()`, not `requireAdmin()`.
 *
 * Sensitivity is an egress flag, never access control: it decides where a
 * record's bytes may travel (a sensitive AI call goes to a local model or
 * nowhere), never who may see the row — `canRead` stays the only thing that
 * hides a row from a user. And inheritance never writes a row: flagging a
 * space writes that space's `entity.sensitive` alone, and every record filed
 * beneath it resolves sensitive at read, through `sensitivityFor`.
 */

const byEntity = z.object({ entityId: z.string().uuid() })

export const getEntitySensitivity = createServerFn()
  .validator(byEntity)
  .handler(async ({ data }) => {
    await requireUser()
    const { sensitivityFor } = await import('../ai/sensitivity-for')
    const { effectFn } = await import('./effect')
    return effectFn(sensitivityFor)(data.entityId)
  })

export const setEntitySensitive = createServerFn({ method: 'POST' })
  .validator(byEntity.extend({ sensitive: z.boolean() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { setEntitySensitiveProgram } = await import('../ai/sensitivity-for')
    const { effectFn } = await import('./effect')
    return effectFn(setEntitySensitiveProgram)(data.entityId, data.sensitive)
  })
