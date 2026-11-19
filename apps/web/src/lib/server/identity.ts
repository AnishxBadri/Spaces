import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

/**
 * Whether an identity key typed into a create window already names a
 * record, and for an email the company its domain names. Read-only: the
 * create still attaches on a match.
 */
export const findByIdentity = createServerFn()
  .validator(
    input(
      Schema.Struct({
        key: Schema.Literals(['domain', 'email', 'linkedin']),
        value: Schema.Trim.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(255),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { findByIdentityHandler } =
      await import('../records/find-by-identity')
    return findByIdentityHandler(data)
  })
