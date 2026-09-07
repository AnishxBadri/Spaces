import {
  Boxes,
  Briefcase,
  Building2,
  Flag,
  Globe,
  Handshake,
  Kanban,
  Landmark,
  Layers,
  Rocket,
  Star,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * The icons a custom object may wear — a curated dozen, stored by name in
 * `object.icon`. A fixed menu rather than a free string: every entry is
 * known to read at 16px in the sidebar, and a typo can't blank a nav item.
 */
export const OBJECT_ICONS: Record<string, LucideIcon> = {
  boxes: Boxes,
  landmark: Landmark,
  briefcase: Briefcase,
  handshake: Handshake,
  building: Building2,
  users: Users,
  kanban: Kanban,
  layers: Layers,
  rocket: Rocket,
  star: Star,
  flag: Flag,
  globe: Globe,
}

export const OBJECT_ICON_NAMES = Object.keys(OBJECT_ICONS)

/** System objects keep their fixed icons; customs fall back to the box. */
export function objectIcon(
  o: { slug?: string | null; icon?: string | null } | null | undefined,
): LucideIcon {
  if (o?.slug === 'companies') return Building2
  if (o?.slug === 'people') return Users
  if (o?.slug === 'deals') return Kanban
  return o?.icon && o.icon in OBJECT_ICONS ? OBJECT_ICONS[o.icon] : Boxes
}
