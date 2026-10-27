import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * Whether an identity key typed into a create window already names a
 * record, and for an email the company its domain names. Read-only: the
 * create still attaches on a match.
 */
export const findByIdentity = createServerFn()
  .validator(
    z.object({
      key: z.enum(['domain', 'email', 'linkedin']),
      value: z.string().trim().min(1).max(255),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { findByIdentityHandler } =
      await import('../records/find-by-identity')
    return findByIdentityHandler(data)
  })
