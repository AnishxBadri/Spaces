import { z } from 'zod'
import type { DomainEvent } from '@spaces/sdk'

/**
 * Auto-enrich scopes: which of a record's triggers run an integration's
 * event jobs for the owner. Host state on `integration.config`, never a
 * plugin setting. (D76)
 * - `deal`: the record joins a deal; `space`: it is filed into a chosen
 *   space (or a space below one); `meeting`: it appears in a synced
 *   meeting — a word only until that trigger exists.
 * - `autoEnrichSpaces` empty with `space` ticked means every space.
 * - A birth or a new identity is in scope when the record already stands in
 *   one: a party of a live deal, or filed in a chosen space.
 * - The legacy `autoEnrich` boolean reads as `deal` for true and none for
 *   false; with neither key, the default is `deal` alone.
 */

export const AUTO_ENRICH_SCOPES = ['deal', 'space', 'meeting'] as const
export type AutoEnrichScopeName = (typeof AUTO_ENRICH_SCOPES)[number]

/** The config keys the host writes; the plugin never reads them. */
export const SCOPES_KEY = 'autoEnrichScopes'
export const SPACES_KEY = 'autoEnrichSpaces'
/** Read, never written: the on/off switch the scopes replaced. */
export const LEGACY_KEY = 'autoEnrich'

export const DEFAULT_SCOPES: ReadonlyArray<AutoEnrichScopeName> = ['deal']

export type AutoEnrichScope = {
  readonly scopes: ReadonlyArray<AutoEnrichScopeName>
  /** Chosen space ids for the `space` scope; empty is every space. */
  readonly spaces: ReadonlyArray<string>
}

const scopeList = z.array(z.unknown())
const spaceList = z.array(z.uuid())

/** The scope a row's config holds, in `AUTO_ENRICH_SCOPES` order. */
export const autoEnrichScopeOf = (config: {
  readonly [key: string]: unknown
}): AutoEnrichScope => {
  const listed = scopeList.safeParse(config[SCOPES_KEY])
  const spaces = spaceList.safeParse(config[SPACES_KEY])
  const chosen: ReadonlyArray<unknown> = listed.success
    ? listed.data
    : config[LEGACY_KEY] === true
      ? ['deal']
      : config[LEGACY_KEY] === false
        ? []
        : DEFAULT_SCOPES
  return {
    scopes: AUTO_ENRICH_SCOPES.filter((s) => chosen.includes(s)),
    spaces: spaces.success ? spaces.data : [],
  }
}

/** The scope as config keys, the legacy switch dropped. */
export const autoEnrichConfig = <T>(
  config: { readonly [key: string]: T },
  scope: AutoEnrichScope,
): { [key: string]: T | Array<string> } => {
  const next: { [key: string]: T | Array<string> } = { ...config }
  delete next[LEGACY_KEY]
  next[SCOPES_KEY] = [...scope.scopes]
  next[SPACES_KEY] = [...scope.spaces]
  return next
}

/** `deal · space` — the ledger's word for a scope; `off` when none. */
export const scopeWords = (scope: AutoEnrichScope): string =>
  scope.scopes.length === 0 ? 'off' : scope.scopes.join(' · ')

/**
 * What the dispatcher read about the event's record:
 * - `dealParty`: it is a party of a live deal;
 * - `filedPaths`: the paths of the spaces it is filed in — for `filed`,
 *   only the space the event names;
 * - `chosenPaths`: each chosen space id's path.
 */
export type ScopeFacts = {
  readonly dealParty: boolean
  readonly filedPaths: ReadonlyArray<string>
  readonly chosenPaths: ReadonlyMap<string, string>
}

const under = (path: string, root: string) =>
  path === root || path.startsWith(`${root}.`)

const inChosenSpace = (scope: AutoEnrichScope, facts: ScopeFacts) => {
  if (!scope.scopes.includes('space') || facts.filedPaths.length === 0)
    return false
  if (scope.spaces.length === 0) return true
  return scope.spaces.some((id) => {
    const root = facts.chosenPaths.get(id)
    return root !== undefined && facts.filedPaths.some((p) => under(p, root))
  })
}

/** Whether this event, on this record, is in the scope. Pure. */
export const inScope = (
  scope: AutoEnrichScope,
  event: DomainEvent,
  facts: ScopeFacts,
): boolean => {
  switch (event.name) {
    case 'deal.linked':
      return scope.scopes.includes('deal')
    case 'filed':
      return inChosenSpace(scope, facts)
    case 'entity.created':
    case 'identity.added':
      return (
        (scope.scopes.includes('deal') && facts.dealParty) ||
        inChosenSpace(scope, facts)
      )
  }
}
