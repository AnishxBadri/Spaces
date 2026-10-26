import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { Switch } from './switch'
import { cn } from '#/lib/utils'

/**
 * The one `···`. A head's is a boxed 32px trigger at the far right of the
 * head (A1); a row's is a bare 24px one that shows while its `data-row`
 * ancestor is hovered or holds focus (A5). The menu is paper on 1px ink with
 * the dither, 28px rows on a bone highlight.
 * - State is never a control (A7): with no enabled item it renders nothing,
 *   and a menu of one item is that item, as an outline button.
 * - Destructive items go last, under one rule, wherever the caller put them.
 * - An item that `opens` a window or a field runs once the menu has let go of
 *   focus, and focus is not handed back to the trigger.
 * - `copy` swaps its label to `Copied` for 1.2s and keeps the menu open.
 * - A `group` heads the items after it in mono caps (a plugin's name); it is
 *   dropped when nothing follows it.
 */

type ItemBase = {
  label: string
  icon?: ReactNode
  /** Mono micro in the item's end lane: `keeps revisions`. Never a key. */
  hint?: string | undefined
  disabled?: boolean | undefined
  /** What the item does, on hover. */
  title?: string | undefined
}

export type MoreMenuAction = ItemBase & {
  onSelect: () => void
  /** Opens a window or a field: runs after the menu closes. */
  opens?: boolean | undefined
  destructive?: boolean | undefined
}

export type MoreMenuLink = ItemBase & {
  /** Opens in a new tab. */
  href: string
}

export type MoreMenuCopy = ItemBase & {
  /** The text the item copies, read when it is chosen. */
  copy: () => string
}

export type MoreMenuCheck = ItemBase & {
  checked: boolean
  onCheckedChange: (next: boolean) => void
}

export type MoreMenuSub = ItemBase & {
  items: ReadonlyArray<MoreMenuAction | MoreMenuCheck>
}

export type MoreMenuItem =
  MoreMenuAction | MoreMenuLink | MoreMenuCopy | MoreMenuCheck | MoreMenuSub

/** A rule between two groups of items. */
export const MENU_RULE = 'rule'

/** The mono caps head of the items after it: `EXA`. */
export type MoreMenuGroup = { group: string }

export type MoreMenuEntry = MoreMenuItem | MoreMenuGroup | typeof MENU_RULE

const isItem = (e: MoreMenuEntry): e is MoreMenuItem =>
  e !== MENU_RULE && !('group' in e)

const COPIED_MS = 1200

function enabled(item: MoreMenuItem): boolean {
  if (item.disabled === true) return false
  if ('items' in item) return item.items.some(enabled)
  return true
}

function isDestructive(entry: MoreMenuEntry): boolean {
  return isItem(entry) && 'onSelect' in entry && entry.destructive === true
}

const isBreak = (e: MoreMenuEntry | undefined): boolean =>
  e === undefined || e === MENU_RULE || 'group' in e

/**
 * The entries in the order they draw: the rest with their rules (none
 * leading, trailing or doubled), then one rule and the destructive items.
 */
export function menuLayout(
  entries: ReadonlyArray<MoreMenuEntry>,
): Array<MoreMenuEntry> {
  const rest: Array<MoreMenuEntry> = []
  const isGroup = (e: MoreMenuEntry | undefined) =>
    e !== undefined && e !== MENU_RULE && 'group' in e
  for (const e of entries.filter((x) => !isDestructive(x))) {
    // A group that heads nothing goes before whatever follows it.
    if (!isItem(e)) while (isGroup(rest.at(-1))) rest.pop()
    if (e === MENU_RULE && (rest.length === 0 || rest.at(-1) === MENU_RULE)) {
      continue
    }
    rest.push(e)
  }
  while (rest.length > 0 && isBreak(rest.at(-1))) rest.pop()
  const destructive = entries.filter(isDestructive)
  if (destructive.length === 0) return rest
  return rest.length === 0 ? destructive : [...rest, MENU_RULE, ...destructive]
}

function Hint({ hint }: { hint: string | undefined }) {
  return hint === undefined ? null : (
    <span className="ml-auto pl-3 mono text-micro text-graphite">{hint}</span>
  )
}

/** `Copied` for a moment after a copy, then the label again. */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return [
    copied,
    (text) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      })
    },
  ]
}

export function MoreMenu({
  variant,
  items,
  label,
  align = 'end',
  modal,
  className,
}: {
  variant: 'head' | 'row'
  items: ReadonlyArray<MoreMenuEntry>
  /** What the menu is for, as the trigger names it: "More for Flent". */
  label: string
  align?: 'start' | 'end' | undefined
  modal?: boolean | undefined
  className?: string | undefined
}) {
  const afterClose = useRef<(() => void) | null>(null)
  const [copied, copy] = useCopied()
  const live = items.filter(isItem)
  if (!live.some(enabled)) return null

  const row = variant === 'row'
  const reveal = row ? 'row-reveal' : null

  const only = live.length === 1 ? live[0] : undefined
  if (only !== undefined && !('items' in only)) {
    if ('checked' in only) {
      return (
        <Switch
          checked={only.checked}
          onCheckedChange={only.onCheckedChange}
          disabled={only.disabled === true}
          className={cn(reveal, className)}
        >
          {only.label}
        </Switch>
      )
    }
    const look = {
      variant: 'outline' as const,
      size: row ? ('xs' as const) : ('default' as const),
      className: cn(
        reveal,
        'onSelect' in only && only.destructive === true && 'text-destructive',
        className,
      ),
      disabled: only.disabled === true,
      ...(only.title === undefined ? {} : { title: only.title }),
    }
    if ('href' in only) {
      return (
        <Button {...look} asChild>
          <a href={only.href} target="_blank" rel="noopener noreferrer">
            {only.icon}
            {only.label}
          </a>
        </Button>
      )
    }
    return (
      <Button
        {...look}
        type="button"
        onClick={() => ('copy' in only ? copy(only.copy()) : only.onSelect())}
      >
        {only.icon}
        {'copy' in only && copied ? 'Copied' : only.label}
      </Button>
    )
  }

  function renderItem(item: MoreMenuItem, key: string): ReactNode {
    const common = {
      disabled: item.disabled === true,
      ...(item.title === undefined ? {} : { title: item.title }),
    }
    if ('items' in item) {
      return (
        <DropdownMenuSub key={key}>
          <DropdownMenuSubTrigger {...common}>
            {item.icon}
            {item.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44">
            {item.items.map((sub, i) => renderItem(sub, `${key}.${i}`))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )
    }
    if ('checked' in item) {
      return (
        <DropdownMenuCheckboxItem
          key={key}
          {...common}
          checked={item.checked}
          onCheckedChange={item.onCheckedChange}
        >
          {item.label}
          <Hint hint={item.hint} />
        </DropdownMenuCheckboxItem>
      )
    }
    if ('href' in item) {
      return (
        <DropdownMenuItem key={key} {...common} asChild>
          <a href={item.href} target="_blank" rel="noopener noreferrer">
            {item.icon}
            {item.label}
            <Hint hint={item.hint} />
          </a>
        </DropdownMenuItem>
      )
    }
    if ('copy' in item) {
      return (
        <DropdownMenuItem
          key={key}
          {...common}
          onSelect={(e) => {
            e.preventDefault()
            copy(item.copy())
          }}
        >
          {item.icon}
          {copied ? 'Copied' : item.label}
          <Hint hint={item.hint} />
        </DropdownMenuItem>
      )
    }
    return (
      <DropdownMenuItem
        key={key}
        {...common}
        {...(item.destructive === true ? { variant: 'destructive' } : {})}
        onSelect={() => {
          if (item.opens === true) afterClose.current = item.onSelect
          else item.onSelect()
        }}
      >
        {item.icon}
        {item.label}
        <Hint hint={item.hint} />
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenu {...(modal === undefined ? {} : { modal })}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={row ? 'ghost' : 'outline'}
          size={row ? 'icon-xs' : 'icon'}
          aria-label={`More for ${label}`}
          className={cn(
            row &&
              'text-graphite hover:bg-bone-deep hover:text-foreground data-[state=open]:bg-bone-deep data-[state=open]:text-foreground',
            reveal,
            className,
          )}
        >
          <span aria-hidden className="mono text-ui">
            ···
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="min-w-48"
        onCloseAutoFocus={(e) => {
          const run = afterClose.current
          if (run === null) return
          e.preventDefault()
          afterClose.current = null
          run()
        }}
      >
        {menuLayout(items).map((e, i) =>
          e === MENU_RULE ? (
            <DropdownMenuSeparator key={`rule.${i}`} />
          ) : 'group' in e ? (
            <DropdownMenuLabel
              key={`group.${i}`}
              data-menu-group
              className="mono text-micro font-normal tracking-[0.08em] text-graphite uppercase"
            >
              {e.group}
            </DropdownMenuLabel>
          ) : (
            renderItem(e, `${i}.${e.label}`)
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
