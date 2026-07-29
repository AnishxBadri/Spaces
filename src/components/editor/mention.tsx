import { createReactInlineContentSpec } from '@blocknote/react'
import {
  Building2,
  FileText,
  Layers,
  Target,
  User,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Entity mention — inline chip carrying {entityId, label, kind}.
 * entityId is authoritative; label is a cached display string.
 * Serialized into derived markdown as [[label|entity:id]] by the exporter.
 */

export const KIND_ICONS: Record<string, LucideIcon> = {
  company: Building2,
  person: User,
  organization: Building2,
  space: Layers,
  thesis: Target,
  note: FileText,
}

export const KIND_ROUTES: Record<string, string> = {
  company: '/companies',
  person: '/people',
  organization: '/companies',
  space: '/spaces',
  thesis: '/theses',
  note: '/notes',
}

export const Mention = createReactInlineContentSpec(
  {
    type: 'mention',
    propSchema: {
      entityId: { default: '' },
      label: { default: '' },
      kind: { default: 'company' },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const { entityId, label, kind } = props.inlineContent.props
      const Icon = KIND_ICONS[kind] ?? Building2
      return (
        <span
          data-entity-id={entityId}
          data-entity-kind={kind}
          className="mention-chip"
        >
          <Icon size={12} strokeWidth={1.75} aria-hidden />
          {label}
        </span>
      )
    },
  },
)
