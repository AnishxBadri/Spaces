import { createContext, useContext } from 'react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { SettingsForm, useInSettingsForm } from './settings-form'
import type { SettingsCrumb } from './settings-nav'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'

/**
 * The settings section — the shape every section of the settings shell
 * takes, and the page head: the shell draws no title of its own. Top to bottom:
 *   - the **mono eyebrow** in sentence case, `Settings · <Group>` — the group
 *     is the one the section's row names in `SETTINGS_SECTIONS`;
 *   - the **serif title** in `title-serif`, and no sentence under it;
 *   - for a member on an admin page, one mono line, "Only admins can change
 *     this · ask <admins>", and every control in the section disabled;
 *   - an optional **action** right — the one primary of the section;
 *   - the **double rule** under the head (a settings section is the page),
 *     then the rows, grouped under `SettingsGroupHead` caps labels.
 * The section belongs to a page form (`SettingsForm`): typed fields collect
 * into its one Save bar. With no page form above it, the section opens one.
 */
export function SettingsSection({
  title,
  crumb,
  action,
  adminOnly = false,
  children,
}: {
  title: string
  /** The section's group, printed in the eyebrow as `Settings · Workspace`. */
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
      <div
        data-settings-head
        className="flex items-end justify-between gap-6 pb-2.5 double-rule"
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="mono text-micro leading-3.5 text-graphite">
            Settings · {crumb}
          </div>
          <h1 className="title-serif">{title}</h1>
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

/**
 * A group inside a settings page: a mono caps label on a hairline
 * (`IDENTITY`, `PROVIDERS`, `RATES`), 28px above it.
 * - Never the bone `SectionHead` band: a band heads a ledger, and a settings
 *   page is the page.
 */
export function SettingsGroupHead({
  title,
  count,
  action,
}: {
  title: ReactNode
  /** Mono readout after the label — "1 of 7". */
  count?: ReactNode
  /** The group's one action, mono, right. */
  action?: ReactNode
}) {
  return (
    <div
      data-settings-group
      className="flex items-end justify-between gap-4 border-b border-hairline pt-7 pb-1.5"
    >
      <div className="flex min-w-0 items-baseline gap-3">
        <h3 className="min-w-0 truncate label-caps leading-3.5 text-graphite">
          {title}
        </h3>
        {count ? (
          <span className="shrink-0 mono text-micro leading-3.5 text-graphite">
            {count}
          </span>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-baseline gap-3 mono text-micro text-graphite">
          {action}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A tooltip on one control — where a row's explanation goes when it is not
 * about cost, privacy or something irreversible. The child must take a
 * ref and spread its props (an `Input`, a `Button`).
 */
export function SettingsTip({
  tip,
  children,
}: {
  tip: ReactNode
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The click handler of a ledger row whose click opens its Edit window.
 * - A click on a control inside the row stays that control's.
 * - A click inside a window or menu the row renders is ignored: React
 *   bubbles it here through the portal although the row does not hold it.
 */
export function rowOpens(open: () => void) {
  return (e: MouseEvent<HTMLElement>) => {
    const row = e.currentTarget
    const target = e.target
    if (!(target instanceof Element) || !row.contains(target)) return
    const control = target.closest(
      'button, a, input, textarea, select, label, [role="menuitem"]',
    )
    if (control !== null && control !== row && row.contains(control)) return
    open()
  }
}

/**
 * One row on a rule: the label in a 210px lane, the control in the lane after
 * it, left-aligned — never pinned to the row's end.
 * - `hint` is for cost, privacy or something irreversible only; any
 *   other explanation is a tooltip on the control, or nothing.
 */
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
    <div className="flex min-h-12 items-center gap-6 border-b border-rule py-2">
      <div className="flex w-[13.125rem] shrink-0 flex-col gap-0.5">
        <span className="text-ui font-medium">{label}</span>
        {hint ? <span className="text-label text-graphite">{hint}</span> : null}
      </div>
      {children ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
          {children}
        </div>
      ) : null}
    </div>
  )
}
