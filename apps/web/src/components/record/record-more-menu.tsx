import { Link2, MessageSquareText } from 'lucide-react'
import { MoreMenu } from '#/components/ui/more-menu'
import { openAsk } from '#/lib/ask/dock-store'

/**
 * A record head's boxed `···`: Ask about this, which opens Ask docked with
 * the record as its scope chip, and Copy link.
 */
export function RecordMoreMenu({ name }: { name: string }) {
  return (
    <MoreMenu
      variant="head"
      label={name}
      items={[
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
      ]}
    />
  )
}
