import { NAV_ITEMS } from './app-sidebar'
import { Button } from './ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

/**
 * The keyboard sheet. Two columns of 26px rows on rules:
 * Go, Create, On a deal, In a window. Every key printed here is also in the
 * tooltip of the control it triggers; nothing is listed that does not work.
 */
export function KeyboardHelp({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
  const mod = isMac ? '⌘' : 'Ctrl'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="l" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
        </DialogHeader>
        <div className="flex gap-8 max-sm:flex-col">
          <div className="flex min-w-0 flex-1 flex-col">
            <Group label="Go">
              {NAV_ITEMS.map((item) => (
                <Row key={item.to} label={item.label} keys={item.key} />
              ))}
              <Row label="Settings" keys="G ," />
              <Row label="Leave settings" keys="esc" />
              <Row label="Palette" keys={`${mod}K`} />
              <Row label="Ask" keys={`${mod}J`} />
              <Row label="Fold the sidebar" keys={`${mod}\\`} />
              <Row label="This sheet" keys="?" />
            </Group>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <Group label="Create">
              <Row label="New task · Today, Tasks" keys="T" />
              <Row label="Due · Fri, in 2w, next month" keys="↵" />
              <Row label="New note · Notes, a space" keys="N" />
              <Row label="New space · Spaces" keys="S" />
              <Row label="New attribute · object settings" keys="A" />
            </Group>
            <Group label="On a deal" top>
              <Row label="Log interaction" keys="L" />
              <Row label="Move stage" keys="M" />
              <Row label="New task" keys="T" />
            </Group>
            <Group label="In a window" top>
              <Row label="Submit" keys={`${mod}↵`} />
              <Row label="Add and keep it open" keys="⇧↵" />
              <Row label="Close · revert a cell" keys="esc" />
            </Group>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Group({
  label,
  top,
  children,
}: {
  label: string
  top?: boolean
  children: React.ReactNode
}) {
  return (
    <section className={top ? 'pt-3.5' : undefined}>
      <h3 className="pb-1.5 label-caps text-graphite">{label}</h3>
      {children}
    </section>
  )
}

function Row({ label, keys }: { label: string; keys: string }) {
  return (
    <div className="flex h-[1.625rem] items-center justify-between gap-4 border-t border-rule">
      <span className="min-w-0 truncate text-ui">{label}</span>
      <span className="flex shrink-0 gap-1">
        {keys.split(' ').map((k, i) => (
          <Key key={i}>{k}</Key>
        ))}
      </span>
    </div>
  )
}

/** A keycap: 18px, hairline on three sides and 2px under, mono 10. */
function Key({ children }: { children: string }) {
  return (
    <kbd className="flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-md border border-b-2 border-hairline px-1 mono text-field text-foreground">
      {children}
    </kbd>
  )
}
