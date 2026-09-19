import type { ReactNode } from 'react'
import type { SettingsCrumb } from './settings-nav'

/**
 * The settings section — the shape every section of the settings shell takes
 * (`docs/design-contract.md` §3, "A settings section"). It was a local helper
 * inside `routes/_app/settings.tsx` until SPA-26; it is a primitive now
 * because a section is a child route, and a child route cannot import a
 * sibling's local.
 *
 * The anatomy, top to bottom:
 *
 *   - a **serif title** on the 18px spelling the settings head has always
 *     used (`font-serif text-lg`); there is no named 18 step and SPA-26 did
 *     not add one — SPA-17 records the gap;
 *   - **one sans sentence** under it, graphite — what the section decides,
 *     never instructions;
 *   - the **mono crumb** on the right, `SETTINGS / <GROUP>` in caps: the
 *     group is the one the section's row names in `SETTINGS_SECTIONS`, so
 *     there are three crumbs and a section cannot invent a fourth;
 *   - an optional **action** left of the crumb — the one primary of the
 *     section (`New object`);
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
  blurb: ReactNode
  /** The section's group, printed caps as `SETTINGS / WORKSPACE`. */
  crumb: SettingsCrumb
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col">
      <div className="flex items-end justify-between gap-6 border-b border-hairline pb-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-serif text-lg leading-5.5 font-semibold">
            {title}
          </h2>
          <p className="text-ui text-graphite">{blurb}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {action}
          <span className="label-caps font-normal whitespace-nowrap text-graphite">
            Settings / {crumb}
          </span>
        </div>
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
