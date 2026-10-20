import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  makeFakeBoxApi,
  makeFakeCalendarApi,
  makeFakeDriveApi,
  makeFakeGmailApi,
  makeFakeGranolaApi,
} from '@spaces/sdk/testing'
import type {
  FakeBoxApi,
  FakeCalendarApi,
  FakeDriveApi,
  FakeGmailApi,
  FakeGranolaApi,
} from '@spaces/sdk/testing'
import { workspaceRoot } from '@spaces/core/writes/vault/key'
import { loadCassette } from './cassette'
import { makeFakeProvider } from './provider'
import type { FakeProvider } from './provider'
import type { FakeProviders, StandIn } from './switch'

/**
 * The fakes `SPACES_FAKE_PROVIDERS=1` stands in with, found in the
 * workspace: a cassette for each plugin that commits
 * `plugins/<id>/fixtures/cassette/cassette.json`, and a stateful fake API
 * for each plugin in `STATEFUL`, `BOXES`, `CALENDARS`, `MAILBOXES` or
 * `RECORDERS` whose
 * package is there. Outside a
 * workspace (the image) there are none, so every plugin runs live.
 */

/** The key `Secrets` hands a faked plugin with no credential bound. Not a key. */
export const fakeKeyFor = (pluginId: string): string => `fake-${pluginId}-key`

/** The access token a cassette-faked plugin is handed. Not a token. */
export const fakeTokenFor = (pluginId: string): string =>
  `fake-${pluginId}-token`

/** Providers with state — a tree, a change feed — faked by an API rather than a cassette. */
const STATEFUL: { readonly [pluginId: string]: () => FakeDriveApi } = {
  'google-drive': () => makeFakeDriveApi(),
}

/** Box's tree, events stream and downloads: the second storage source. */
const BOXES: { readonly [pluginId: string]: () => FakeBoxApi } = {
  box: () => makeFakeBoxApi(),
}

/** The calendar a syncer reads, laid out around the moment it is first asked for. */
const CALENDARS: { readonly [pluginId: string]: () => FakeCalendarApi } = {
  'google-calendar': () => makeFakeCalendarApi(),
}

/**
 * The mailbox a mail syncer reads, laid out around the moment it is first
 * asked for. A send's files are the host's own blob URLs, which the fake
 * hands to the real `fetch`: they never leave this deployment.
 */
const MAILBOXES: { readonly [pluginId: string]: () => FakeGmailApi } = {
  gmail: () => makeFakeGmailApi({ others: (url, init) => fetch(url, init) }),
}

/** A keyed recorder's notes and folders, laid out around the moment it is first asked for (D78). */
const RECORDERS: { readonly [pluginId: string]: () => FakeGranolaApi } = {
  granola: () => makeFakeGranolaApi(),
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/

export const cassetteProviders = (
  root: string | null = workspaceRoot(),
): FakeProviders & {
  /** The fake behind a stand-in, for a test to drive; null when there is none. */
  readonly provider: (pluginId: string) => FakeProvider | null
  /** The stateful fake behind a stand-in; null when there is none. */
  readonly api: (pluginId: string) => FakeDriveApi | null
  /** The fake Box behind a stand-in; null when there is none. */
  readonly box: (pluginId: string) => FakeBoxApi | null
  /** The fake calendar behind a stand-in; null when there is none. */
  readonly calendar: (pluginId: string) => FakeCalendarApi | null
  /** The fake mailbox behind a stand-in; null when there is none. */
  readonly gmail: (pluginId: string) => FakeGmailApi | null
  /** The fake recorder behind a stand-in; null when there is none. */
  readonly granola: (pluginId: string) => FakeGranolaApi | null
} => {
  const made = new Map<string, FakeProvider | null>()
  const apis = new Map<string, FakeDriveApi | null>()
  const boxes = new Map<string, FakeBoxApi | null>()
  const calendars = new Map<string, FakeCalendarApi | null>()
  const mailboxes = new Map<string, FakeGmailApi | null>()
  const recorders = new Map<string, FakeGranolaApi | null>()
  const inWorkspace = (pluginId: string) =>
    root !== null && PLUGIN_ID.test(pluginId)
      ? path.join(root, 'plugins', pluginId)
      : null
  const provider = (pluginId: string): FakeProvider | null => {
    const cached = made.get(pluginId)
    if (cached !== undefined) return cached
    let fake: FakeProvider | null = null
    const dir = inWorkspace(pluginId)
    if (dir !== null) {
      const fixtures = path.join(dir, 'fixtures')
      if (existsSync(path.join(fixtures, 'cassette', 'cassette.json')))
        fake = makeFakeProvider(loadCassette(fixtures))
    }
    made.set(pluginId, fake)
    return fake
  }
  const api = (pluginId: string): FakeDriveApi | null => {
    const cached = apis.get(pluginId)
    if (cached !== undefined) return cached
    const make = Object.hasOwn(STATEFUL, pluginId)
      ? STATEFUL[pluginId]
      : undefined
    const dir = inWorkspace(pluginId)
    const fake =
      make !== undefined && dir !== null && existsSync(dir) ? make() : null
    apis.set(pluginId, fake)
    return fake
  }
  const box = (pluginId: string): FakeBoxApi | null => {
    const cached = boxes.get(pluginId)
    if (cached !== undefined) return cached
    const make = Object.hasOwn(BOXES, pluginId) ? BOXES[pluginId] : undefined
    const dir = inWorkspace(pluginId)
    const fake =
      make !== undefined && dir !== null && existsSync(dir) ? make() : null
    boxes.set(pluginId, fake)
    return fake
  }
  const calendar = (pluginId: string): FakeCalendarApi | null => {
    const cached = calendars.get(pluginId)
    if (cached !== undefined) return cached
    const make = Object.hasOwn(CALENDARS, pluginId)
      ? CALENDARS[pluginId]
      : undefined
    const dir = inWorkspace(pluginId)
    const fake =
      make !== undefined && dir !== null && existsSync(dir) ? make() : null
    calendars.set(pluginId, fake)
    return fake
  }
  const gmail = (pluginId: string): FakeGmailApi | null => {
    const cached = mailboxes.get(pluginId)
    if (cached !== undefined) return cached
    const make = Object.hasOwn(MAILBOXES, pluginId)
      ? MAILBOXES[pluginId]
      : undefined
    const dir = inWorkspace(pluginId)
    const fake =
      make !== undefined && dir !== null && existsSync(dir) ? make() : null
    mailboxes.set(pluginId, fake)
    return fake
  }
  const granola = (pluginId: string): FakeGranolaApi | null => {
    const cached = recorders.get(pluginId)
    if (cached !== undefined) return cached
    const make = Object.hasOwn(RECORDERS, pluginId)
      ? RECORDERS[pluginId]
      : undefined
    const dir = inWorkspace(pluginId)
    const fake =
      make !== undefined && dir !== null && existsSync(dir) ? make() : null
    recorders.set(pluginId, fake)
    return fake
  }
  return {
    provider,
    api,
    box,
    calendar,
    gmail,
    granola,
    standIn: (pluginId): StandIn | null => {
      const stateful =
        api(pluginId) ??
        box(pluginId) ??
        calendar(pluginId) ??
        gmail(pluginId) ??
        granola(pluginId)
      if (stateful !== null)
        return {
          fetch: stateful.fetch,
          secret: fakeKeyFor(pluginId),
          accessToken: stateful.accessToken,
        }
      const fake = provider(pluginId)
      return fake === null
        ? null
        : {
            fetch: fake.fetch,
            secret: fakeKeyFor(pluginId),
            accessToken: fakeTokenFor(pluginId),
          }
    },
  }
}
