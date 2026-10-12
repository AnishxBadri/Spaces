import { Link2, MessageSquareText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { openAsk } from '#/lib/ask/dock-store'

/**
 * A record head's boxed `···`: Ask about this, which opens Ask docked with
 * the record as its scope chip, and Copy link. (D70, A4)
 */
export function RecordMoreMenu({ name }: { name: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`More for ${name}`}>
          <span aria-hidden className="mono text-ui">
            ···
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => openAsk()}>
          <MessageSquareText className="size-4" />
          Ask about this
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void navigator.clipboard
              .writeText(window.location.href)
              .then(() => toast('Link copied'))
          }}
        >
          <Link2 className="size-4" />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
