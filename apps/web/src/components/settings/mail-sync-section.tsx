import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import { SettingsGroupHead, SettingsRow } from './settings-section'
import { Input } from '#/components/ui/input'
import { Switch } from '#/components/ui/switch'
import { useConfirm } from '#/components/ui/confirm-dialog'
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

/**
 * A synced mailbox on its account page: whether its bodies are shared,
 * and what is never synced. Its owner's alone.
 * - The switch writes at once; sharing asks first, since every body already
 *   synced is shown too. Subject, people and date are visible either way.
 * - The two lists are drafts in the page's Save bar. A save that adds to
 *   them asks first, because mail already synced that they name is removed.
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
      senders: view.excludeSenders.join(', '),
      labels: view.excludeLabels.join(', '),
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
        senders: result.view.excludeSenders.join(', '),
        labels: result.view.excludeLabels.join(', '),
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
    <div className="flex flex-col">
      <SettingsGroupHead title="Mail sync" />
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
        <Input
          aria-label="Senders never synced"
          autoComplete="off"
          spellCheck={false}
          value={draft.senders}
          onChange={(e) => set('senders', e.target.value)}
          className="min-w-0 flex-1 mono"
        />
      </SettingsRow>
      <SettingsRow label="Never sync labels">
        <Input
          aria-label="Labels never synced"
          autoComplete="off"
          spellCheck={false}
          value={draft.labels}
          onChange={(e) => set('labels', e.target.value)}
          className="min-w-0 flex-1 mono"
        />
      </SettingsRow>
      {confirmDialog}
    </div>
  )
}
