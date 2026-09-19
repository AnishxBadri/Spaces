import type { BadgeColor } from '@spaces/db/schema/attributes'

/**
 * The badge colour vocabulary for select / multi_select / status options.
 *
 * Structure fixed, content free: the twelve names are code, which option wears
 * which is the user's. That is the same doctrine the attribute engine already
 * follows for types-vs-attributes — a fixed menu the user composes from, not a
 * free colour field that lets someone pick 4%-contrast grey on white.
 *
 * Values live in styles.css as `--badge-<name>` / `--badge-<name>-ink`; this
 * module only ever names them. Badges resolve through CSS variables rather than
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
 * colour is column data, so the column owns its type (SPA-142). This list is
 * the picker's order *and*, through `z.enum(BADGE_COLORS)` in
 * `lib/server/attributes.ts`, the write vocabulary; the `satisfies` above is
 * the tie between the two, so a name added here that the column's union does
 * not know fails the build rather than becoming an unreadable stored value.
 */
export type { BadgeColor }

export function isBadgeColor(v: unknown): v is BadgeColor {
  return typeof v === 'string' && BADGE_COLORS.some((c) => c === v)
}

/**
 * The colour an option displays. An explicit choice always wins; otherwise the
 * hue follows the option's position, so a set defined before this palette
 * existed still renders fully coloured — no migration, no flicker, and adjacent
 * options land on adjacent hues, which reads deliberate rather than random.
 *
 * Position, deliberately, not the status group: seeding by group would paint
 * every active stage the same blue, which is what the old group-colour map did
 * and is precisely the information a funnel column should be carrying.
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

/** The colour a newly created option should be stored with. */
export function nextBadgeColor(index: number, group?: string): BadgeColor {
  const seeded = group ? GROUP_SEED[group] : undefined
  return seeded ?? BADGE_COLORS[index % BADGE_COLORS.length]
}

/** Inline style for a badge in the given colour. */
export function badgeStyle(color: BadgeColor) {
  return {
    backgroundColor: `var(--badge-${color})`,
    color: `var(--badge-${color}-ink)`,
  }
}
