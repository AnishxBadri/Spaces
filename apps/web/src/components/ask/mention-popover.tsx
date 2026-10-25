import { useEffect, useRef, useState } from 'react'
import type { ComponentProps, KeyboardEvent } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '#/components/ui/popover'
import { chipOfHit, insertMention, mentionAt } from '#/lib/ask/mention'
import type { MentionAt } from '#/lib/ask/mention'
import type { AskScopeChip } from '#/lib/ask/types'
import { searchAll } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Ask's composer field with `@`: typing it opens a popover over spaces and
 * records, found by Cmd-K's finder, and a pick becomes a scope chip.
 * - ↑ ↓ move, ↵ or Tab picks, Esc closes; the keys are never printed.
 * - The name stays in the text where it was typed, without the `@`.
 */

/** The finder's wait after a keystroke, as Cmd-K's lexical wave. */
const SEARCH_DELAY_MS = 180
const HITS_MAX = 8

const KIND_WORD: Record<string, string> = {
  space: 'space',
  person: 'person',
  company: 'company',
  deal: 'deal',
  custom: 'record',
}

type Field = Omit<
  ComponentProps<'textarea'>,
  'value' | 'onChange' | 'onKeyDown' | 'ref'
>

export function MentionTextarea({
  value,
  onChange,
  onMention,
  onKeyDown,
  fieldRef,
  ...field
}: Field & {
  value: string
  onChange: (v: string) => void
  /** A space or record was chosen after `@`. */
  onMention: (chip: AskScopeChip) => void
  /** Keys the popover did not take. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  fieldRef: { current: HTMLTextAreaElement | null }
}) {
  const [mention, setMention] = useState<MentionAt | null>(null)
  const [hits, setHits] = useState<
    ReadonlyArray<{ chip: AskScopeChip; kind: string }>
  >([])
  const [active, setActive] = useState(0)
  const [searched, setSearched] = useState(false)
  const caret = useRef<number | null>(null)

  const query = mention?.query.trim() ?? ''
  useEffect(() => {
    setActive(0)
    if (query === '') {
      setHits([])
      setSearched(false)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void searchAll({ data: { q: query } }).then(
        (rows) => {
          if (!alive) return
          setHits(
            rows
              .flatMap((h) => {
                const chip = chipOfHit(h)
                return chip === null ? [] : [{ chip, kind: h.kind }]
              })
              .slice(0, HITS_MAX),
          )
          setSearched(true)
        },
        () => {
          if (alive) setHits([])
        },
      )
    }, SEARCH_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  // Put the caret after a picked name once the text has it.
  useEffect(() => {
    const at = caret.current
    if (at === null || fieldRef.current === null) return
    caret.current = null
    fieldRef.current.setSelectionRange(at, at)
  }, [value, fieldRef])

  const read = (el: HTMLTextAreaElement) =>
    setMention(mentionAt(el.value, el.selectionStart))

  const pick = (chip: AskScopeChip) => {
    if (mention === null) return
    const next = insertMention(value, mention, chip.name)
    caret.current = next.caret
    setMention(null)
    onChange(next.text)
    onMention(chip)
  }

  return (
    <Popover
      open={mention !== null}
      onOpenChange={(open) => {
        if (!open) setMention(null)
      }}
    >
      <PopoverAnchor asChild>
        <textarea
          {...field}
          ref={(el) => {
            fieldRef.current = el
          }}
          value={value}
          aria-autocomplete="list"
          aria-expanded={mention !== null}
          onChange={(e) => {
            onChange(e.target.value)
            read(e.target)
          }}
          onSelect={(e) => read(e.currentTarget)}
          onKeyDown={(e) => {
            if (mention !== null) {
              if (e.key === 'Escape') {
                e.preventDefault()
                setMention(null)
                return
              }
              if (hits.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : -1
                  setActive((i) => (i + step + hits.length) % hits.length)
                  return
                }
                if (
                  (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) ||
                  e.key === 'Tab'
                ) {
                  e.preventDefault()
                  const hit = hits.at(active)
                  if (hit !== undefined) pick(hit.chip)
                  return
                }
              }
            }
            onKeyDown(e)
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-72 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {hits.length === 0 ? (
          <p className="px-3 py-2 text-ui text-graphite">
            {query === ''
              ? 'Name a space or a record'
              : searched
                ? 'No space or record by that name'
                : 'Finding…'}
          </p>
        ) : (
          <ul role="listbox" aria-label="Scope to" className="py-1">
            {hits.map((h, i) => (
              <li
                key={`${h.chip.kind}:${h.chip.id ?? ''}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(h.chip)}
                className={cn(
                  'flex h-8 cursor-default items-center gap-3 px-3 text-ui',
                  i === active && 'bg-selected',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{h.chip.name}</span>
                <span className="shrink-0 mono text-micro text-graphite">
                  {KIND_WORD[h.kind] ?? h.kind}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
