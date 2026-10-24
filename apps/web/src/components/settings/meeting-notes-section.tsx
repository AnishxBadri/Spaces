import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsSection,
} from './settings-section'
import { useSettingsDraft } from './settings-form'
import { pluginAnchor } from '#/components/integrations/registry-pane'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import type { MeetingNotesView, RecorderAccountView } from '#/lib/server-fns'
import {
  connectRecorderKey,
  disconnectConnection,
  saveRecorderSettings,
} from '#/lib/server-fns'

/**
 * Settings → You → Meeting notes: the reader's recorders, each a
 * key they pasted for their own account.
 * - A folder tick is the share decision: a ticked folder's notes are shared
 *   with the workspace, and a note outside every ticked folder is never read.
 * - Ticks and opt-ins apply at once with a toast; the key is a typed field in
 *   the page's Save bar, write-only.
 */
export function MeetingNotesSection({ view }: { view: MeetingNotesView }) {
  return (
    <SettingsSection title="Meeting notes" crumb="You">
      <div className="flex flex-col">
        <SettingsGroupHead title="Recorders" count={view.accounts.length} />
        {view.accounts.length === 0 ? (
          <p className="border-b border-rule px-3 py-3 text-label text-graphite">
            No recorders connected.
          </p>
        ) : (
          view.accounts.map((account) => (
            <RecorderAccount key={account.connectionId} account={account} />
          ))
        )}
        {view.providers.map((p) => (
          <ConnectKey key={p.provider} provider={p} />
        ))}
      </div>
    </SettingsSection>
  )
}

const LABEL = { granola: 'Granola' } as const

function statusOf(account: RecorderAccountView): {
  text: string
  error: boolean
} {
  if (account.status === 'error')
    return {
      text: account.errorReason ?? 'Needs a new key',
      error: true,
    }
  if (account.status === 'revoked') return { text: 'Revoked', error: true }
  return {
    text:
      account.lastSyncAt === null
        ? 'Connected · not synced yet'
        : `Synced ${account.lastSyncAt.slice(0, 16).replace('T', ' ')}`,
    error: false,
  }
}

function RecorderAccount({ account }: { account: RecorderAccountView }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const label = LABEL[account.provider]
  const status = statusOf(account)
  const ticked = new Set(
    (account.folders ?? []).filter((f) => f.ticked).map((f) => f.id),
  )

  async function save(
    next: {
      folderIds: Array<string>
      typedNotes: boolean
      transcript: boolean
    },
    done: string,
  ) {
    setPending(true)
    try {
      await saveRecorderSettings({
        data: { connectionId: account.connectionId, ...next },
      })
      toast(done)
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  const current = {
    folderIds: [...ticked],
    typedNotes: account.typedNotes,
    transcript: account.transcript,
  }

  function tickFolder(id: string, name: string, next: boolean) {
    const folderIds = next
      ? [...ticked, id]
      : [...ticked].filter((f) => f !== id)
    void save(
      { ...current, folderIds },
      next
        ? `${name} shared with the workspace`
        : `${name} unshared · its notes leave on the next sync`,
    )
  }

  async function disconnect() {
    setPending(true)
    try {
      await disconnectConnection({
        data: { connectionId: account.connectionId },
      })
      toast(`${label} disconnected · its notes are removed`)
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect')
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex min-h-12 items-center gap-3.5 border-b border-rule px-3 py-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <span className="shrink-0 text-body text-foreground">{label}</span>
          <span className="truncate mono text-micro text-graphite">
            {account.email}
          </span>
        </div>
        <span
          title={status.text}
          className={
            status.error
              ? 'w-56 shrink-0 truncate mono text-micro text-destructive'
              : 'w-56 shrink-0 truncate mono text-micro text-graphite'
          }
        >
          {status.text}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void disconnect()}
        >
          Disconnect
        </Button>
      </div>
      <SettingsRow
        label="Folders"
        hint="Notes in a ticked folder are shared with the workspace."
      >
        {account.folders === null ? (
          <span className="text-label text-graphite">
            {account.foldersError ?? 'Could not list the folders'}
          </span>
        ) : account.folders.length === 0 ? (
          <span className="text-label text-graphite">No folders.</span>
        ) : (
          account.folders.map((folder) => (
            <label
              key={folder.id}
              className="flex cursor-pointer items-center gap-1.5 text-ui"
            >
              <Checkbox
                checked={folder.ticked}
                disabled={pending}
                aria-label={folder.name}
                onCheckedChange={(next) =>
                  tickFolder(folder.id, folder.name, next)
                }
              />
              {folder.name}
            </label>
          ))
        )}
      </SettingsRow>
      <SettingsRow label="Also fetch" hint="Only you see these.">
        <label className="flex cursor-pointer items-center gap-1.5 text-ui">
          <Checkbox
            checked={account.typedNotes}
            disabled={pending}
            aria-label="Typed notes"
            onCheckedChange={(next) =>
              void save(
                { ...current, typedNotes: next },
                next ? 'Typed notes on' : 'Typed notes off',
              )
            }
          />
          Typed notes
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-ui">
          <Checkbox
            checked={account.transcript}
            disabled={pending}
            aria-label="Transcript"
            onCheckedChange={(next) =>
              void save(
                { ...current, transcript: next },
                next ? 'Transcripts on' : 'Transcripts off',
              )
            }
          />
          Transcript
        </label>
      </SettingsRow>
    </div>
  )
}

const LINK =
  'focus-ring rounded-md text-label text-graphite hover:text-foreground'

/** A provider the reader can add: their key, or what stands in the way. */
function ConnectKey({
  provider,
}: {
  provider: MeetingNotesView['providers'][number]
}) {
  const router = useRouter()
  const { draft, set } = useSettingsDraft({ key: '' }, async (next) => {
    if (next.key.trim() === '') return next
    const { email } = await connectRecorderKey({
      data: { provider: provider.provider, key: next.key },
    })
    toast(`${provider.label} connected · ${email}`)
    void router.invalidate()
    return { key: '' }
  })
  return (
    <SettingsRow label={provider.label}>
      {provider.offer === 'connect' ? (
        <Input
          aria-label={`${provider.label} API key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.key}
          onChange={(e) => set('key', e.target.value)}
          placeholder={`Paste your key · ${provider.keyHint}`}
          className="w-72 mono"
        />
      ) : provider.offer === 'install' ? (
        <Link
          to="/settings/plugins"
          hash={pluginAnchor(provider.plugin)}
          className={LINK}
        >
          Install ›
        </Link>
      ) : (
        <span className="text-label text-graphite">
          {provider.offer === 'ask' ? 'Ask an admin' : 'Not available yet'}
        </span>
      )}
    </SettingsRow>
  )
}
