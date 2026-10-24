import type { BadgeColor } from '@spaces/db/schema/attributes'

/**
 * The badge colour vocabulary for select / multi_select / status options.
 *
 * The twelve names are code; which option wears which is the user's. A fixed
 * menu, not a free colour field that lets someone pick 4%-contrast grey on white.
 *
 * Values are the `--badge-<name>` / `--badge-<name>-ink` custom properties;
 * this module only ever names them. Badges resolve through CSS variables rather than
 * Tailwind classes because the colour comes from data — Tailwind extracts class
 * names statically and would never emit `bg-badge-${name}`.
 */

export const BADGE_COLORS = [
  'slate',
  'blue',
  'indigo',
  'violet',
  'fuchsia',
  'rose',
  'orange',
  'amber',
  'lime',
  'emerald',
  'teal',
  'cyan',
] as const satisfies ReadonlyArray<BadgeColor>

/**
 * The union itself is declared at `attribute.options` — a stored option's
 * colour is column data, so the column owns its type. This list is
 * the picker's order *and*, through the attribute server fns'
 * `z.enum(BADGE_COLORS)`, the write vocabulary; the `satisfies` above is
 * the tie between the two, so a name added here that the column's union does
 * not know fails the build rather than becoming an unreadable stored value.
 */
export type { BadgeColor }

export function isBadgeColor(v: unknown): v is BadgeColor {
  return typeof v === 'string' && BADGE_COLORS.some((c) => c === v)
}

/**
 * The colour an option displays. An explicit choice always wins; otherwise the
 * hue follows the option's position, so an option stored without a colour
 * still renders coloured, and adjacent options land on adjacent hues.
 *
 * Position, deliberately, not the status group: seeding by group would paint
 * every active stage the same blue, erasing what a funnel column should carry.
 */
export function optionColor(
  option: { color?: string } | undefined,
  index: number,
): BadgeColor {
  if (isBadgeColor(option?.color)) return option.color
  return BADGE_COLORS[index % BADGE_COLORS.length]
}

/**
 * Group meanings, used only when *creating* an option — a new terminal stage
 * starting at slate rather than a bright hue is the better guess. Never a
 * render-time fallback; see `optionColor`.
 */
const GROUP_SEED: Partial<Record<string, BadgeColor>> = {
  active: 'blue',
  parked: 'amber',
  closed: 'slate',
}

/**
 * The colour a newly created option should be stored with.
 * - Never one a sibling already wears while the palette has a free hue.
 * - The group seed first, then the palette from `index` onward.
 * - All twelve taken: falls back to the seed, else the positional hue.
 */
export function nextBadgeColor(
  index: number,
  group?: string,
  taken: ReadonlyArray<string> = [],
): BadgeColor {
  const seeded = group ? GROUP_SEED[group] : undefined
  const positional = BADGE_COLORS[index % BADGE_COLORS.length]
  const order = [
    ...(seeded ? [seeded] : []),
    ...BADGE_COLORS.map(
      (_, k) => BADGE_COLORS[(index + k) % BADGE_COLORS.length],
    ),
  ]
  return order.find((c) => !taken.includes(c)) ?? seeded ?? positional
}

/** Inline style for a badge in the given colour. */
export function badgeStyle(color: BadgeColor) {
  return {
    backgroundColor: `var(--badge-${color})`,
    color: `var(--badge-${color}-ink)`,
  }
}
