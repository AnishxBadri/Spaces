import { Effect } from 'effect'
import {
  KEYED_PROVIDERS,
  KEYED_PROVIDER_IDS,
} from '@spaces/core/providers/keyed'
import type { KeyedProviderId } from '@spaces/core/providers/keyed'
import {
  KeyRefused,
  connectKeyProgram,
  listKeyedConnections,
  recorderAccountProgram,
  saveRecorderSettingsProgram,
} from '@spaces/core/writes/connections/keyed'
import type { KeyedOptions } from '@spaces/core/writes/connections/keyed'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import { availableProgram } from '#/lib/integrations/install'
import { integrationLedgerProgram } from '#/lib/integrations/ledger'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import type {
  MeetingNotesView,
  RecorderAccountView,
  RecorderKeyInput,
  RecorderOffer,
  RecorderSettingsInput,
} from './input'

/**
 * You → Meeting notes: the reader's recorder keys, their folders
 * with a tick each and the two private opt-ins.
 * - The user is always the session's; another member's key is never read.
 * - `SPACES_FAKE_PROVIDERS=1` is the only switch to the fake Granola, as it
 *   is in the worker.
 */

let fake: FetchLike | null = null

/** The provider transport: the fake when the flag is on, else the network. */
const keyedOptions = async (): Promise<KeyedOptions> => {
  if (process.env.SPACES_FAKE_PROVIDERS !== '1') return {}
  if (fake === null) {
    const { makeFakeGranolaApi } = await import('@spaces/sdk/testing')
    fake = makeFakeGranolaApi().fetch
  }
  return { fetch: fake }
}

const offerOf = (
  plugin: string,
  installed: ReadonlySet<string>,
  offered: ReadonlySet<string>,
  isAdmin: boolean,
): RecorderOffer => {
  if (installed.has(plugin)) return 'connect'
  if (!offered.has(plugin)) return 'unavailable'
  return isAdmin ? 'install' : 'ask'
}

const meetingNotesProgram = Effect.fn('meetingNotes')(function* (
  userId: string,
  isAdmin: boolean,
  options: KeyedOptions,
) {
  const ledger = yield* integrationLedgerProgram()
  const installed = new Set(ledger.map((r) => r.pluginId))
  const { available } = yield* availableProgram()
  const offered = new Set(available.map((p) => p.pluginId))
  const rows = yield* Effect.promise(() => listKeyedConnections(userId))
  const accounts: Array<RecorderAccountView> = []
  for (const row of rows) {
    const account = yield* recorderAccountProgram(userId, row.id, options).pipe(
      Effect.option,
    )
    if (account._tag === 'None') continue
    const a = account.value
    accounts.push({
      connectionId: a.connectionId,
      provider: a.provider,
      email: a.email,
      status: a.status,
      errorReason: a.errorReason,
      lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
      folders: a.folders === null ? null : [...a.folders],
      foldersError: a.foldersError,
      typedNotes: a.settings.typedNotes,
      transcript: a.settings.transcript,
    })
  }
  const view: MeetingNotesView = {
    accounts,
    providers: KEYED_PROVIDER_IDS.map((provider: KeyedProviderId) => {
      const entry = KEYED_PROVIDERS[provider]
      return {
        provider,
        label: entry.label,
        keyHint: entry.keyHint,
        plugin: entry.plugin,
        offer: offerOf(entry.plugin, installed, offered, isAdmin),
      }
    }),
  }
  return view
})

/** The server fns' bodies. `requireUser()` first, always. */

export async function meetingNotesHandler(): Promise<MeetingNotesView> {
  const user = await requireUser()
  return effectFn(meetingNotesProgram)(
    user.id,
    user.role === 'admin',
    await keyedOptions(),
  )
}

export async function connectRecorderKeyHandler(
  data: RecorderKeyInput,
): Promise<{ connectionId: string; email: string }> {
  const user = await requireUser()
  const options = await keyedOptions()
  return effectFn(
    Effect.fn('connectRecorderKey')(function* () {
      const ledger = yield* integrationLedgerProgram()
      const plugin = KEYED_PROVIDERS[data.provider].plugin
      if (!ledger.some((r) => r.pluginId === plugin))
        return yield* new KeyRefused({
          message: `${KEYED_PROVIDERS[data.provider].label} is not installed; ask an admin`,
        })
      return yield* connectKeyProgram(
        { userId: user.id, provider: data.provider, key: data.key },
        options,
      )
    }),
  )()
}

export async function saveRecorderSettingsHandler(
  data: RecorderSettingsInput,
): Promise<{
  folderIds: Array<string>
  typedNotes: boolean
  transcript: boolean
}> {
  const user = await requireUser()
  return effectFn(saveRecorderSettingsProgram)(user.id, data.connectionId, {
    folderIds: data.folderIds,
    typedNotes: data.typedNotes,
    transcript: data.transcript,
  })
}
