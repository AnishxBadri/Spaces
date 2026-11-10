import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AttributeOptions } from '@spaces/core/attributes/registry'
import { useRejectedWrite } from '#/components/attributes/rail-field'
import { isEmptyValue } from '#/lib/records/property-fold'
import { isLongText } from '#/lib/records/rail-defs'
import { cn } from '#/lib/utils'
import { rejectPaneClass } from './record-parts'

/** What a paragraph reads of an attribute definition. */
type LongTextDef = {
  slug: string
  name: string
  type: string
  options: AttributeOptions | null
}

/**
 * The long text slugs the rail's empty fold has sent to Overview this mount,
 * and the pick that sends one: it opens the paragraph's editor and shows the
 * Overview tab (`onShow`).
 */
export function useLongTextPick(onShow: () => void) {
  const [opened, setOpened] = useState<ReadonlyArray<string>>([])
  return {
    opened,
    pick: (def: { slug: string }) => {
      setOpened((now) => (now.includes(def.slug) ? now : [...now, def.slug]))
      onShow()
    },
  }
}

/**
 * A record's long text attributes, at the head of its Overview in registry
 * order: each its label, then the text at the body step, clamped to three
 * lines with More. An empty one shows only once the rail's fold opens it.
 */
export function LongTextParagraphs<TDef extends LongTextDef>({
  defs,
  valueOf,
  opened,
  onSave,
}: {
  defs: ReadonlyArray<TDef>
  valueOf: (def: TDef) => unknown
  opened: ReadonlyArray<string>
  onSave: (slug: string, value: string | null) => Promise<void>
}) {
  const shown = defs.filter(
    (d) =>
      isLongText(d) && (!isEmptyValue(valueOf(d)) || opened.includes(d.slug)),
  )
  if (shown.length === 0) return null
  return (
    <div
      data-overview-long
      className="flex flex-col gap-4 border-b border-rule px-(--inset) py-4"
    >
      {shown.map((def) => {
        const value = valueOf(def)
        return (
          <LongTextParagraph
            key={def.slug}
            def={def}
            text={typeof value === 'string' ? value : ''}
            open={opened.includes(def.slug)}
            onSave={(v) => onSave(def.slug, v)}
          />
        )
      })}
    </div>
  )
}

/**
 * One paragraph. Clicking the text opens a textarea in its place at full
 * width: blur commits, Esc reverts, and there is no Save. A refused write
 * holds the paragraph crimson as a rail cell does and keeps the stored text.
 */
export function LongTextParagraph({
  def,
  text,
  open,
  onSave,
}: {
  def: { slug: string; name: string }
  text: string
  /** Picked from the rail's fold: an empty one opens straight to its editor. */
  open: boolean
  onSave: (value: string | null) => Promise<void>
}) {
  const { error, reject, save } = useRejectedWrite(def.slug, (v) =>
    onSave(typeof v === 'string' ? v : null),
  )
  const [editing, setEditing] = useState(open && text === '')
  // What was just written, shown until the reload brings it back.
  const [written, setWritten] = useState<string | null>(null)
  useEffect(() => setWritten(null), [text])
  const shown = written ?? text

  function done(next: string | null) {
    setEditing(false)
    if (next === null || next.trim() === shown.trim()) return
    const value = next.trim() === '' ? null : next.trim()
    setWritten(value ?? '')
    void save(value).then((landed) => {
      if (!landed) setWritten(null)
    })
  }

  return (
    <section
      aria-label={def.name}
      data-long-text={def.slug}
      className="relative flex flex-col gap-1.5"
    >
      {reject === 'rest' ? null : (
        <span aria-hidden className={rejectPaneClass(reject)} />
      )}
      <span className="text-label text-graphite">{def.name}</span>
      {editing ? (
        <LongTextEditor label={def.name} initial={shown} onDone={done} />
      ) : (
        <ClampedText
          text={shown}
          label={def.name}
          onEdit={() => setEditing(true)}
        />
      )}
      {error ? (
        <p role="alert" className="text-label text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}

/** The text at rest, three lines and `More`; the text itself is the edit. */
function ClampedText({
  text,
  label,
  onEdit,
}: {
  text: string
  label: string
  onEdit: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const para = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const el = para.current
    if (el === null || expanded) return
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [text, expanded])

  return (
    <>
      <button
        type="button"
        onClick={onEdit}
        title={`Edit ${label}`}
        className="focus-ring block w-full max-w-170 text-left text-body text-foreground"
      >
        {text === '' ? (
          <span className="text-graphite">—</span>
        ) : (
          <span
            ref={para}
            data-long-text-body
            className={cn(
              'block break-words whitespace-pre-wrap',
              !expanded && 'line-clamp-3',
            )}
          >
            {text}
          </span>
        )}
      </button>
      {clamped || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded((now) => !now)}
          className="focus-ring self-start text-label text-graphite underline underline-offset-3 transition-colors duration-150 ease-out-quart hover:text-foreground"
        >
          {expanded ? 'Less' : 'More'}
        </button>
      ) : null}
    </>
  )
}

/**
 * The paragraph's editor: a textarea that grows with its text, drawn so its
 * text lands where the paragraph's was. `onDone` gets the draft on blur and
 * null on Esc.
 */
function LongTextEditor({
  label,
  initial,
  onDone,
}: {
  label: string
  initial: string
  onDone: (next: string | null) => void
}) {
  const [draft, setDraft] = useState(initial)
  const reverting = useRef(false)
  const area = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = area.current
    if (el === null) return
    el.style.height = 'auto'
    // scrollHeight leaves out the 1px border top and bottom.
    el.style.height = `${String(el.scrollHeight + 2)}px`
  }, [draft])

  // Focus once, with the caret at the end of what is there.
  useEffect(() => {
    const el = area.current
    if (el === null) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  return (
    // The negative margin is the textarea's border and padding.
    <div className="-mx-2.75 -my-2.25">
      <textarea
        ref={area}
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onDone(reverting.current ? null : draft)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          reverting.current = true
          e.currentTarget.blur()
        }}
        className="focus-ring block min-h-20 w-full resize-none overflow-hidden rounded-md border border-hairline bg-paper px-2.5 py-2 text-body"
      />
    </div>
  )
}
