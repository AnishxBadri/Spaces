import {
  Building,
  Column,
  CubeView,
  Earth,
  Finance,
  Flag,
  Layers,
  Partnership,
  Portfolio,
  Rocket,
  Star,
  UserMultiple,
} from '#/components/icons'
import type { IconComponent } from '#/components/icons'

/**
 * The icons a custom object may wear — a curated dozen, stored by name in
 * `object.icon`. A fixed menu rather than a free string: every entry is
 * known to read at 16px in the sidebar, and a typo can't blank a nav item.
 */
export const OBJECT_ICONS: Record<string, IconComponent> = {
  boxes: CubeView,
  landmark: Finance,
  briefcase: Portfolio,
  handshake: Partnership,
  building: Building,
  users: UserMultiple,
  kanban: Column,
  layers: Layers,
  rocket: Rocket,
  star: Star,
  flag: Flag,
  globe: Earth,
}

export const OBJECT_ICON_NAMES = Object.keys(OBJECT_ICONS)

/** System objects keep their fixed icons; customs fall back to the box. */
export function objectIcon(
  o: { slug?: string | null; icon?: string | null } | null | undefined,
): IconComponent {
  if (o?.slug === 'companies') return Building
  if (o?.slug === 'people') return UserMultiple
  if (o?.slug === 'deals') return Column
  return o?.icon && o.icon in OBJECT_ICONS ? OBJECT_ICONS[o.icon] : CubeView
}
