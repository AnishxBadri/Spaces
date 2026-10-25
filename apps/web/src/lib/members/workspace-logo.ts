import { Readable } from 'node:stream'
import { Effect, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { pendingBlob } from '@spaces/db/schema'
import { workspace } from '@spaces/db/schema/workspace'
import type { WorkspaceSettings } from '@spaces/db/schema/workspace'
import { putBlobProgram } from '@spaces/core/writes/documents/intake'
import { storage } from '@spaces/core/writes/storage'
import { judgeLogo } from './workspace-logo-file'
import type { LogoType } from './workspace-logo-file'

/**
 * The workspace logo: bytes in the blob store, its digest at
 * `workspace.settings.logo`.
 * - Set and Remove answer the digest they replaced, so the caller reclaims
 *   it once no row names it (`reclaimBlobIfOrphaned`).
 * - Server-only, outside the server-fn barrel so tests and the logo route
 *   call it without a request.
 */

export class LogoRefused extends Schema.TaggedError<LogoRefused>()(
  'LogoRefused',
  { message: Schema.String },
) {}

export class LogoWriteFailed extends Schema.TaggedError<LogoWriteFailed>()(
  'LogoWriteFailed',
  { cause: Schema.Defect() },
) {}

/** The digest the settings name, or null. */
export const logoShaOf = (settings: WorkspaceSettings): string | null =>
  typeof settings.logo === 'string' ? settings.logo : null

/** Where the page draws the logo from; the digest makes it cache forever. */
export const logoPath = (sha: string): string => `/api/workspace-logo/${sha}`

const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LogoWriteFailed({ cause }),
  })

/** Writes `sha` (or clears it) under the row lock; the previous digest, or a refusal. */
const writeLogo = (sha: string | null) =>
  io(() =>
    db.transaction(async (tx) => {
      const row = (
        await tx
          .select({ settings: workspace.settings })
          .from(workspace)
          .where(eq(workspace.id, 1))
          .for('update')
      ).at(0)
      if (row === undefined) return { found: false as const }
      await tx
        .update(workspace)
        .set({
          settings:
            sha === null
              ? sql`${workspace.settings} - 'logo'`
              : sql`${workspace.settings} || jsonb_build_object('logo', ${sha}::text)`,
          updatedAt: new Date(),
        })
        .where(eq(workspace.id, 1))
      if (sha !== null)
        await tx.delete(pendingBlob).where(eq(pendingBlob.sha, sha))
      return { found: true as const, previous: logoShaOf(row.settings) }
    }),
  ).pipe(
    Effect.flatMap((r) =>
      r.found
        ? Effect.succeed({ previous: r.previous === sha ? null : r.previous })
        : Effect.fail(new LogoRefused({ message: 'Name the workspace first' })),
    ),
  )

export const setLogoProgram = Effect.fn('setLogo')(function* (input: {
  readonly bytes: Uint8Array
  readonly by: string
}): Effect.fn.Return<
  { readonly sha: string; readonly previous: string | null },
  LogoRefused | LogoWriteFailed
> {
  const judged = judgeLogo(input.bytes)
  if (!judged.ok) return yield* new LogoRefused({ message: judged.message })
  const { sha } = yield* putBlobProgram({
    stream: Readable.from(Buffer.from(input.bytes)),
    mime: judged.type,
    preparedBy: input.by,
  }).pipe(Effect.mapError((cause) => new LogoWriteFailed({ cause })))
  const { previous } = yield* writeLogo(sha)
  return { sha, previous }
})

export const clearLogoProgram = Effect.fn('clearLogo')(
  function* (): Effect.fn.Return<
    { readonly previous: string | null },
    LogoRefused | LogoWriteFailed
  > {
    return yield* writeLogo(null)
  },
)

/** The current logo's bytes and type, when `sha` is still the logo. */
export async function readLogo(
  sha: string,
): Promise<{ bytes: Uint8Array; type: LogoType } | null> {
  const row = (
    await db
      .select({ settings: workspace.settings })
      .from(workspace)
      .where(eq(workspace.id, 1))
  ).at(0)
  if (row === undefined || logoShaOf(row.settings) !== sha) return null
  const bytes = await storage()
    .getBytes(sha)
    .catch(() => null)
  if (bytes === null) return null
  const judged = judgeLogo(bytes)
  return judged.ok ? { bytes, type: judged.type } : null
}
