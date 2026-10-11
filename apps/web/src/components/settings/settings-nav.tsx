import { Link } from '@tanstack/react-router'
import { cn } from '#/lib/utils'

/**
 * The settings nav grammar, the chassis grammar one level in.
 *
 * A settings section reaches the shell as **one row of data** in
 * `SETTINGS_SECTIONS`: the child route it links to, the label, the group it
 * joins, and whether only an admin may change it. A new section is one row plus one file
 * under `routes/_app/settings/`, placed by D81's map.
 *
 * The groups are by whose it is (D81):
 * - `you`: the reader's own accounts and tokens.
 * - `workspace`: the workspace, its people, what it records and prices.
 * - `ai`: models, search and what AI spends.
 * - `integrations`: plugins and the doors data comes in by.
 *
 * The group is also the eyebrow the section prints — `SETTINGS · WORKSPACE` —
 * so a section cannot name a place the nav does not have.
 */

/** The four groups of the settings shell, in the order the nav draws them. */
export const SETTINGS_GROUP_IDS = [
  'you',
  'workspace',
  'ai',
  'integrations',
] as const
export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number]

/**
 * What each group is called — the caps label over its rows in the nav, and
 * the section's eyebrow (`SETTINGS · AI`). One name, printed twice.
 */
export const SETTINGS_CRUMBS = {
  you: 'You',
  workspace: 'Workspace',
  ai: 'AI',
  integrations: 'Integrations',
} as const satisfies Record<SettingsGroupId, string>

/** The crumbs a section may print, and nothing else. */
export type SettingsCrumb = (typeof SETTINGS_CRUMBS)[SettingsGroupId]

export type SettingsSectionRow = {
  /** The child route under the shell. The path follows the label. */
  readonly to: string
  readonly label: string
  /** Which group the row joins. The groups are derived from this, not sliced. */
  readonly group: SettingsGroupId
  /**
   * Admin-only writes. A member still opens the page and reads it, with every
   * control disabled under the head's "Only admins can change this" line;
   * the write server fns refuse a member regardless. (D81)
   */
  readonly admin: boolean
}

export const SETTINGS_SECTIONS = [
  // The reader's own accounts, by the job they do; the OAuth clients are
  // Connection apps. (D81)
  {
    to: '/settings/email-calendar',
    label: 'Email & calendar',
    group: 'you',
    admin: false,
  },
  { to: '/settings/files', label: 'Files', group: 'you', admin: false },
  {
    to: '/settings/meeting-notes',
    label: 'Meeting notes',
    group: 'you',
    admin: false,
  },
  // The MCP server's tokens: a token is its owner's, so not admin-only.
  { to: '/settings/tokens', label: 'API tokens', group: 'you', admin: false },
  {
    to: '/settings/general',
    label: 'General',
    group: 'workspace',
    admin: false,
  },
  {
    to: '/settings/members',
    label: 'Members',
    group: 'workspace',
    admin: false,
  },
  {
    to: '/settings/objects',
    label: 'Objects',
    group: 'workspace',
    admin: false,
  },
  {
    to: '/settings/templates',
    label: 'Templates',
    group: 'workspace',
    admin: false,
  },
  {
    to: '/settings/currency',
    label: 'Currency & FX',
    group: 'workspace',
    admin: false,
  },
  // Providers and routing: the vault's LLM keys are the admin's.
  { to: '/settings/models', label: 'Models', group: 'ai', admin: true },
  // The embedding pin and its key, admin-only like the provider keys.
  { to: '/settings/search', label: 'Search', group: 'ai', admin: true },
  // The run log is every member's provenance; only its Caps are the admin's.
  {
    to: '/settings/usage',
    label: 'Usage & limits',
    group: 'ai',
    admin: false,
  },
  // The installed plugins, their keys and settings.
  {
    to: '/settings/plugins',
    label: 'Plugins',
    group: 'integrations',
    admin: true,
  },
  // Where enriched values come from: the sources in order and auto-enrich. (D76)
  {
    to: '/settings/enrichment',
    label: 'Enrichment',
    group: 'integrations',
    admin: true,
  },
  // The forwarding mailbox and its app password.
  {
    to: '/settings/email-forwarding',
    label: 'Email forwarding',
    group: 'integrations',
    admin: true,
  },
  // The providers' OAuth clients every member's Connect leaves through.
  {
    to: '/settings/connection-apps',
    label: 'Connection apps',
    group: 'integrations',
    admin: true,
  },
] as const satisfies readonly SettingsSectionRow[]

/** Where `/settings` lands: General, the workspace's own page. (D81) */
export const SETTINGS_LANDING = '/settings/general' satisfies SettingsPath

/** A row's path; the type a landing or a lookup must be one of. */
export type SettingsPath = (typeof SETTINGS_SECTIONS)[number]['to']

/** The groups, derived by filter — a row may be inserted anywhere in its own run. */
export const SETTINGS_GROUPS = {
  you: SETTINGS_SECTIONS.filter((s) => s.group === 'you'),
  workspace: SETTINGS_SECTIONS.filter((s) => s.group === 'workspace'),
  ai: SETTINGS_SECTIONS.filter((s) => s.group === 'ai'),
  integrations: SETTINGS_SECTIONS.filter((s) => s.group === 'integrations'),
} satisfies Record<SettingsGroupId, readonly SettingsSectionRow[]>

/**
 * The row a settings path belongs to: its own, or the row a drill-in page
 * (`/settings/plugins/<id>`) sits under. `undefined` off the map.
 */
export function sectionAt(pathname: string): SettingsSectionRow | undefined {
  return SETTINGS_SECTIONS.find(
    (row) => pathname === row.to || pathname.startsWith(`${row.to}/`),
  )
}

/** A count for the right lane, keyed by the row's path. */
export type SettingsCounts = Partial<Record<SettingsSectionRow['to'], number>>

const ROW =
  'flex h-[1.875rem] shrink-0 items-center gap-2.5 rounded-md border border-transparent px-2.5 text-ui whitespace-nowrap transition-colors'

/**
 * The section nav: caps group labels the way the chassis prints them, 30px
 * rows, current section = paper + rule + medium weight (the No-Bar Rule —
 * never a pine edge), and a count in the right lane where the shell has one.
 *
 * - `chassis`: the rows down the sidebar, which settings takes over at `md`.
 * - `strip`: below `md`, the same rows as a horizontal strip above the
 *   content, scrolling on x, with vertical hairlines between groups.
 */
export function SettingsNav({
  counts = {},
  variant,
}: {
  counts?: SettingsCounts
  variant: 'chassis' | 'strip'
}) {
  const chassis = variant === 'chassis'
  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        chassis
          ? 'flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3 pb-3'
          : 'flex shrink-0 gap-3 overflow-x-auto border-b border-hairline bg-bone px-3 py-2',
      )}
    >
      {SETTINGS_GROUP_IDS.map((id, i) => (
        <div
          key={id}
          className={cn(
            chassis
              ? 'flex flex-col gap-0.5'
              : 'flex shrink-0 items-center gap-1',
            i > 0 && (chassis ? 'mt-5' : 'border-l border-hairline pl-3'),
          )}
        >
          {chassis ? (
            <div className="flex h-6 items-center px-2.5">
              <span className="label-caps text-graphite">
                {SETTINGS_CRUMBS[id]}
              </span>
            </div>
          ) : null}
          {SETTINGS_GROUPS[id].map((row) => {
            const count = counts[row.to]
            return (
              <Link
                key={row.to}
                to={row.to}
                className={cn(
                  ROW,
                  'text-foreground hover:bg-bone-deep',
                  'focus-ring',
                )}
                activeProps={{
                  className: 'border-rule bg-paper font-medium hover:bg-paper',
                  'aria-current': 'page',
                }}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {count !== undefined ? (
                  <span className="shrink-0 mono text-micro font-normal text-graphite">
                    {count}
                  </span>
                ) : null}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
