import { createReactInlineContentSpec } from '@blocknote/react'
import { Boxes, Building2, FileText, Kanban, Layers, User } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { recordPath } from '#/lib/record-path'

/**
 * Entity mention — inline chip carrying {entityId, label, kind}.
 * entityId is authoritative; label is a cached display string.
 * Serialized into derived markdown as [[label|entity:id]] by the exporter.
 */

export const KIND_ICONS: Record<string, LucideIcon | undefined> = {
  company: Building2,
  person: User,
  deal: Kanban,
  space: Layers,
  note: FileText,
  custom: Boxes,
}

/** Index routes, by kind — the backlinks list on a note page uses it. */
export const KIND_ROUTES: Record<string, string> = {
  company: '/companies',
  person: '/people',
  space: '/spaces',
  note: '/notes',
}

export const Mention = createReactInlineContentSpec(
  {
    type: 'mention',
    propSchema: {
      entityId: { default: '' },
      label: { default: '' },
      kind: { default: 'company' },
      /** custom records: the object slug their page lives under */
      objectSlug: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const { entityId, label, kind, objectSlug } = props.inlineContent.props
      const Icon = KIND_ICONS[kind] ?? Building2
      // Plain anchor, not router Link — renders inside BlockNote's tree.
      // One route table for the whole app: a chip whose kind has no record
      // page renders as text rather than guessing a page it might have.
      const href =
        recordPath({ kind, id: entityId, objectSlug: objectSlug || null }) ??
        undefined
      return (
        <a
          href={href}
          data-entity-id={entityId}
          data-entity-kind={kind}
          className="mention-chip"
          contentEditable={false}
        >
          <Icon size={12} strokeWidth={1.75} aria-hidden />
          {label}
        </a>
      )
    },
  },
)
