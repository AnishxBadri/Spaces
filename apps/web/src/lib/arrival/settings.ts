import { Effect, Schema } from 'effect'
import { asc, desc, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration, jobRun, mailbox } from '@spaces/db/schema'
import type { JobRunStatus } from '@spaces/db/schema/jobs'
import type { MailboxStatus } from '@spaces/db/schema/mail'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'
import { effectFn } from '#/lib/server/effect'
import { requireAdmin } from '#/lib/server/shared'
import {
  readWorkspaceCredential,
  redact,
  resolveSecretById,
  storeCredential,
} from '#/lib/vault'
import { probe } from './imap'
import type { MailboxInput } from './input'

/**
 * Settings → Arrival (SPA-56): the forwarding mailbox's four operations —
 * read, save, test, and the core integration row they hang off. Admin-only:
 * the handlers at the bottom open with `requireAdmin()`, and the programs
 * above them take no request so the suite can drive them. They live here,
 * not in `lib/server/mailbox.ts`, because that module is re-exported by the
 * client barrel and this one imports the vault and imapflow.
 *
 * The app password goes in through `storeCredential` (`kind: 'mailbox'`) and
 * never comes back out: the section reads `redact()`'s display, kept in the
 * credential's `meta` beside it.
 */

export class MailboxSettingsFailed extends Schema.TaggedError<MailboxSettingsFailed>()(
  'MailboxSettingsFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The vault provider name of the mailbox's app password (workspace scope). */
export const MAILBOX_PROVIDER = 'mailbox'

/**
 * The capability id of the core channel's `integration` row. `core.` because
 * no plugin manifest will ever claim it; `source_ref` on every interaction and
 * note the lane writes names this row (D1).
 */
export const MAILBOX_CAPABILITY = 'core.mailbox'

export type MailboxView = {
  address: string
  host: string
  port: number
  useTls: boolean
  folder: string
  cadenceMinutes: number
  status: MailboxStatus
  lastError: string | null
  lastPolledAt: string | null
  /** The app password as `redact()` shows it; the secret never leaves the vault. */
  passwordDisplay: string | null
}

export type MailboxRunView = {
  status: JobRunStatus
  startedAt: string
  summary: string | null
  error: string | null
}

export type MailboxSettingsView = {
  mailbox: MailboxView | null
  lastRun: MailboxRunView | null
}

export type MailboxTestResult =
  | { ok: true; exists: number; uidValidity: number }
  | { ok: false; message: string }

const query = <T>(message: string, run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MailboxSettingsFailed({ message, cause }),
  })

async function firstMailbox() {
  return (
    await db.select().from(mailbox).orderBy(asc(mailbox.createdAt)).limit(1)
  ).at(0)
}

export const readMailboxSettingsProgram = Effect.fn('readMailboxSettings')(
  function* (): Effect.fn.Return<MailboxSettingsView, MailboxSettingsFailed> {
    const box = yield* query('Could not read the mailbox', firstMailbox)
    const credential = yield* query('Could not read the app password', () =>
      readWorkspaceCredential(MAILBOX_PROVIDER),
    )
    const run = (yield* query('Could not read the last poll', () =>
      db
        .select()
        .from(jobRun)
        .where(eq(jobRun.queue, QUEUES.pollMailbox))
        .orderBy(desc(jobRun.startedAt))
        .limit(1),
    )).at(0)
    const display = credential?.meta.display
    return {
      mailbox: box
        ? {
            address: box.address,
            host: box.host,
            port: box.port,
            useTls: box.useTls,
            folder: box.folder,
            cadenceMinutes: box.cadenceMinutes,
            status: box.status,
            lastError: box.lastError,
            lastPolledAt: box.lastPolledAt?.toISOString() ?? null,
            passwordDisplay: typeof display === 'string' ? display : null,
          }
        : null,
      lastRun: run
        ? {
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            summary: run.summary,
            error: run.error,
          }
        : null,
    }
  },
)

/**
 * The core channel's integration row, insert-if-absent. Born `enabled`: unlike
 * a plugin install, there is nothing to configure after it — the mailbox row
 * is the configuration, and it exists by the time this is called.
 */
async function ensureIntegration(
  actorId: string,
  credentialId: string,
): Promise<string> {
  const existing = (
    await db
      .select({ id: integration.id })
      .from(integration)
      .where(eq(integration.capabilityId, MAILBOX_CAPABILITY))
      .limit(1)
  ).at(0)
  if (existing) {
    await db
      .update(integration)
      .set({ credentialId, enabled: true, status: 'enabled' })
      .where(eq(integration.id, existing.id))
    return existing.id
  }
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: MAILBOX_CAPABILITY,
        version: '1',
        enabled: true,
        status: 'enabled',
        credentialId,
        createdBy: actorId,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('integration insert returned no row')
  return row.id
}

/**
 * Save the mailbox. The first save needs an app password; later ones keep
 * the stored one unless a new one is typed. A change of address, host or
 * folder is a different mailbox, so its cursor starts over. Every save
 * clears the error state — a new password is the usual reason to save — and
 * sends one poll at once, which also re-syncs the schedule to the cadence.
 */
export const saveMailboxProgram = Effect.fn('saveMailbox')(function* (
  actorId: string,
  input: MailboxInput,
): Effect.fn.Return<{ queued: boolean }, MailboxSettingsFailed> {
  const existing = yield* query('Could not read the mailbox', firstMailbox)
  if (!existing && input.password === undefined)
    return yield* new MailboxSettingsFailed({
      message: 'An app password is required',
      cause: null,
    })

  const password = input.password
  const credentialId =
    password === undefined
      ? existing?.credentialId
      : (yield* query('Could not store the app password', () =>
          storeCredential({
            scope: 'workspace',
            provider: MAILBOX_PROVIDER,
            kind: 'mailbox',
            secret: password,
            meta: { display: redact(password) },
            createdBy: actorId,
          }),
        )).id
  if (credentialId === undefined)
    return yield* new MailboxSettingsFailed({
      message: 'An app password is required',
      cause: null,
    })

  const integrationId = yield* query('Could not register the mailbox', () =>
    ensureIntegration(actorId, credentialId),
  )

  const fields = {
    address: input.address,
    host: input.host,
    port: input.port,
    useTls: input.useTls,
    folder: input.folder,
    cadenceMinutes: input.cadenceMinutes,
    credentialId,
    integrationId,
    status: 'pending' as const,
    lastError: null,
    failureCount: 0,
  }
  const moved =
    existing !== undefined &&
    (existing.address !== input.address ||
      existing.host !== input.host ||
      existing.folder !== input.folder)
  const saved = yield* query('Could not save the mailbox', async () =>
    existing
      ? (
          await db
            .update(mailbox)
            .set(
              moved ? { ...fields, lastUid: 0, lastUidValidity: null } : fields,
            )
            .where(eq(mailbox.id, existing.id))
            .returning({ id: mailbox.id })
        ).at(0)
      : (
          await db
            .insert(mailbox)
            .values({ ...fields, createdBy: actorId })
            .returning({ id: mailbox.id })
        ).at(0),
  )
  if (!saved)
    return yield* new MailboxSettingsFailed({
      message: 'Could not save the mailbox',
      cause: null,
    })

  const job = yield* Effect.promise(() =>
    enqueue(QUEUES.pollMailbox, { mailboxId: saved.id, integrationId }),
  )
  return { queued: job !== null }
})

/**
 * Log in and open the folder, with the password typed (or, when none was,
 * the stored one). Answers the server's own words on failure; never throws
 * for a refusal, only for a read it could not make.
 */
export const testMailboxProgram = Effect.fn('testMailbox')(function* (
  input: MailboxInput,
): Effect.fn.Return<MailboxTestResult, MailboxSettingsFailed> {
  const typed = input.password
  const pass =
    typed ??
    (yield* query('Could not read the app password', async () => {
      const box = await firstMailbox()
      return box ? resolveSecretById(box.credentialId) : null
    }))
  if (pass === null)
    return { ok: false, message: 'Type the app password to test it' }

  return yield* probe({
    host: input.host,
    port: input.port,
    secure: input.useTls,
    user: input.address,
    pass,
    folder: input.folder,
  }).pipe(
    Effect.map((r): MailboxTestResult => ({
      ok: true,
      exists: r.exists,
      uidValidity: r.uidValidity,
    })),
    Effect.catch((err) =>
      Effect.succeed<MailboxTestResult>({
        ok: false,
        message:
          err._tag === 'MailAuthRefused'
            ? `Login refused: ${err.reason}`
            : `Could not reach the mailbox: ${err.reason}`,
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Handlers — what the server fns in `lib/server/mailbox.ts` delegate to.
// ---------------------------------------------------------------------------

export async function getMailboxSettingsHandler(): Promise<MailboxSettingsView> {
  await requireAdmin()
  return effectFn(readMailboxSettingsProgram)()
}

export async function saveMailboxHandler(
  data: MailboxInput,
): Promise<{ queued: boolean }> {
  const admin = await requireAdmin()
  return effectFn(saveMailboxProgram)(admin.id, data)
}

export async function testMailboxHandler(
  data: MailboxInput,
): Promise<MailboxTestResult> {
  await requireAdmin()
  return effectFn(testMailboxProgram)(data)
}
