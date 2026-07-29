import { useNavigate } from '@tanstack/react-router'
import { LogOut } from 'lucide-react'
import { useEffect } from 'react'
import { NAV_ITEMS } from './app-sidebar'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command'
import { Settings } from 'lucide-react'
import { authClient } from '#/lib/auth-client'

/**
 * Cmd-K — navigation only for now. Search, create, and jump-to-record
 * arrive with their backends; the surface and the shortcut are pinned
 * from day one because keyboard is the primary input.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  function go(to: string) {
    onOpenChange(false)
    navigate({ to })
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Navigate and act from the keyboard"
    >
      <CommandInput placeholder="Where to?" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Go to">
          {NAV_ITEMS.map((item) => (
            <CommandItem key={item.to} onSelect={() => go(item.to)}>
              <item.icon className="size-4" strokeWidth={1.75} />
              {item.label}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => go('/settings')}>
            <Settings className="size-4" strokeWidth={1.75} />
            Settings
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Session">
          <CommandItem
            onSelect={async () => {
              onOpenChange(false)
              await authClient.signOut()
              navigate({ to: '/login' })
            }}
          >
            <LogOut className="size-4" strokeWidth={1.75} />
            Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
