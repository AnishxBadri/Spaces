import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Checkmark, icon } from '../icons'
import { KindIcon } from '../kind-icon'
import { getFileUnderOptions } from '#/lib/server-fns'
import type { FileUnderOption } from '#/lib/documents/file-under'
import { setFiled } from '#/lib/documents/file-under-writes'
import { cn } from '#/lib/utils'

/**
 * `File under…`: the one popover wherever a file is filed. A search line,
 * then rows with checkboxes: what the file is filed under is checked, a tick
 * files it and an untick unfiles it at once, and the popover stays open for
 * the next. With nothing typed it offers `Named in the file` and `Recent`;
 * typing groups results under kind bands, the first row highlighted for
 * the return key.
 */

type Options = Awaited<ReturnType<typeof getFileUnderOptions>>

/** A record's or a space's kind icon, as the rail and the popover lead with it. */
export function FilingKindIcon({
  option,
  className,
}: {
  option: Pick<FileUnderOption, 'kind' | 'object'>
  className?: string | undefined
}) {
  return (
    <KindIcon
      of={{
        kind: option.kind,
        objectLabel: option.object?.singular ?? null,
        objectIcon: option.object?.icon ?? null,
      }}
      {...(className === undefined ? {} : { className })}
    />
  )
}

/** `Proptech › Property ops`: a space's parents in graphite, then its name. */
export function FilingName({
  option,
  strong = false,
}: {
  option: Pick<FileUnderOption, 'name' | 'parents'>
  /** The rail sets the name in medium; the popover in regular. */
  strong?: boolean
}) {
  return (
    <span className="min-w-0 flex-1 truncate text-ui">
      {option.parents.length === 0 ? null : (
        <span className="text-graphite">{`${option.parents.join(' › ')} › `}</span>
      )}
      <span className={cn(strong && 'font-medium')}>{option.name}</span>
    </span>
  )
}

/** The rail's last row, dashed: `+ File under…`, which opens the popover. */
export function FileUnderButton({ documentId }: { documentId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-file-under
          className="focus-ring flex h-8 shrink-0 items-center border border-dashed border-hairline text-left text-ui transition-colors duration-100 ease-out-quart hover:bg-paper"
        >
          <span className="flex w-9 shrink-0 items-center justify-center self-stretch">
            <icon.new aria-hidden className="size-4" />
          </span>
          <span className="pl-2.5">File under…</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-85 p-0">
        {open ? <FileUnderPanel documentId={documentId} /> : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The popover's body, also the body of the `File under…` windows. Reads its
 * own ticks, so a caller passes only the file.
 */
export function FileUnderPanel({
  documentId,
  onChange,
}: {
  documentId: string
  /** After each tick has written. */
  onChange?: (filed: boolean) => void
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [options, setOptions] = useState<Options | null>(null)
  const [filed, setFiledIds] = useState<ReadonlyArray<string>>([])
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const typed = q.trim() !== ''

  useEffect(() => {
    let live = true
    const read = () => {
      getFileUnderOptions({ data: { documentId, q } }).then(
        (next) => {
          if (!live) return
          setOptions(next)
          setFiledIds(next.filed)
          setActive(q.trim() === '' ? -1 : 0)
        },
        () => {
          if (live) setOptions({ filed: [], bands: [] })
        },
      )
    }
    // The first read is at once; typing waits for a pause.
    if (q.trim() === '') {
      read()
      return () => {
        live = false
      }
    }
    const t = setTimeout(read, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [documentId, q])

  const rows = (options?.bands ?? []).flatMap((b) => b.options)

  async function toggle(option: FileUnderOption) {
    const id = option.target.entityId
    if (pending.has(id)) return
    const checked = !filed.includes(id)
    setFiledIds((now) => (checked ? [...now, id] : now.filter((x) => x !== id)))
    setPending((now) => new Set(now).add(id))
    try {
      await setFiled(documentId, option.target, checked, filed)
      onChange?.(checked)
      await router.invalidate()
    } catch (err) {
      setFiledIds((now) =>
        checked ? now.filter((x) => x !== id) : [...now, id],
      )
      toast.error(err instanceof Error ? err.message : 'Could not file it')
    } finally {
      setPending((now) => {
        const next = new Set(now)
        next.delete(id)
        return next
      })
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((at) => (at + step + rows.length) % rows.length)
      return
    }
    if (e.key === 'Enter') {
      const row = rows.at(active)
      if (active < 0 || row === undefined) return
      e.preventDefault()
      void toggle(row)
      return
    }
    // Text clears first; an empty line lets the popover close.
    if (e.key === 'Escape' && q !== '') {
      e.preventDefault()
      e.stopPropagation()
      setQ('')
    }
  }

  let at = -1
  return (
    <div data-file-under-panel className="flex min-w-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-hairline">
        <label className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
          <icon.search
            aria-hidden
            className={cn(
              'size-4 shrink-0',
              typed ? 'text-foreground' : 'text-graphite',
            )}
          />
          <input
            ref={input}
            type="search"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="A record or a space"
            aria-label="File under a record or a space"
            className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-graphite"
          />
        </label>
        {q === '' ? null : (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => {
              setQ('')
              input.current?.focus()
            }}
            className="flex w-10 shrink-0 items-center justify-center self-stretch border-l border-rule text-foreground outline-none hover:bg-hairline hover:text-paper focus-visible:bg-hairline focus-visible:text-paper"
          >
            <icon.close aria-hidden className="size-4" />
          </button>
        )}
      </div>
      <div className="max-h-90 overflow-y-auto">
        {options === null ? (
          <p className="flex h-row items-center px-3 text-ui text-graphite">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="flex h-row items-center px-3 text-ui text-graphite">
            {typed ? 'Nothing matches.' : 'Type a record or a space.'}
          </p>
        ) : (
          options.bands.map((band) => (
            <div key={band.label} role="group" aria-label={band.label}>
              <p className="flex h-7 items-center border-b border-rule bg-bone px-3 label-caps text-graphite">
                {band.label}
              </p>
              {band.options.map((option) => {
                at += 1
                const index = at
                const id = option.target.entityId
                const checked = filed.includes(id)
                return (
                  <button
                    key={id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    data-file-under-option={id}
                    disabled={pending.has(id)}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void toggle(option)}
                    className={cn(
                      'flex h-row w-full items-center gap-2.5 border-b border-rule px-3 text-left outline-none',
                      index === active && 'bg-bone',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center border border-hairline',
                        checked ? 'bg-hairline text-paper' : 'bg-paper',
                      )}
                    >
                      {checked ? <Checkmark className="size-3" /> : null}
                    </span>
                    <FilingKindIcon option={option} />
                    <FilingName option={option} />
                    {typed && index === active ? (
                      <span
                        aria-hidden
                        className="flex h-4 shrink-0 items-center rounded-md border border-rule px-0.75 mono text-field text-graphite"
                      >
                        ↵
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
