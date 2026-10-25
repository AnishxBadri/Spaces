import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'

/**
 * A member's password reset link, shown once — only its hash is stored, so
 * closing the window loses it and the next Send mints a new one.
 */
export function ResetLinkDialog({
  link,
  onClose,
}: {
  link: { name: string; url: string } | null
  onClose: () => void
}) {
  function copy(url: string) {
    navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied'),
      () => toast.error('Could not copy — select the link'),
    )
  }

  return (
    <Dialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Reset link for {link?.name}</DialogTitle>
        </DialogHeader>
        {link ? (
          <div className="flex flex-col">
            <div className="flex h-9 items-center gap-2 border border-rule bg-bone px-3">
              <code className="min-w-0 flex-1 truncate mono text-micro select-all">
                {link.url}
              </code>
              <Button
                size="xs"
                variant="outline"
                onClick={() => copy(link.url)}
              >
                <Copy className="size-3" strokeWidth={2} />
                Copy link
              </Button>
            </div>
            <DialogFooter note="One use · 24 hours">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Done
                </Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
