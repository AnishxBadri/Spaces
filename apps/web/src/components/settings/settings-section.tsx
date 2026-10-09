import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { SettingsForm, useInSettingsForm } from './settings-form'
import type { SettingsCrumb } from './settings-nav'

/**
 * The settings section — the shape every section of the settings shell takes
 * (`docs/design-contract.md` §3, "A settings section"), and the page head:
 * the shell draws no title of its own. Top to bottom:
 *
 *   - the **mono eyebrow**, `SETTINGS · <GROUP>` — the group is the one the
 *     section's row names in `SETTINGS_SECTIONS`;
 *   - the **serif title** in `title-serif`;
 *   - **one sans sentence** under it, graphite, optional — what the section
 *     decides, never instructions and never doctrine;
 *   - for a member on an admin page, one mono line, "Only admins can change
 *     this · ask <admins>", and every control in the section disabled (D81);
 *   - an optional **action** right — the one primary of the section;
 *   - a **hairline under** the head, then the rows.
 *
 * The section belongs to a page form (`SettingsForm`): typed fields collect
 * into its one Save bar. With no page form above it, the section opens one.
 */
export function SettingsSection({
  title,
  blurb,
  crumb,
  action,
  adminOnly = false,
  children,
}: {
  title: string
  /** One sentence, what the section decides. Omit when the title says it. */
  blurb?: ReactNode
  /** The section's group, printed caps in the eyebrow as `SETTINGS · GENERAL`. */
  crumb: SettingsCrumb
  action?: ReactNode
  /**
   * Only an admin may change this section, on a page whose nav row is not
   * admin-only. An admin-only page needs no flag: its row says so.
   */
  adminOnly?: boolean
  children: ReactNode
}) {
  const page = useSettingsPage()
  const inForm = useInSettingsForm()
  const readOnly = !page.isAdmin && (page.adminOnly || adminOnly)

  const section = (
    <section className="flex flex-col">
      <div className="flex items-end justify-between gap-6 border-b border-hairline pb-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="mono text-micro leading-3.5 tracking-[0.08em] text-graphite uppercase">
            Settings · {crumb}
          </div>
          <h1 className="title-serif">{title}</h1>
          {blurb ? <p className="text-ui text-graphite">{blurb}</p> : null}
          {readOnly ? (
            <p data-read-only className="mono text-micro text-graphite">
              {readOnlyLine(page.admins)}
            </p>
          ) : null}
        </div>
        {action ? (
          <fieldset
            disabled={readOnly}
            className="flex shrink-0 items-center gap-3"
          >
            {action}
          </fieldset>
        ) : null}
      </div>
      {/* A disabled fieldset disables every control inside it, so a member's
          page cannot leave one live by omission. */}
      <fieldset disabled={readOnly} className="contents">
        {children}
      </fieldset>
    </section>
  )
  return inForm ? section : <SettingsForm>{section}</SettingsForm>
}

/** "Only admins can change this · ask Anish or Priya". */
export function readOnlyLine(admins: ReadonlyArray<string>): string {
  if (admins.length === 0) return 'Only admins can change this'
  const last = admins.at(-1) ?? ''
  const names =
    admins.length === 1 ? last : `${admins.slice(0, -1).join(', ')} or ${last}`
  return `Only admins can change this · ask ${names}`
}

export type SettingsPage = {
  readonly isAdmin: boolean
  /** The page's nav row is admin-only. */
  readonly adminOnly: boolean
  /** The admins a member is told to ask, by name. */
  readonly admins: ReadonlyArray<string>
}

/** Outside the shell (a component test) every section is the admin's. */
const PageContext = createContext<SettingsPage>({
  isAdmin: true,
  adminOnly: false,
  admins: [],
})

/** The shell's word on the page: who reads it, and whether they may change it. */
export function SettingsPageProvider({
  value,
  children,
}: {
  value: SettingsPage
  children: ReactNode
}) {
  return <PageContext.Provider value={value}>{children}</PageContext.Provider>
}

export function useSettingsPage(): SettingsPage {
  return useContext(PageContext)
}

/** One row: label + hint left, the control right. 48px on a rule, inset
 *  12px so the label sits under a group band's title. */
export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 border-b border-rule px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-ui font-medium">{label}</span>
        {hint ? <span className="text-label text-graphite">{hint}</span> : null}
      </div>
      {children ? (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      ) : null}
    </div>
  )
}
