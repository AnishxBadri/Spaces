import { useState } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { selectClasses } from '#/components/ui/select'
import type { SpaceOption } from './feed-words'

/**
 * The feed window's Spaces: the chosen spaces as chips by their path, each
 * with its `×`, then `Add a space…`, which opens the picker's paper sheet
 * over the spaces not yet chosen. The sheet always searches: a space tree is
 * hunted by name.
 */
export function SpacesField({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string
  options: ReadonlyArray<SpaceOption>
  value: ReadonlyArray<string>
  onChange: (ids: Array<string>) => void
  disabled?: boolean | undefined
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const c = selectClasses({ width: 'content' })
  const pathOf = new Map(options.map((o) => [o.id, o.path]))
  const rest = options.filter((o) => !value.includes(o.id))

  return (
    <div
      data-spaces-field
      className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border border-rule px-1 py-0.75"
    >
      {value.map((spaceId) => {
        const path = pathOf.get(spaceId) ?? 'A space'
        return (
          <span
            key={spaceId}
            className="flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-hairline px-2 text-ui"
          >
            <span className="truncate">{path}</span>
            <button
              type="button"
              aria-label={`Remove ${path}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((v) => v !== spaceId))}
              className="focus-ring rounded-md text-label text-graphite hover:text-foreground"
            >
              ×
            </button>
          </span>
        )
      })}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery('')
        }}
      >
        <PopoverTrigger
          id={id}
          type="button"
          disabled={disabled === true || rest.length === 0}
          className="focus-ring h-6 min-w-0 flex-1 rounded-md px-1 text-left text-ui text-graphite hover:text-foreground disabled:hover:text-graphite"
        >
          {rest.length === 0 && value.length === 0
            ? 'No spaces yet'
            : 'Add a space…'}
        </PopoverTrigger>
        <PopoverContent
          asChild
          align="start"
          sideOffset={4}
          className={c.sheet}
        >
          <CommandPrimitive label="Spaces" loop>
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule px-2.5">
              <span aria-hidden className="mono text-micro text-primary">
                ›
              </span>
              <CommandPrimitive.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search spaces…"
                aria-label="Search spaces"
                className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-graphite"
              />
            </div>
            <CommandPrimitive.List className="min-h-0 flex-1 scroll-py-1 overflow-x-hidden overflow-y-auto p-1">
              <CommandPrimitive.Empty className="px-2.5 py-4 text-label text-graphite">
                No space matches.
              </CommandPrimitive.Empty>
              {rest.map((o) => (
                <CommandPrimitive.Item
                  key={o.id}
                  value={o.id}
                  keywords={[o.path]}
                  onSelect={() => {
                    onChange([...value, o.id])
                    setOpen(false)
                    setQuery('')
                  }}
                  className={c.item}
                >
                  <span className="min-w-0 flex-1 truncate">{o.path}</span>
                </CommandPrimitive.Item>
              ))}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </PopoverContent>
      </Popover>
    </div>
  )
}
