import type { AttributeType } from '@spaces/core/attributes/registry'
import {
  Calendar,
  CheckboxChecked,
  Column,
  Currency,
  Earth,
  Email,
  Hashtag,
  KIND_ICONS,
  Link,
  List,
  Phone,
  Star,
  TagGroup,
  TextFont,
  User,
} from '#/components/icons'
import type { IconComponent } from '#/components/icons'
import type { RegistryEntry } from './value-editor'

/**
 * Each attribute type's glyph, which leads its rail label. Chosen by type,
 * so a custom attribute gets one with no setup.
 */
const ATTRIBUTE_TYPE_ICONS: Readonly<Record<AttributeType, IconComponent>> = {
  text: TextFont,
  number: Hashtag,
  currency: Currency,
  date: Calendar,
  checkbox: CheckboxChecked,
  select: List,
  multi_select: TagGroup,
  status: Column,
  rating: Star,
  url: Link,
  email: Email,
  phone: Phone,
  domain: Earth,
  record_reference: Link,
  actor_reference: User,
}

function isAttributeType(type: string): type is AttributeType {
  return Object.hasOwn(ATTRIBUTE_TYPE_ICONS, type)
}

/**
 * The glyph a rail label leads with. A relationship draws its target kind's
 * noun (a company's building, a person), falling back to the link.
 */
export function attributeIcon(def: RegistryEntry): IconComponent {
  if (def.type === 'record_reference') {
    const target = def.options?.targetKind
    const kind = typeof target === 'string' ? KIND_ICONS[target] : undefined
    if (kind) return kind
  }
  return isAttributeType(def.type) ? ATTRIBUTE_TYPE_ICONS[def.type] : TextFont
}
