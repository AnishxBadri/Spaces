import { createContext, useContext } from 'react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { SettingsForm, useInSettingsForm } from './settings-form'
import { PageBody, PageHeader } from '#/components/page-header'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'

/**
 * The head's right padding: its action ends where the 800px column of cards
 * ends its content (12px gutter + 800 − 1px rule − 11px inset), never closer
 * to the page edge than the 24px every head keeps.
 */
export const SETTINGS_HEAD_CAP = 'pr-[max(1.5rem,calc(100%-50rem))]'

/**
 * The settings section — the shape every section of the settings shell
 * takes. The section is the page:
 *   - the head is the shared `PageHeader`: the serif title on the 24px edge,
 *     one rule across the full width, the section's one action right,
 *     ending with the 800px column;
 *   - for a member on an admin page, the head's mono line reads "Only
 *     admins can change this · ask <admins>", and every control in the
 *     section is disabled;
 *   - the body is the bone ground: a column of paper group cards
 *     (`SettingsGroup`), 800px wide from the gutter, 12px apart.
 * The section belongs to a page form (`SettingsForm`): typed fields collect
 * into its one Save bar. With no page form above it, the section opens one.
 */
export function SettingsSection({
  title,
  back,
  mark,
  meta,
  action,
  adminOnly = false,
  after,
  children,
}: {
  title: string
  /** The `‹ Plugins` link above the title, on a page drilled into from a list. */
  back?: ReactNode
  /** The plugin's or provider's mark beside the title. */
  mark?: ReactNode
  /** The head's mono line: what the instrument read, never prose. */
  meta?: ReactNode
  action?: ReactNode
  /**
   * Only an admin may change this section, on a page whose nav row is not
   * admin-only. An admin-only page needs no flag: its row says so.
   */
  adminOnly?: boolean
  /** Cards after the rest that stay live for a member: tabs to browse. */
  after?: ReactNode
  children: ReactNode
}) {
  const page = useSettingsPage()
  const inForm = useInSettingsForm()
  const readOnly = !page.isAdmin && (page.adminOnly || adminOnly)

  const section = (
    <section data-settings-page className="flex flex-1 flex-col">
      <div data-settings-head className="contents">
        <PageHeader
          {...(back === undefined ? {} : { eyebrow: back })}
          title={
            mark === undefined ? (
              title
            ) : (
              <span className="inline-flex items-center gap-2.5">
                {mark}
                {title}
              </span>
            )
          }
          {...(readOnly || meta !== undefined
            ? {
                description: (
                  <>
                    {meta}
                    {readOnly ? (
                      <span data-read-only>{readOnlyLine(page.admins)}</span>
                    ) : null}
                  </>
                ),
              }
            : {})}
          {...(action
            ? {
                action: (
                  <fieldset
                    disabled={readOnly}
                    className="flex items-center gap-2"
                  >
                    {action}
                  </fieldset>
                ),
              }
            : {})}
          className={SETTINGS_HEAD_CAP}
        />
      </div>
      {/* The foot clears the Save bar, so it never covers the last card. */}
      <PageBody className="pb-20">
        <div
          data-settings-body
          className="flex w-full max-w-200 flex-col gap-3"
        >
          {/* A disabled fieldset disables every control inside it, so a
              member's page cannot leave one live by omission. */}
          <fieldset disabled={readOnly} className="contents">
            {children}
          </fieldset>
          {after}
        </div>
      </PageBody>
    </section>
  )
  return inForm ? section : <SettingsForm>{section}</SettingsForm>
}

/**
 * The way back from a page drilled into from a settings list, above its
 * title: `‹ Plugins`, mono, in sentence case.
 */
export function SettingsBack({
  to,
  children,
}: {
  to: '/settings/plugins' | '/settings/connections'
  children: string
}) {
  return (
    <Link
      to={to}
      data-settings-back
      className="focus-ring rounded-md tracking-normal normal-case hover:text-foreground"
    >
      ‹ {children}
    </Link>
  )
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
 * A group inside a settings page: a paper card on the ground, 800px wide
 * with the column, headed by its mono caps label (`IDENTITY`, `PROVIDERS`,
 * `RATES`). Rows sit inside on the card's 11px inset, so their labels land
 * on the page's 24px edge.
 * - With no `title`, the card has no head: the rows of a page with no group
 *   share one.
 * - A settings card is a rule card, never hairline: a settings page has no
 *   folder.
 */
export function SettingsGroup({
  title,
  count,
  action,
  label,
  className,
  children,
  ...data
}: {
  title?: ReactNode
  /** Mono readout after the label — "1 of 7". */
  count?: ReactNode
  /** The group's one action, mono, right. */
  action?: ReactNode
  /** Names the card when it has no head. */
  label?: string | undefined
  className?: string | undefined
  children?: ReactNode
} & { [k: `data-${string}`]: string | boolean | undefined } & {
  id?: string | undefined
}) {
  return (
    <section
      data-card
      {...data}
      {...(label === undefined ? {} : { 'aria-label': label })}
      className={cn('flex flex-col card settings-card', className)}
    >
      {title === undefined ? null : (
        <SettingsGroupHead title={title} count={count} action={action} />
      )}
      {children}
    </section>
  )
}

/**
 * A group card's head: a 28px paper row, the mono caps label with an
 * optional mono count beside it and an optional action right, a rule under.
 * - Never the bone `SectionHead` band: a band heads a ledger in a folder,
 *   and a settings card's head is its own paper.
 * - `SettingsGroup` draws it; a group drawn by a component outside settings
 *   that opens on this head becomes a card by being wrapped in one.
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
      className="flex h-7 shrink-0 items-center justify-between gap-4 border-b border-rule px-(--inset)"
    >
      <div className="flex min-w-0 items-baseline gap-3">
        <h3 className="min-w-0 truncate label-caps leading-3.5 text-graphite">
          {title}
        </h3>
        {count === undefined || count === null || count === '' ? null : (
          <span className="shrink-0 mono text-micro leading-3.5 text-graphite">
            {count}
          </span>
        )}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-3 mono text-micro text-graphite">
          {action}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A table's first row in a settings card: its column heads, drawn as the
 * list table's head cells — 32px, sans 12 graphite, a rule closing each
 * named lane — inset like the rows so a head sits over its lane.
 * - Only on a card with three or more named columns: two lanes tell
 *   themselves apart.
 */
export function SettingsColumns({
  children,
  className,
}: {
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <div
      aria-hidden
      data-settings-columns
      className={cn(
        'flex h-8 shrink-0 items-center gap-3 border-b border-rule px-(--inset) text-label text-graphite',
        // Each head fills the row's height so its rule runs rule to rule;
        // an empty lane (an icon's, an action's) closes with no rule.
        '[&>*]:self-stretch [&>*]:leading-8 [&>*:not(:last-child):not(:empty)]:border-r [&>*:not(:last-child):not(:empty)]:border-rule',
        className,
      )}
    >
      {children}
    </div>
  )
}

export type SettingsTone = 'ok' | 'bad' | 'wait' | 'off'

/** The state square: pine working, crimson broken, hollow waiting, rule off. */
const STATE_DOT: Record<SettingsTone, string> = {
  ok: 'bg-primary',
  bad: 'bg-destructive',
  wait: 'border border-graphite',
  off: 'bg-rule',
}

/** A row's state: the square, then its mono word (`set`, `Synced 09:12`). */
export function SettingsState({
  tone,
  children,
  className,
}: {
  tone: SettingsTone
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <span
      data-state-tone={tone}
      className={cn('flex min-w-0 items-center gap-1.5', className)}
    >
      <span aria-hidden className={cn('size-1.5 shrink-0', STATE_DOT[tone])} />
      <span
        className={cn(
          'truncate mono text-micro',
          tone === 'bad' ? 'text-destructive' : 'text-graphite',
        )}
      >
        {children}
      </span>
    </span>
  )
}

/** A row action that goes to another page: mono, ending `›`. */
export const SETTINGS_LINK =
  'focus-ring rounded-md mono text-micro text-primary hover:underline'

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
 * One 48px row on a rule, inset 11px in its card: the label in a 210px lane,
 * the control in the lane after it, left-aligned; the row's state and its
 * action in the end lane at the right edge, always visible.
 * - `hint` is for cost, privacy or something irreversible only; any
 *   other explanation is a tooltip on the control, or nothing.
 * - `onOpen`: the row's Edit, opened from anywhere on the row.
 */
export function SettingsRow({
  label,
  hint,
  end,
  onOpen,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  /** State or action, right: a status square, or `Set up ›`. */
  end?: ReactNode
  onOpen?: (() => void) | undefined
  children?: ReactNode
}) {
  return (
    <div
      data-settings-row
      {...(onOpen === undefined ? {} : { onClick: rowOpens(onOpen) })}
      className={cn(
        'flex min-h-12 items-center gap-6 border-b border-rule px-(--inset) py-2',
        onOpen !== undefined &&
          'cursor-pointer transition-colors duration-150 ease-out-quart hover:bg-bone',
      )}
    >
      <div className="flex w-[13.125rem] shrink-0 flex-col gap-0.5">
        <span className="text-ui font-medium">{label}</span>
        {hint ? <span className="text-label text-graphite">{hint}</span> : null}
      </div>
      {children ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
          {children}
        </div>
      ) : end ? (
        <span className="min-w-0 flex-1" />
      ) : null}
      {end ? (
        <div data-settings-end className="flex shrink-0 items-center gap-4">
          {end}
        </div>
      ) : null}
    </div>
  )
}
