import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'

/**
 * A member's email signature: one plain text per member, on their `user`
 * row. Only its owner reads or writes it; every program takes the viewer
 * from the session, never an id from the client.
 */

export class SignatureFailed extends Schema.TaggedError<SignatureFailed>()(
  'SignatureFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SignatureFailed({ cause }),
  })

/** The viewer's signature as stored; empty when they have none. */
export const signatureProgram = Effect.fn('signatureProgram')(
  function* (viewer: {
    id: string
  }): Effect.fn.Return<string, SignatureFailed> {
    const row = (yield* query(() =>
      db
        .select({ signature: user.emailSignature })
        .from(user)
        .where(eq(user.id, viewer.id)),
    )).at(0)
    return row?.signature ?? ''
  },
)

/**
 * Writes the viewer's signature, its blank edges trimmed; blank clears it.
 * Hands back what is stored, for the Save bar to settle on.
 */
export const saveSignatureProgram = Effect.fn('saveSignatureProgram')(
  function* (
    viewer: { id: string },
    signature: string,
  ): Effect.fn.Return<string, SignatureFailed> {
    const text = signature.trim()
    yield* query(() =>
      db
        .update(user)
        .set({ emailSignature: text === '' ? null : text })
        .where(eq(user.id, viewer.id)),
    )
    return text
  },
)
