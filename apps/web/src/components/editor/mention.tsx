import { createReactInlineContentSpec } from '@blocknote/react'
import {
  Boxes,
  Building2,
  FileText,
  Kanban,
  Layers,
  Paperclip,
  User,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { documentPreviewEvent } from '#/lib/editor/document-preview-event'
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
  // A document has no page, so its chip is the only place the paperclip has
  // to say what was mentioned (SPA-27).
  document: Paperclip,
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
      const href = recordPath({
        kind,
        id: entityId,
        objectSlug: objectSlug || null,
      })
      const inside = (
        <>
          <Icon size={12} strokeWidth={1.75} aria-hidden />
          {label}
        </>
      )

      // A document is the one kind with no page *and* somewhere to go: the
      // preview modal. The chip cannot open it from in here (no dialog
      // context under ProseMirror), so it asks the page to — see
      // `lib/editor/document-preview-event.ts`. A button, never an anchor:
      // there is no URL to put in one, and `href={undefined}` renders a
      // focusable element that navigates nowhere.
      if (kind === 'document') {
        return (
          <button
            type="button"
            data-entity-id={entityId}
            data-entity-kind={kind}
            className="mention-chip"
            contentEditable={false}
            onClick={(e) =>
              e.currentTarget.dispatchEvent(
                documentPreviewEvent({ entityId, label }),
              )
            }
          >
            {inside}
          </button>
        )
      }

      // Every other page-less kind reads as text, which is what the rule
      // above always meant — an anchor with no href was the bug.
      if (!href) {
        return (
          <span
            data-entity-id={entityId}
            data-entity-kind={kind}
            className="mention-chip"
            contentEditable={false}
          >
            {inside}
          </span>
        )
      }

      return (
        <a
          href={href}
          data-entity-id={entityId}
          data-entity-kind={kind}
          className="mention-chip"
          contentEditable={false}
        >
          {inside}
        </a>
      )
    },
  },
)
