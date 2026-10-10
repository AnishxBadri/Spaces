import { useEffect, useId, useRef, useState } from 'react'
import type { InputHTMLAttributes, KeyboardEvent } from 'react'
import { callingCodesFor, withCallingCode } from '@spaces/core/attributes/phone'
import type { CallingCode } from '@spaces/core/attributes/phone'
import { selectClasses } from '#/components/ui/select'

/**
 * The phone editor's country picker: the ITU codes offered while the field
 * has no code yet, narrowed by what is typed. Picking one writes `+code ` in
 * front of the draft; the stored value is still E.164.
 * - ↑↓ walk the list and ↵ picks only once a row is highlighted, so ↵ on a
 *   typed number still saves it.
 * - Rows take the mouse without taking focus from the input.
 */
export function useCallingCodes({
  draft,
  active,
  onPick,
}: {
  draft: string
  /** The field is a phone and has focus. */
  active: boolean
  onPick: (next: string) => void
}) {
  const id = useId()
  const codes = active ? callingCodesFor(draft) : []
  const [highlight, setHighlight] = useState(-1)
  // A new list starts unhighlighted.
  useEffect(() => setHighlight(-1), [draft, active])

  const pick = (c: CallingCode) => onPick(withCallingCode(draft, c.code))

  /** True when the key was the list's; the caller then does nothing else. */
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): boolean {
    if (codes.length === 0) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((h) => (h + step + codes.length) % codes.length)
      return true
    }
    const chosen = highlight >= 0 ? codes.at(highlight) : undefined
    if (e.key === 'Enter' && chosen !== undefined) {
      e.preventDefault()
      pick(chosen)
      return true
    }
    return false
  }

  /** The combobox attributes the input carries. */
  const inputProps: InputHTMLAttributes<HTMLInputElement> = {
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': codes.length > 0,
    'aria-controls': id,
    ...(highlight >= 0
      ? { 'aria-activedescendant': optionId(id, highlight) }
      : {}),
  }
  return {
    open: codes.length > 0,
    onKeyDown,
    inputProps,
    list: (
      <CallingCodeList
        id={id}
        codes={codes}
        highlight={highlight}
        onPick={pick}
      />
    ),
  }
}

const optionId = (list: string, i: number) => `${list}-${i}`

function CallingCodeList({
  id,
  codes,
  highlight,
  onPick,
}: {
  id: string
  codes: ReadonlyArray<CallingCode>
  highlight: number
  onPick: (c: CallingCode) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (highlight < 0) return
    list.current
      ?.querySelector(`[id="${optionId(id, highlight)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [id, highlight])
  const item = selectClasses({ width: 'content' }).item
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label="Country code"
      className="max-h-60 overflow-y-auto p-1"
    >
      {codes.map((c, i) => (
        <div
          key={`${c.code} ${c.country}`}
          id={optionId(id, i)}
          role="option"
          aria-selected={i === highlight}
          data-selected={i === highlight}
          className={item}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
        >
          <span className="w-12 shrink-0 mono text-label text-graphite">
            +{c.code}
          </span>
          <span className="min-w-0 flex-1 truncate">{c.country}</span>
        </div>
      ))}
    </div>
  )
}
