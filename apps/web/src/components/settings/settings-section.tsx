import type { ReactNode } from 'react'
import type { SettingsCrumb } from './settings-nav'

/**
 * The settings section — the shape every section of the settings shell takes
 * (`docs/design-contract.md` §3, "A settings section"). It was a local helper
 * inside `routes/_app/settings.tsx` until SPA-26; it is a primitive now
 * because a section is a child route, and a child route cannot import a
 * sibling's local.
 *
 * Since 2026-09-30 the section *is* the page: the shell draws no title of
 * its own, so this head is the P1 page head and not a second one under it.
 * Top to bottom:
 *
 *   - the **mono eyebrow**, `SETTINGS · <GROUP>` — the group is the one the
 *     section's row names in `SETTINGS_SECTIONS`, so there are three and a
 *     section cannot invent a fourth;
 *   - the **serif title** in `title-serif` (28/32, the page head every
 *     surface uses — the 18px spelling SPA-17 recorded as a gap is gone
 *     with the second head);
 *   - **one sans sentence** under it, graphite, optional — what the section
 *     decides, never instructions and never doctrine;
 *   - an optional **action** right — the one primary of the section;
 *   - a **hairline under** the head, then the rows.
 *
 * Rows are `SettingsRow`: 48px on a rule, label and hint left, the control
 * right. A ledger inside a section (the FX rates table) takes a
 * `field-label` head on `border-y-hairline` instead, with lanes shared by
 * head and rows.
 */
export function SettingsSection({
  title,
  blurb,
  crumb,
  action,
  children,
}: {
  title: string
  /** One sentence, what the section decides. Omit when the title says it. */
  blurb?: ReactNode
  /** The section's group, printed caps in the eyebrow as `SETTINGS · GENERAL`. */
  crumb: SettingsCrumb
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col">
      <div className="flex items-end justify-between gap-6 border-b border-hairline pb-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="mono text-micro leading-3.5 tracking-[0.08em] text-graphite uppercase">
            Settings · {crumb}
          </div>
          <h1 className="title-serif">{title}</h1>
          {blurb ? <p className="text-ui text-graphite">{blurb}</p> : null}
        </div>
        {action ? (
          <div className="flex shrink-0 items-center gap-3">{action}</div>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** One row: label + hint left, the control right. 48px on a rule. */
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
    <div className="flex min-h-12 items-center justify-between gap-6 border-b border-rule py-2">
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
