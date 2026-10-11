/**
 * What's set up (D80): the seven pieces a workspace can bring, each with the
 * one line it unlocks and where it is set up. Client-safe — the state comes
 * from `whatsSetUpProgram`.
 */

export const SETUP_ITEM_IDS = [
  'model',
  'team',
  'enrichment',
  'forwarding',
  'google',
  'granola',
  'exa',
] as const

export type SetupItemId = (typeof SETUP_ITEM_IDS)[number]

/** Whether each piece is set up, as the server read it. */
export type SetupState = { readonly [K in SetupItemId]: boolean }

/** The settings pages a setup link may open. */
export type SetupPath =
  | '/settings/models'
  | '/settings/members'
  | '/settings/plugins'
  | '/settings/enrichment'
  | '/settings/email-forwarding'
  | '/settings/email-calendar'
  | '/settings/meeting-notes'

export type SetupItem = {
  readonly id: SetupItemId
  readonly label: string
  readonly unlocks: string
  readonly to: SetupPath
}

export const SETUP_ITEMS: ReadonlyArray<SetupItem> = [
  {
    id: 'model',
    label: 'AI model',
    unlocks: 'Deck reading, Ask, Prep and meaning search',
    to: '/settings/models',
  },
  {
    id: 'team',
    label: 'Team',
    unlocks: 'Partners work the same records',
    to: '/settings/members',
  },
  {
    id: 'enrichment',
    label: 'Enrichment',
    unlocks: 'Sources beyond the company website',
    to: '/settings/enrichment',
  },
  {
    id: 'forwarding',
    label: 'Email forwarding',
    unlocks: 'Forwarded mail lands on its records',
    to: '/settings/email-forwarding',
  },
  {
    id: 'google',
    label: 'Google',
    unlocks: 'Mail, calendar and Drive on the records',
    to: '/settings/email-calendar',
  },
  {
    id: 'granola',
    label: 'Granola',
    unlocks: 'Meeting notes arrive on their records',
    to: '/settings/meeting-notes',
  },
  {
    id: 'exa',
    label: 'Exa',
    unlocks: 'Find companies and watch a space',
    to: '/settings/plugins',
  },
]

/** Who a member asks: `Anish`, `Anish or Priya`, `an admin` for none. */
export function adminNames(admins: ReadonlyArray<string>): string {
  const last = admins.at(-1)
  if (last === undefined) return 'an admin'
  return admins.length === 1
    ? last
    : `${admins.slice(0, -1).join(', ')} or ${last}`
}
