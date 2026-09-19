import { Link } from '@tanstack/react-router'
import { cn } from '#/lib/utils'

/**
 * The settings nav grammar (SPA-26), the chassis grammar one level in.
 *
 * A settings section reaches the shell as **one row of data** in
 * `SETTINGS_SECTIONS`, and the row decides everything about its place there:
 * the child route it links to, the label, the group it joins, and whether it
 * is admin-only. Eleven pending slices add a section each — Providers,
 * Routing, Usage, Integrations, Connections, Binding health, embeddings,
 * install — and each of them is one row plus one file under
 * `routes/_app/settings/`, no other edit.
 *
 * The groups mirror the chassis: `workspace` (the deployment and who is in
 * it), `objects` (what it records), `capital` (what it prices). The group is
 * also the crumb the section prints — `SETTINGS / WORKSPACE` — so a section
 * cannot name a place the nav does not have.
 *
 * `settings-nav.test.ts` fails naming both sections when two rows claim one
 * path, on a group that is not one of the three, and on a row that breaks the
 * group order — so the grammar is checked, not negotiated.
 */

/** The three groups of the settings shell, in the order the nav draws them. */
export const SETTINGS_GROUP_IDS = ['workspace', 'objects', 'capital'] as const
export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number]

/**
 * What each group is called in the crumb. `label-caps` prints it uppercase,
 * so `Capital` reads `SETTINGS / CAPITAL`.
 */
export const SETTINGS_CRUMBS = {
  workspace: 'Workspace',
  objects: 'Objects',
  capital: 'Capital',
} as const satisfies Record<SettingsGroupId, string>

/** The three crumbs a section may print, and nothing else. */
export type SettingsCrumb = (typeof SETTINGS_CRUMBS)[SettingsGroupId]

export type SettingsSectionRow = {
  /** The child route under the shell. `/settings` redirects to the first. */
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
  {
    to: '/settings/workspace',
    label: 'Workspace',
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
    to: '/settings/templates',
    label: 'Templates',
    group: 'workspace',
    admin: false,
  },
  { to: '/settings/objects', label: 'Objects', group: 'objects', admin: false },
  {
    to: '/settings/currency',
    label: 'Currency & FX',
    group: 'capital',
    admin: false,
  },
] as const satisfies readonly SettingsSectionRow[]

/** Where `/settings` lands. The first row, not a literal second copy. */
export const FIRST_SETTINGS_SECTION = SETTINGS_SECTIONS[0]

/** The groups, derived by filter — a row may be inserted anywhere in its own run. */
export const SETTINGS_GROUPS = {
  workspace: SETTINGS_SECTIONS.filter((s) => s.group === 'workspace'),
  objects: SETTINGS_SECTIONS.filter((s) => s.group === 'objects'),
  capital: SETTINGS_SECTIONS.filter((s) => s.group === 'capital'),
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

const ROW =
  'flex h-[1.875rem] shrink-0 items-center gap-2.5 rounded-md border border-transparent px-2.5 text-ui whitespace-nowrap transition-colors'

/**
 * The section nav: a ledger of rows on bone, current section = paper + rule +
 * medium weight (the No-Bar Rule — never a pine edge).
 *
 * Below `md` the same rows become a horizontal strip above the content,
 * scrolling on x inside their own container, with the rules between groups
 * drawn as vertical hairlines instead of horizontal ones. One component, two
 * orientations: no drawer, no second list to keep in step.
 */
export function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        'flex shrink-0 gap-3 overflow-x-auto border-b border-hairline bg-bone px-3 py-2',
        'md:w-52 md:flex-col md:gap-0 md:overflow-x-visible md:border-r md:border-b-0 md:px-3 md:py-3',
      )}
    >
      {SETTINGS_GROUP_IDS.map((id, i) => (
        <div
          key={id}
          className={cn(
            'flex shrink-0 gap-1 md:flex-col md:gap-0.5',
            i > 0 &&
              'border-l border-hairline pl-3 md:mt-2 md:border-t md:border-l-0 md:pt-2 md:pl-0',
          )}
        >
          {SETTINGS_GROUPS[id].map((row) =>
            sectionLocked(row, isAdmin) ? (
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
              </Link>
            ),
          )}
        </div>
      ))}
    </nav>
  )
}
