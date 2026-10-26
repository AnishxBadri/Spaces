import { LayoutTemplate, Link2, MessageSquareText } from 'lucide-react'
import { useState } from 'react'
import { useSensitiveItem } from '#/components/sensitive-toggle'
import type { SensitivityState } from '#/components/sensitive-toggle'
import { SaveAsTemplateAction } from '#/components/templates'
import { MENU_RULE, MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuCheck, MoreMenuEntry } from '#/components/ui/more-menu'
import { openAsk } from '#/lib/ask/dock-store'
import { saveRecordAsTemplate } from '#/lib/server-fns'

/** The kinds a record template is captured from. */
export type TemplateKind = 'company' | 'person' | 'deal'

type MenuProps = {
  name: string
  /** The record's id; Save as template and Sensitive write to it. */
  entityId?: string | undefined
  template?: TemplateKind | undefined
  sensitivity?: SensitivityState | undefined
  /** From `usePluginEntries`. */
  plugins?: ReadonlyArray<MoreMenuEntry> | undefined
}

/**
 * A record head's boxed `···`, in this order:
 * - Ask about this, which opens Ask docked with the record as its scope
 *   chip; Copy link; Save as template… where the kind has templates;
 * - a rule and Sensitive, a switch, where the record carries the flag;
 * - the plugins' actions, each group under its plugin's name.
 */
export function RecordMoreMenu(props: MenuProps) {
  const { entityId, sensitivity } = props
  return entityId !== undefined && sensitivity !== undefined ? (
    <SensitiveMenu {...props} entityId={entityId} sensitivity={sensitivity} />
  ) : (
    <Menu {...props} sensitive={null} />
  )
}

function SensitiveMenu(
  props: MenuProps & { entityId: string; sensitivity: SensitivityState },
) {
  const sensitive = useSensitiveItem(props.entityId, props.sensitivity)
  return <Menu {...props} sensitive={sensitive} />
}

function Menu({
  name,
  entityId,
  template,
  plugins = [],
  sensitive,
}: MenuProps & { sensitive: MoreMenuCheck | null }) {
  const [templating, setTemplating] = useState(false)
  const templated =
    template !== undefined && entityId !== undefined
      ? { kind: template, id: entityId }
      : null
  const items: Array<MoreMenuEntry> = [
    {
      label: 'Ask about this',
      icon: <MessageSquareText className="size-4" />,
      onSelect: () => openAsk(),
    },
    {
      label: 'Copy link',
      icon: <Link2 className="size-4" />,
      copy: () => window.location.href,
    },
  ]
  if (templated !== null)
    items.push({
      label: 'Save as template…',
      icon: <LayoutTemplate className="size-4" />,
      onSelect: () => setTemplating(true),
      opens: true,
    })
  if (sensitive !== null) items.push(MENU_RULE, sensitive)
  items.push(...plugins)
  return (
    <>
      <MoreMenu variant="head" label={name} items={items} />
      {templated === null ? null : (
        <SaveAsTemplateAction
          entityLabel={templated.kind}
          open={templating}
          onOpenChange={setTemplating}
          onSave={async (templateName) => {
            await saveRecordAsTemplate({
              data: { recordId: templated.id, name: templateName },
            })
          }}
        />
      )}
    </>
  )
}
