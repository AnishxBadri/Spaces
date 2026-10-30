import { Clock, Effect, Schema } from 'effect'
import { and, count, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  integration,
  jobRun,
  workspace,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { isProviderId } from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'
import { providerSaid } from '@spaces/core/writes/bindings/health'
import { effectFn } from '#/lib/server/effect'
import {
  requireAdmin,
  requireSettingsReader,
  requireUser,
} from '#/lib/server/shared'
import { redactProviderApp } from '#/lib/settings-redact'
import { BUNDLED_PLUGINS, productOf, productsOf } from './products'
import { getProviderAppsProgram, providerAppProgram } from './provider-apps'
import type {
  ConnectionsListRow,
  ProviderChoiceInput,
  ProviderChoices,
  ProviderMember,
  ProviderPageView,
  ProviderUse,
} from './input'

/**
 * Settings → Connections: each provider as one page with Set up and In use.
 * - A provider's uses are its bundled plugins, one `integration` row each;
 *   `enabled` is whether members may use it, and the In use tick writes it.
 * - The Set up answers live in `workspace.settings.providers`.
 * - Every read is any member's (the page opens read-only for them, the
 *   client secret redacted); every write opens with `requireAdmin()`.
 * - Handlers live outside the server-fn barrel so a test drives them
 *   without a request.
 */

export class ProvidersReadFailed extends Schema.TaggedError<ProvidersReadFailed>()(
  'ProvidersReadFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const query = <T>(message: string, f: () => Promise<T>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new ProvidersReadFailed({ message, cause }),
  })

/** The live row of each bundled plugin the box has. */
export const bundledUseRows = () =>
  db
    .select({
      id: integration.id,
      capabilityId: integration.capabilityId,
      enabled: integration.enabled,
    })
    .from(integration)
    .where(
      and(
        isNull(integration.removedAt),
        inArray(integration.capabilityId, [...BUNDLED_PLUGINS]),
      ),
    )

const choicesOf = (
  settings: (typeof workspace.$inferSelect)['settings'] | undefined,
): ProviderChoices => {
  const google = settings?.providers?.google
  return {
    audience: google?.audience ?? null,
    consent: google?.consent ?? null,
  }
}

const readChoices = query('Could not read the workspace', async () =>
  choicesOf(
    (
      await db
        .select({ settings: workspace.settings })
        .from(workspace)
        .where(eq(workspace.id, 1))
    ).at(0)?.settings,
  ),
)

/** Members who can sign in; a suspended one is no longer counted. */
const countMembers = query('Could not count the members', async () => {
  const row = (
    await db.select({ n: count() }).from(user).where(eq(user.banned, false))
  ).at(0)
  return row?.n ?? 0
})

/** Every live connection under a provider, with its member's name. */
const selectUnder = (provider: ProviderId) =>
  db
    .select({
      userId: accountConnection.userId,
      name: user.name,
      product: accountConnection.product,
      email: accountConnection.externalEmail,
      status: accountConnection.status,
      errorReason: accountConnection.errorReason,
      lastSyncAt: accountConnection.lastSyncAt,
      refreshTokenExpiresAt: accountConnection.refreshTokenExpiresAt,
      createdAt: accountConnection.createdAt,
    })
    .from(accountConnection)
    .innerJoin(user, eq(user.id, accountConnection.userId))
    .where(
      and(
        eq(accountConnection.provider, provider),
        ne(accountConnection.status, 'revoked'),
      ),
    )
    .orderBy(accountConnection.createdAt)

type Connected = Awaited<ReturnType<typeof selectUnder>>[number]

const connectionsUnder = (provider: ProviderId) =>
  query('Could not read the connections', () => selectUnder(provider))

/** A refused client is the provider's word on every grant at once. */
const clientErrorOf = (
  provider: ProviderId,
  rows: ReadonlyArray<Connected>,
): string | null =>
  rows.some(
    (r) => r.status === 'error' && /invalid_client/.test(r.errorReason ?? ''),
  )
    ? providerSaid(provider, 'invalid_client')
    : null

const WEEK_MS = 7 * 24 * 3_600_000

/** Failed runs per integration since `since`. */
const failedRuns = (ids: ReadonlyArray<string>, since: Date) =>
  ids.length === 0
    ? Effect.succeed([])
    : query('Could not read the runs', () =>
        db
          .select({ integrationId: jobRun.integrationId, n: count() })
          .from(jobRun)
          .where(
            and(
              inArray(jobRun.integrationId, [...ids]),
              eq(jobRun.status, 'failed'),
              gte(jobRun.startedAt, since),
            ),
          )
          .groupBy(jobRun.integrationId),
      )

const latest = (dates: ReadonlyArray<Date | null>): string | null =>
  dates
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((a, b) => (a === null || b > a ? b : a), null)
    ?.toISOString() ?? null

/** Settings → Connections: every provider, set up or not. */
export const connectionsListProgram = Effect.fn('connectionsList')(
  function* () {
    const apps = yield* getProviderAppsProgram()
    const members = yield* countMembers
    const choices = yield* readChoices
    const rows: ConnectionsListRow[] = []
    for (const app of apps) {
      const held = yield* connectionsUnder(app.provider)
      rows.push({
        provider: app.provider,
        label: app.label,
        configured: app.configured,
        membersConnected: app.membersConnected,
        members,
        testing:
          app.provider === 'google' &&
          (choices.audience === 'personal' ||
            held.some((r) => r.refreshTokenExpiresAt !== null)),
        error: clientErrorOf(app.provider, held),
      })
    }
    return rows
  },
)

/** One provider's page: its client, the Set up answers, its uses, who is connected. */
export const providerPageProgram = Effect.fn('providerPage')(function* (
  provider: ProviderId,
  readerId: string,
) {
  const app = yield* providerAppProgram(provider)
  const members = yield* countMembers
  const held = yield* connectionsUnder(provider)
  const rows = yield* query('Could not read the installed plugins', () =>
    bundledUseRows(),
  )
  const now = yield* Clock.currentTimeMillis
  const failed = yield* failedRuns(
    rows.map((r) => r.id),
    new Date(now - WEEK_MS),
  )

  const uses: ProviderUse[] = productsOf(provider).map(({ product, entry }) => {
    const row = rows.find((r) => r.capabilityId === entry.plugin)
    const of = held.filter((r) => r.product === product)
    return {
      product,
      label: entry.label,
      plugin: entry.plugin,
      integrationId: row?.id ?? null,
      enabled: row?.enabled ?? false,
      people: new Set(of.map((r) => r.userId)).size,
      lastSyncAt: latest(of.map((r) => r.lastSyncAt)),
      failed:
        row === undefined
          ? 0
          : (failed.find((f) => f.integrationId === row.id)?.n ?? 0),
      failedWho: of.find((r) => r.status === 'error')?.name ?? null,
    }
  })

  // One line per member and address, its products in registry order.
  const connected: ProviderMember[] = []
  for (const r of held) {
    const known = connected.find(
      (c) => c.userId === r.userId && c.email === r.email,
    )
    if (known !== undefined) continue
    const same = held.filter(
      (h) => h.userId === r.userId && h.email === r.email,
    )
    const order = productsOf(provider).map((p) => p.product)
    connected.push({
      userId: r.userId,
      name: r.name,
      email: r.email,
      uses: same
        .map((h) => h.product)
        .sort((a, b) => order.indexOf(a) - order.indexOf(b))
        .map((p) => productOf(provider, p)?.word ?? p)
        .join(' · '),
      state: same.some((h) => h.status === 'error') ? 'expired' : 'ok',
    })
  }

  const view: ProviderPageView = {
    app,
    choices: provider === 'google' ? yield* readChoices : null,
    uses,
    connected,
    members,
    mine:
      held.find((r) => r.userId === readerId && r.status === 'active')?.email ??
      null,
  }
  return view
})

/** Saves one Set up answer into `workspace.settings.providers.<id>`. */
export const setProviderChoiceProgram = Effect.fn('setProviderChoice')(
  function* (input: ProviderChoiceInput) {
    const patch = {
      ...(input.audience === undefined ? {} : { audience: input.audience }),
      ...(input.consent === undefined ? {} : { consent: input.consent }),
    }
    yield* query('Could not save the answer', () =>
      db
        .update(workspace)
        .set({
          settings: sql`jsonb_set(${workspace.settings}, '{providers}', coalesce(${workspace.settings} -> 'providers', '{}'::jsonb) || jsonb_build_object(${input.provider}::text, coalesce(${workspace.settings} #> array['providers', ${input.provider}::text], '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb))`,
          updatedAt: new Date(),
        })
        .where(eq(workspace.id, 1)),
    )
    return yield* readChoices
  },
)

// The server fns' bodies. `requireAdmin()` first on the write.

export async function connectionsListHandler(): Promise<ConnectionsListRow[]> {
  await requireSettingsReader()
  return effectFn(connectionsListProgram)()
}

export async function providerPageHandler(input: {
  readonly provider: string
}): Promise<ProviderPageView> {
  const reader = await requireUser()
  if (!isProviderId(input.provider)) throw new Error('Unknown provider')
  const view = await effectFn(providerPageProgram)(input.provider, reader.id)
  return reader.role === 'admin'
    ? view
    : { ...view, app: redactProviderApp(view.app) }
}

export async function setProviderChoiceHandler(
  input: ProviderChoiceInput,
): Promise<ProviderChoices> {
  await requireAdmin()
  return effectFn(setProviderChoiceProgram)(input)
}
