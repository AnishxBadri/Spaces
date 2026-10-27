import { Effect, Redacted, Result, Schema } from 'effect'
import { jsonString } from '@spaces/core/json'
import { hasScopes } from '@spaces/core/writes/connections/scopes'
import { storageSourceSettingsFor } from '@spaces/core/writes/connections/sources'
import { accessTokenFor } from '@spaces/core/writes/connections/token'
import type { FakeDriveSeedItem } from '@spaces/sdk/testing'
import { connectHref } from '#/lib/connections/products'
import { activeConnectionFor } from './attach-link'
import type { NoConnection } from './attach-link'
import type { StorageLinkProvider } from './storage-link'

/**
 * The provider's picker, opened in the browser: whether it can open, and the
 * access token it opens with, minted for that one call.
 * - A token in a browser is every scope on its connection, so the mint only
 *   hands over a connection whose scopes past `openid`/`email` each read the
 *   picked file (`drive.file`, or `drive.readonly` a folder binding added):
 *   the picker still returns only what the user selects. Anything else is
 *   refused, never downgraded.
 * - The token leaves only in `ok.token`, over a POST; it is never logged.
 */

export type PickerView = 'DOCS' | 'SHARED_DRIVES' | 'FOLDERS'

/** Files to attach, or one folder to link (Link a Drive folder). */
export type PickerMode = 'files' | 'folders'

type PickerSpec = {
  readonly target: StorageLinkProvider
  /** The picker set: what the connection must hold. */
  readonly scopes: ReadonlyArray<string>
  /** Besides sign-in, what the token may carry: scopes that read a picked file. */
  readonly reads: ReadonlyArray<string>
  readonly signIn: ReadonlyArray<string>
  readonly scriptUrl: string
  readonly views: ReadonlyArray<PickerView>
  /** The views a folder pick opens on. */
  readonly folderViews: ReadonlyArray<PickerView>
  /** The settings on the provider's storage-source row the picker needs. */
  readonly settings: { readonly apiKey: string; readonly appId: string }
}

export const PICKERS = {
  google: {
    target: { provider: 'google', product: 'drive', label: 'Drive' },
    scopes: ['drive.file'],
    reads: ['drive.file', 'drive.readonly'],
    signIn: ['openid', 'email'],
    scriptUrl: 'https://apis.google.com/js/api.js',
    views: ['DOCS', 'SHARED_DRIVES'],
    folderViews: ['FOLDERS'],
    settings: { apiKey: 'pickerApiKey', appId: 'pickerAppId' },
  },
} as const satisfies Record<string, PickerSpec>

export type PickerProvider = keyof typeof PICKERS

export type PickerOptions = {
  /** Where a Connect or re-consent dance lands: the record's page. */
  readonly returnTo: string
  /** `SPACES_FAKE_PROVIDERS=1`: the fake Drive's seed is listed in the app instead. */
  readonly fake: boolean
}

/** Why the picker cannot open yet; `integrationId` is where an admin fixes it. */
export type PickerUnconfigured = {
  readonly _tag: 'unconfigured'
  readonly reason: string
  readonly integrationId: string | null
}

export type PickerBlocked =
  | NoConnection
  | { readonly _tag: 'consent'; readonly href: string }
  | PickerUnconfigured

export type PickerReadiness = { readonly _tag: 'ready' } | PickerBlocked

export type FakePickerFile = {
  readonly id: string
  readonly name: string
  readonly path: string | null
}

export type MintPickerOutcome =
  | PickerBlocked
  | {
      readonly _tag: 'ok'
      readonly token: string
      readonly developerKey: string
      readonly appId: string
      readonly scriptUrl: string
      readonly views: ReadonlyArray<PickerView>
    }
  | {
      readonly _tag: 'fake'
      /** The connected account the files are listed from. */
      readonly account: string
      readonly files: ReadonlyArray<FakePickerFile>
    }

/** The connection holds a scope that does not read a picked file: no token leaves. */
export class PickerScopeTooBroad extends Schema.TaggedError<PickerScopeTooBroad>()(
  'PickerScopeTooBroad',
  { scopes: Schema.Array(Schema.String), message: Schema.String },
) {}

export class PickerMintFailed extends Schema.TaggedError<PickerMintFailed>()(
  'PickerMintFailed',
  { cause: Schema.Defect() },
) {}

/** The sentence a caller shows for a failed mint. */
export function pickerMessage(failure: unknown): string {
  if (failure instanceof PickerScopeTooBroad) return failure.message
  return 'Could not open the picker'
}

type Settings = { readonly developerKey: string; readonly appId: string }

const settingsOf = Effect.fn('picker.settings')(function* (
  spec: PickerSpec,
): Effect.fn.Return<Settings | PickerUnconfigured, PickerMintFailed> {
  const row = yield* storageSourceSettingsFor(spec.target.provider).pipe(
    Effect.mapError((e) => new PickerMintFailed({ cause: e.cause })),
  )
  if (row === null)
    return {
      _tag: 'unconfigured',
      reason: `No ${spec.target.label} integration is installed; an admin adds it in Settings → Plugins.`,
      integrationId: null,
    }
  const developerKey = jsonString(row.config[spec.settings.apiKey])
  const appId = jsonString(row.config[spec.settings.appId])
  if (
    developerKey === null ||
    developerKey === '' ||
    appId === null ||
    appId === ''
  )
    return {
      _tag: 'unconfigured',
      reason: `The ${spec.target.label} picker needs Picker API key and Picker app id, set on the integration in Settings → Plugins.`,
      integrationId: row.integrationId,
    }
  return { developerKey, appId }
})

/**
 * Everything the mint checks short of the token: the row's picker settings
 * (the fake needs none), the user's own connection, the picker scope, and
 * nothing broader.
 */
const preflight = Effect.fn('picker.preflight')(function* (
  userId: string,
  provider: PickerProvider,
  options: PickerOptions,
): Effect.fn.Return<
  | {
      readonly _tag: 'clear'
      readonly connectionId: string
      /** The connected account, which the in-app pick list is titled with. */
      readonly account: string
      readonly settings: Settings | null
    }
  | PickerBlocked,
  PickerScopeTooBroad | PickerMintFailed
> {
  const spec: PickerSpec = PICKERS[provider]
  let settings: Settings | null = null
  if (!options.fake) {
    const found = yield* settingsOf(spec)
    if ('_tag' in found) return found
    settings = found
  }

  const connection = yield* activeConnectionFor(
    userId,
    spec.target,
    options.returnTo,
  ).pipe(Effect.mapError((e) => new PickerMintFailed({ cause: e.cause })))
  if (connection._tag !== 'active') return connection
  const { id, scopes, externalEmail } = connection.connection

  const check = yield* hasScopes(id, spec.scopes).pipe(
    Effect.mapError((cause) => new PickerMintFailed({ cause })),
  )
  if (check._tag === 'missing')
    return {
      _tag: 'consent',
      href: connectHref(
        spec.target.provider,
        spec.target.product,
        check.scopes,
        options.returnTo,
      ),
    }

  const allowed = new Set([...spec.scopes, ...spec.reads, ...spec.signIn])
  const broader = scopes.filter((s) => !allowed.has(s))
  if (broader.length > 0)
    return yield* new PickerScopeTooBroad({
      scopes: broader,
      message: `The picker opens only on a ${spec.target.label} connection whose scopes read the files you pick; this one also holds ${broader.join(', ')}. Paste a link instead.`,
    })
  return {
    _tag: 'clear',
    connectionId: id,
    account: externalEmail,
    settings,
  }
})

/** Whether the picker can open for this user, without minting anything. */
export const pickerReadinessProgram = Effect.fn('pickerReadinessProgram')(
  function* (
    userId: string,
    provider: PickerProvider,
    options: PickerOptions,
  ): Effect.fn.Return<PickerReadiness, PickerScopeTooBroad | PickerMintFailed> {
    const found = yield* preflight(userId, provider, options)
    return found._tag === 'clear' ? { _tag: 'ready' } : found
  },
)

/**
 * The picker's opening: a fresh access token for this one call with the
 * row's key and app id, or the fake's file list (its folders, for a folder
 * pick). Every check of `pickerReadinessProgram` runs again here.
 */
export const mintPickerTokenProgram = Effect.fn('mintPickerTokenProgram')(
  function* (
    userId: string,
    provider: PickerProvider,
    options: PickerOptions,
    mode: PickerMode = 'files',
  ): Effect.fn.Return<
    MintPickerOutcome,
    PickerScopeTooBroad | PickerMintFailed
  > {
    const found = yield* preflight(userId, provider, options)
    if (found._tag !== 'clear') return found
    if (options.fake) {
      const { FAKE_DRIVE_SEED } = yield* Effect.promise(
        () => import('@spaces/sdk/testing'),
      )
      return {
        _tag: 'fake',
        account: found.account,
        files:
          mode === 'folders'
            ? fakePickerFolders(FAKE_DRIVE_SEED)
            : fakePickerFiles(FAKE_DRIVE_SEED),
      }
    }
    if (found.settings === null)
      return yield* new PickerMintFailed({ cause: 'no picker settings' })

    const spec = PICKERS[provider]
    // A refused or unreachable grant says why; it never throws past here.
    const minted = yield* Effect.result(accessTokenFor(found.connectionId))
    if (Result.isFailure(minted))
      return { _tag: 'refused', reason: minted.failure.message }
    return {
      _tag: 'ok',
      token: Redacted.value(minted.success),
      developerKey: found.settings.developerKey,
      appId: found.settings.appId,
      scriptUrl: spec.scriptUrl,
      views: mode === 'folders' ? spec.folderViews : spec.views,
    }
  },
)

type Folder = { readonly name: string; readonly parentId: string | null }

/** A reader of the folder path above a parent id, as Drive shows it; null at a root. */
function seedPaths(seed: ReadonlyArray<FakeDriveSeedItem>) {
  const folders = new Map(
    seed.flatMap((item): Array<[string, Folder]> =>
      item.kind === 'folder'
        ? [[item.id, { name: item.name, parentId: item.parentId }]]
        : [],
    ),
  )
  const pathOf = (parentId: string | null): string | null => {
    const names: Array<string> = []
    for (let id = parentId; id !== null;) {
      const folder = folders.get(id)
      if (folder === undefined) break
      names.unshift(folder.name)
      id = folder.parentId
    }
    return names.length === 0 ? null : names.join(' / ')
  }
  return pathOf
}

/** The seed's files, each with its folder path as Drive shows it. */
export function fakePickerFiles(
  seed: ReadonlyArray<FakeDriveSeedItem>,
): Array<FakePickerFile> {
  const pathOf = seedPaths(seed)
  return seed.flatMap((item) =>
    item.kind === 'folder'
      ? []
      : [{ id: item.id, name: item.name, path: pathOf(item.parentId) }],
  )
}

/** The seed's folders, roots included, each with the path above it. */
export function fakePickerFolders(
  seed: ReadonlyArray<FakeDriveSeedItem>,
): Array<FakePickerFile> {
  const pathOf = seedPaths(seed)
  return seed.flatMap((item) =>
    item.kind === 'folder'
      ? [{ id: item.id, name: item.name, path: pathOf(item.parentId) }]
      : [],
  )
}
