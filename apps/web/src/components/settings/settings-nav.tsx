import { Link } from '@tanstack/react-router'
import { cn } from '#/lib/utils'

/**
 * The settings nav grammar, the chassis grammar one level in.
 *
 * A settings section reaches the shell as **one row of data** in
 * `SETTINGS_SECTIONS`: the child route it links to, the label, the group it
 * joins, and whether it is admin-only. A new section is one row plus one file
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
   * Admin-only: the row still draws for a member — graphite, `admin` in the
   * right lane, not a link — rather than a link into a page that refuses.
   * The child route's own guard is unchanged either way, so a typed URL
   * refuses exactly as it refused before.
   */
  readonly admin: boolean
}

export const SETTINGS_SECTIONS = [
  // The reader's own connections; the OAuth clients are Connection apps.
  {
    to: '/settings/connections',
    label: 'Connections',
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

/** Where `/settings` lands. The first row, not a literal second copy. */
export const FIRST_SETTINGS_SECTION = SETTINGS_SECTIONS[0]

/** The groups, derived by filter — a row may be inserted anywhere in its own run. */
export const SETTINGS_GROUPS = {
  you: SETTINGS_SECTIONS.filter((s) => s.group === 'you'),
  workspace: SETTINGS_SECTIONS.filter((s) => s.group === 'workspace'),
  ai: SETTINGS_SECTIONS.filter((s) => s.group === 'ai'),
  integrations: SETTINGS_SECTIONS.filter((s) => s.group === 'integrations'),
} satisfies Record<SettingsGroupId, readonly SettingsSectionRow[]>

/**
 * A row reads as locked exactly when it is admin-only and the reader is not
 * an admin. One expression, so the nav and the test agree by construction.
 */
export function sectionLocked(
  row: SettingsSectionRow,
  isAdmin: boolean,
): boolean {
  return row.admin && !isAdmin
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
  isAdmin,
  counts = {},
  variant,
}: {
  isAdmin: boolean
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
              <span className="field-label leading-4 font-medium text-graphite">
                {SETTINGS_CRUMBS[id]}
              </span>
            </div>
          ) : null}
          {SETTINGS_GROUPS[id].map((row) => {
            const count = counts[row.to]
            return sectionLocked(row, isAdmin) ? (
              <span
                key={row.to}
                aria-disabled="true"
                className={cn(ROW, 'text-graphite')}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="shrink-0 mono text-micro text-graphite">
                  admin
                </span>
              </span>
            ) : (
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
