import { cn } from '#/lib/utils'

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span aria-hidden className="size-3.5 rounded-[3px] bg-primary" />
      <span className="text-[15px] font-semibold tracking-tight text-foreground">
        DealOS
      </span>
    </span>
  )
}
