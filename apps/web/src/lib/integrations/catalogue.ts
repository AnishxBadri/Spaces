import type { Manifest, PluginRole } from '@spaces/sdk'

/**
 * The Plugins catalogue and the plugin page, the pure half: role words and
 * tabs, the ledger's one number, what a plugin sends out of the box and what
 * it switches on elsewhere. Client-safe — no database, no server import.
 * (D81)
 */

/** Each role as the catalogue prints it, in the order its tabs run. */
export const ROLE_LABEL: { readonly [R in PluginRole]: string } = {
  enrichment: 'Enrichment',
  research: 'Research',
  'email-calendar': 'Email & calendar',
  files: 'Files',
  'meeting-notes': 'Meeting notes',
  import: 'Import',
  feeds: 'Feeds',
}

export const ROLE_ORDER: ReadonlyArray<PluginRole> = [
  'enrichment',
  'research',
  'email-calendar',
  'files',
  'meeting-notes',
  'import',
  'feeds',
]

/** `Research · Enrichment`, in the manifest's order; empty for none. */
export const roleWords = (roles: ReadonlyArray<PluginRole>): string =>
  roles.map((r) => ROLE_LABEL[r]).join(' · ')

export type CatalogueTab = 'all' | 'other' | PluginRole

export type CatalogueTabItem = {
  readonly id: CatalogueTab
  readonly label: string
  readonly count: number
}

/**
 * Available's tabs: All, then each role some plugin declares, then Other
 * only when a plugin declares none. A plugin with two roles counts in both.
 */
export function catalogueTabs(
  plugins: ReadonlyArray<{ readonly roles: ReadonlyArray<PluginRole> }>,
): Array<CatalogueTabItem> {
  const roles = ROLE_ORDER.map((role) => ({
    id: role,
    label: ROLE_LABEL[role],
    count: plugins.filter((p) => p.roles.includes(role)).length,
  })).filter((t) => t.count > 0)
  const other = plugins.filter((p) => p.roles.length === 0).length
  return [
    { id: 'all', label: 'All', count: plugins.length },
    ...roles,
    ...(other > 0
      ? [{ id: 'other' as const, label: 'Other', count: other }]
      : []),
  ]
}

export const inTab = (
  plugin: { readonly roles: ReadonlyArray<PluginRole> },
  tab: CatalogueTab,
): boolean => {
  if (tab === 'all') return true
  if (tab === 'other') return plugin.roles.length === 0
  return plugin.roles.includes(tab)
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/**
 * The ledger's one number, by the job the plugin does: signals for a feed or
 * a researcher, credits for an enrichment source, people connected for an
 * account-backed plugin. With no role it falls back on what the manifest
 * asks for; a dash when nothing counts.
 */
export function figureOf(input: {
  readonly roles: ReadonlyArray<PluginRole>
  readonly requires: Manifest['requires'] | undefined
  readonly credits: { readonly used: number; readonly cap: number | null }
  readonly signals: number
  readonly people: number
}): string {
  const { roles, credits } = input
  const signals = plural(input.signals, 'signal', 'signals')
  const people = plural(input.people, 'person', 'people')
  const spent =
    credits.cap === null
      ? `${credits.used} credits`
      : `${credits.used} / ${credits.cap} credits`
  if (roles.includes('feeds') || roles.includes('research')) return signals
  if (roles.includes('enrichment')) return spent
  if (
    roles.includes('email-calendar') ||
    roles.includes('files') ||
    roles.includes('meeting-notes')
  )
    return people
  if (input.requires?.connection !== undefined) return people
  if (input.requires?.credential !== undefined || credits.cap !== null)
    return spent
  if (input.signals > 0) return signals
  return '—'
}

/** What an action target hands an enrichment source to look it up by. */
const LOOKUP_KEYS: {
  readonly [
    T in NonNullable<Manifest['actions']>[number]['on']
  ]: ReadonlyArray<string>
} = {
  company: ['domain'],
  person: ['email', 'LinkedIn URL'],
  deal: ['deal name'],
}

const targetsOf = (manifest: Manifest) => [
  ...new Set((manifest.actions ?? []).map((a) => a.on)),
]

/**
 * What a plugin sends out of the box, read from the manifest's `requires`
 * and `roles`: an enrichment source (by its key or its role) the lookup
 * keys of the records it acts on, a search
 * or model key the text it is handed, a connection nothing (it reads the
 * account). Empty until the worker has read the manifest.
 */
export function sendsOf(manifest: Manifest | null): ReadonlyArray<string> {
  if (manifest === null) return []
  const credential = manifest.requires?.credential
  const connection = manifest.requires?.connection
  if (
    credential?.kind === 'enrichment' ||
    (manifest.roles ?? []).includes('enrichment')
  ) {
    const targets = targetsOf(manifest)
    const keys = (
      targets.length === 0 ? (['company', 'person'] as const) : targets
    ).flatMap((t) => LOOKUP_KEYS[t])
    return [...new Set(keys)]
  }
  if (credential?.kind === 'search') return ['the search text']
  if (credential?.kind === 'llm') return ['the record text a job is given']
  if (connection !== undefined)
    return 'key' in connection
      ? ['nothing out · reads the notes each member shares']
      : [`nothing out · reads ${connection.scopes.join(', ')}`]
  const calls = Object.values(manifest.jobs).some((j) =>
    j.uses.includes('Http'),
  )
  return calls ? ['only the addresses its settings name'] : ['nothing out']
}

/** The page that owns a capability a plugin switches on. */
export type CapabilityOwner =
  | 'enrichment'
  | 'watching'
  | 'email-calendar'
  | 'files'
  | 'meeting-notes'
  | 'import'

export type Capability = {
  /** What it does there, in a sentence fragment: `Fills company fields`. */
  readonly what: string
  readonly owner: CapabilityOwner
}

const joinAnd = (words: ReadonlyArray<string>): string =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`

/**
 * What a plugin switches on elsewhere, one line per role, each owned by
 * another page. Never a setting: the plugin page links to the owner.
 * - `fillable`: how many linked attributes an enrichment source can fill,
 *   read by the caller; null when it was not counted.
 */
export function capabilitiesOf(
  manifest: Manifest | null,
  fillable: number | null = null,
): ReadonlyArray<Capability> {
  if (manifest === null) return []
  const targets = targetsOf(manifest)
  return (manifest.roles ?? []).map((role): Capability => {
    switch (role) {
      case 'enrichment':
        return {
          what:
            fillable === null
              ? `Fills ${targets.length === 0 ? 'record' : joinAnd(targets)} fields`
              : `Can fill ${plural(fillable, 'field', 'fields')}`,
          owner: 'enrichment',
        }
      case 'research':
        return { what: 'Researches records and spaces', owner: 'watching' }
      case 'feeds':
        return { what: 'Adds feed items as signals', owner: 'watching' }
      case 'email-calendar':
        return { what: 'Syncs mail and calendars', owner: 'email-calendar' }
      case 'files':
        return { what: 'Reads connected storage', owner: 'files' }
      case 'meeting-notes':
        return { what: 'Brings in meeting notes', owner: 'meeting-notes' }
      case 'import':
        return { what: 'Reads exports dropped on Import', owner: 'import' }
    }
  })
}

/** `plugin.apollo.enrichCompany` → `enrichCompany`. */
export const jobOfQueue = (queue: string): string =>
  queue.split('.').at(-1) ?? queue

/** `340ms`, `1.2s`, `3m 4s`; null while the run has not finished. */
export function durationOf(ms: number | null): string | null {
  if (ms === null) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}
