import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import { SettingsGroup, SettingsRow } from './settings-section'
import { icon } from '#/components/icons'
import { Input } from '#/components/ui/input'
import { Switch } from '#/components/ui/switch'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { cn } from '#/lib/utils'
import type { MailboxSyncView } from '#/lib/server-fns'
import { saveMailboxSync } from '#/lib/server-fns'

/** A comma- or newline-separated list as typed → its entries. */
export function listOf(text: string): Array<string> {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Entries in `next` that `stored` did not hold, compared as typed. */
export function addedEntries(
  stored: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): Array<string> {
  const held = new Set(stored.map((s) => s.toLowerCase()))
  return next.filter((s) => !held.has(s.toLowerCase()))
}

/** A list as the draft holds it: one entry per line. */
const draftOf = (entries: ReadonlyArray<string>): string => entries.join('\n')

/**
 * A list as removable chips and a dashed `+ Add` that opens a field. ↵ adds
 * what is typed (several at once, comma-separated) and keeps the field open;
 * leaving it adds too, and Esc drops it. An entry already held, case aside,
 * is not added twice. The server checks each entry on save.
 */
function ChipList({
  entries,
  label,
  noun,
  mono,
  placeholder,
  onChange,
}: {
  entries: ReadonlyArray<string>
  /** The list's accessible name. */
  label: string
  /** What one entry is, in the controls' names: `sender`, `label`. */
  noun: string
  /** Senders read in mono, labels in sans. */
  mono: boolean
  placeholder: string
  onChange: (next: Array<string>) => void
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const addButton = useRef<HTMLButtonElement>(null)
  // Esc unmounts the field; the blur that may follow must not add.
  const dropped = useRef(false)
  const refocus = useRef(false)

  useEffect(() => {
    if (adding || !refocus.current) return
    refocus.current = false
    addButton.current?.focus()
  }, [adding])

  const commit = () => {
    const next = [...entries]
    for (const entry of listOf(text))
      if (addedEntries(next, [entry]).length > 0) next.push(entry)
    if (next.length > entries.length) onChange(next)
    setText('')
  }
  /** Closes from the keyboard: focus goes back to `+ Add`. */
  const close = () => {
    refocus.current = true
    setText('')
    setAdding(false)
  }

  return (
    <ul aria-label={label} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
      {entries.map((entry) => (
        <li
          key={entry}
          data-chip={entry}
          className={cn(
            'flex h-7 items-center gap-1 rounded-md border border-rule bg-bone pr-1 pl-2',
            mono ? 'mono text-micro' : 'text-label',
          )}
        >
          {entry}
          <button
            type="button"
            aria-label={`Remove ${entry}`}
            onClick={() => onChange(entries.filter((e) => e !== entry))}
            className="focus-ring rounded-md text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground"
          >
            <icon.close className="size-4" />
          </button>
        </li>
      ))}
      <li className="flex">
        {adding ? (
          <Input
            autoFocus
            aria-label={`Add a ${noun} never synced`}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (text.trim() === '') close()
                else commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                dropped.current = true
                close()
              }
            }}
            onBlur={() => {
              if (!dropped.current) commit()
              dropped.current = false
              // Leaving by a click or Tab keeps focus where it went.
              setAdding(false)
            }}
            className={cn('h-7 w-56', mono && 'mono')}
          />
        ) : (
          <button
            ref={addButton}
            type="button"
            aria-label={`Add a ${noun}`}
            onClick={() => {
              dropped.current = false
              setAdding(true)
            }}
            className="focus-ring flex h-7 items-center gap-1.5 rounded-md border border-dashed border-rule px-2 text-label text-graphite transition-colors duration-150 ease-out-quart hover:border-hairline hover:text-foreground"
          >
            <icon.new className="size-4" />
            Add
          </button>
        )}
      </li>
    </ul>
  )
}

/**
 * A synced mailbox on its account page: whether its bodies are shared,
 * and what is never synced. Its owner's alone.
 * - The switch writes at once; sharing asks first, since every body already
 *   synced is shown too. Subject, people and date are visible either way.
 * - The two lists are chips, drafts in the page's Save bar. A save that adds
 *   to them asks first, because mail already synced that they name is removed.
 */
export function MailSyncSettings({
  connectionId,
  view,
}: {
  connectionId: string
  view: MailboxSyncView
}) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [sharing, setSharing] = useState(false)

  const save = (next: MailboxSyncView) =>
    saveMailboxSync({ data: { connectionId, ...next } })

  const { draft, set } = useSettingsDraft(
    {
      senders: draftOf(view.excludeSenders),
      labels: draftOf(view.excludeLabels),
    },
    async (next) => {
      const excludeSenders = listOf(next.senders)
      const excludeLabels = listOf(next.labels)
      const added = [
        ...addedEntries(view.excludeSenders, excludeSenders),
        ...addedEntries(view.excludeLabels, excludeLabels),
      ]
      if (added.length > 0) {
        const ok = await confirm({
          title: `Stop syncing ${added.join(', ')}?`,
          body: 'Emails already synced that match are removed from Spaces. Files that came with them stay.',
          action: 'Save',
        })
        if (!ok) throw new Error('Nothing saved')
      }
      const result = await save({
        shareBodies: view.shareBodies,
        excludeSenders,
        excludeLabels,
      })
      toast(
        result.removed > 0
          ? `Saved · ${result.removed} synced ${result.removed === 1 ? 'email' : 'emails'} removed`
          : 'Saved',
      )
      void router.invalidate()
      return {
        senders: draftOf(result.view.excludeSenders),
        labels: draftOf(result.view.excludeLabels),
      }
    },
  )

  async function share(next: boolean) {
    if (next) {
      const ok = await confirm({
        title: 'Show this mailbox’s email bodies to the workspace?',
        body: 'Every member can read the bodies already synced and those to come. Subject, people and date are visible either way.',
        action: 'Share',
      })
      if (!ok) return
    }
    setSharing(true)
    try {
      await save({
        shareBodies: next,
        excludeSenders: view.excludeSenders,
        excludeLabels: view.excludeLabels,
      })
      toast(next ? 'Bodies shared with the workspace' : 'Bodies private to you')
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSharing(false)
    }
  }

  return (
    <SettingsGroup title="Mail sync">
      <SettingsRow
        label="Email bodies"
        hint="Subject, people and date are visible to the workspace."
      >
        <Switch
          checked={view.shareBodies}
          disabled={sharing}
          onCheckedChange={(next) => void share(next)}
        >
          Share with the workspace
        </Switch>
      </SettingsRow>
      <SettingsRow
        label="Never sync from"
        hint="Domains, addresses, or a part like noreply@."
      >
        <ChipList
          entries={listOf(draft.senders)}
          label="Senders never synced"
          noun="sender"
          mono
          placeholder="acme.example"
          onChange={(next) => set('senders', draftOf(next))}
        />
      </SettingsRow>
      <SettingsRow label="Never sync labels">
        <ChipList
          entries={listOf(draft.labels)}
          label="Labels never synced"
          noun="label"
          mono={false}
          placeholder="Label"
          onChange={(next) => set('labels', draftOf(next))}
        />
      </SettingsRow>
      {confirmDialog}
    </SettingsGroup>
  )
}
