import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsSection,
  SettingsTip,
} from './settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Switch } from '#/components/ui/switch'
import { MAILBOX_DEFAULTS } from '#/lib/arrival/input'
import type { MailboxInput } from '#/lib/arrival/input'
import type { getMailboxSettings } from '#/lib/server-fns'
import { saveMailbox, testMailbox } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

type ArrivalSettings = Awaited<ReturnType<typeof getMailboxSettings>>
type TestResult = Awaited<ReturnType<typeof testMailbox>>

/**
 * Settings → Email forwarding (D31) — the forwarding mailbox: an address the
 * fund forwards or BCCs mail to, polled over IMAP with an app password.
 * - The typed fields are one draft in the page's Save bar; the TLS switch
 *   saves alone once a mailbox exists (D81).
 * - The app password is write-only. A saved one reads as its `redact()`
 *   display beside the field, the field stays empty, and a save with it empty
 *   keeps it. Test connection tries what is typed, without saving.
 */
export function ArrivalSection({ settings }: { settings: ArrivalSettings }) {
  const router = useRouter()
  const saved = settings.mailbox
  const [pending, setPending] = useState<'tls' | 'test' | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)

  const { draft, set } = useSettingsDraft(
    {
      address: saved?.address ?? '',
      host: saved?.host ?? '',
      port: String(saved?.port ?? MAILBOX_DEFAULTS.port),
      useTls: saved?.useTls ?? MAILBOX_DEFAULTS.useTls,
      folder: saved?.folder ?? MAILBOX_DEFAULTS.folder,
      cadence: String(saved?.cadenceMinutes ?? MAILBOX_DEFAULTS.cadenceMinutes),
      password: '',
    },
    async (next) => {
      const data = mailboxOf(next)
      if (saved === null && data.password === undefined)
        throw new Error('Paste the mailbox’s app password.')
      const { queued } = await saveMailbox({ data })
      toast(
        queued
          ? 'Mailbox saved · polling now'
          : 'Mailbox saved · the worker queue is unreachable, it polls on the next start',
      )
      void router.invalidate()
      return { ...next, password: '' }
    },
  )

  /** The switch writes at once against what is stored, never the draft. */
  async function saveTls(useTls: boolean) {
    if (saved === null) {
      set('useTls', useTls)
      return
    }
    setPending('tls')
    try {
      await saveMailbox({
        data: {
          address: saved.address,
          host: saved.host,
          port: saved.port,
          useTls,
          folder: saved.folder,
          cadenceMinutes: saved.cadenceMinutes,
        },
      })
      toast(useTls ? 'TLS on' : 'TLS off')
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(null)
    }
  }

  async function test() {
    setResult(null)
    let data: MailboxInput
    try {
      data = mailboxOf(draft)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Check the fields')
      return
    }
    setPending('test')
    try {
      setResult(await testMailbox({ data }))
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : 'The test did not run',
      })
    } finally {
      setPending(null)
    }
  }

  const run = settings.lastRun
  return (
    <SettingsSection title="Email forwarding" crumb="Integrations">
      <div className="flex flex-col">
        <SettingsGroupHead title="Mailbox" count={readout(saved)} />

        <SettingsRow
          label="Address"
          hint="What is forwarded here is shared with every member."
        >
          <Input
            aria-label="Mailbox address"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={draft.address}
            onChange={(e) => set('address', e.target.value)}
            placeholder="deals@fund.example"
            className="w-72 mono"
          />
        </SettingsRow>

        <SettingsRow label="IMAP server">
          <SettingsTip tip="Host and port, as the provider lists them.">
            <Input
              aria-label="IMAP host"
              autoComplete="off"
              spellCheck={false}
              value={draft.host}
              onChange={(e) => set('host', e.target.value)}
              placeholder="imap.fastmail.com"
              className="w-52 mono"
            />
          </SettingsTip>
          <Input
            aria-label="IMAP port"
            inputMode="numeric"
            value={draft.port}
            onChange={(e) => set('port', e.target.value)}
            className="w-18 mono"
          />
          <Switch
            checked={draft.useTls}
            disabled={pending === 'tls'}
            onCheckedChange={(next) => void saveTls(next)}
          >
            TLS
          </Switch>
        </SettingsRow>

        <SettingsRow label="Folder">
          <SettingsTip tip="Read-only: nothing is marked read or moved.">
            <Input
              aria-label="IMAP folder"
              autoComplete="off"
              spellCheck={false}
              value={draft.folder}
              onChange={(e) => set('folder', e.target.value)}
              className="w-52 mono"
            />
          </SettingsTip>
        </SettingsRow>

        <SettingsRow label="Poll every">
          <SettingsTip tip="Minutes between polls, 1 to 60.">
            <Input
              aria-label="Poll cadence in minutes"
              inputMode="numeric"
              value={draft.cadence}
              onChange={(e) => set('cadence', e.target.value)}
              className="w-18 mono"
            />
          </SettingsTip>
          <span className="mono text-micro text-graphite">min</span>
        </SettingsRow>

        <SettingsRow
          label={saved ? 'Replace app password' : 'App password'}
          hint="Not your account password."
        >
          <Input
            aria-label="Mailbox app password"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.password}
            onChange={(e) => set('password', e.target.value)}
            placeholder={saved ? '••••••••' : 'app password'}
            className="w-72 mono"
          />
          {saved?.passwordDisplay ? (
            <span className="mono text-micro text-graphite">
              saved {saved.passwordDisplay}
            </span>
          ) : null}
        </SettingsRow>

        <SettingsRow label="">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void test()}
            disabled={pending !== null}
          >
            {pending === 'test' ? 'Testing' : 'Test connection'}
          </Button>
        </SettingsRow>

        {result ? (
          <div
            role="status"
            className="flex min-h-9 items-start gap-3 border-b border-rule py-2"
          >
            <span
              className={cn(
                'w-28 shrink-0 mono text-micro',
                result.ok ? 'text-graphite' : 'text-destructive',
              )}
            >
              {result.ok ? 'connected' : 'error'}
            </span>
            <span className="min-w-0 flex-1 mono text-label break-words">
              {result.ok
                ? `${String(result.exists)} ${result.exists === 1 ? 'message' : 'messages'} in ${draft.folder} · uidvalidity ${String(result.uidValidity)}`
                : result.message}
            </span>
          </div>
        ) : null}

        <SettingsRow label="Last poll">
          <span className="tabular mono text-micro text-graphite">
            {saved?.lastPolledAt ? stamp(saved.lastPolledAt) : 'never'}
          </span>
          <span className="min-w-0 text-label text-graphite">
            {run === null
              ? 'Not polled yet.'
              : (run.summary ?? run.error ?? run.status)}
          </span>
        </SettingsRow>

        {saved?.lastError ? (
          <SettingsRow label="Last error">
            <span className="mono text-micro text-destructive">
              {saved.status}
            </span>
            <span className="min-w-0 text-label break-words text-graphite">
              {saved.lastError}
            </span>
          </SettingsRow>
        ) : null}
      </div>
    </SettingsSection>
  )
}

/** The draft as the server takes it; throws the sentence a bad field earns. */
function mailboxOf(draft: {
  readonly address: string
  readonly host: string
  readonly port: string
  readonly useTls: boolean
  readonly folder: string
  readonly cadence: string
  readonly password: string
}): MailboxInput {
  const port = Number(draft.port)
  const cadenceMinutes = Number(draft.cadence)
  if (!draft.address.trim() || !draft.host.trim())
    throw new Error('An address and a host are required.')
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('The port is a number between 1 and 65535.')
  if (
    !Number.isInteger(cadenceMinutes) ||
    cadenceMinutes < 1 ||
    cadenceMinutes > 60
  )
    throw new Error('Poll every 1 to 60 minutes.')
  const fields = {
    address: draft.address.trim(),
    host: draft.host.trim(),
    port,
    useTls: draft.useTls,
    folder: draft.folder.trim() || MAILBOX_DEFAULTS.folder,
    cadenceMinutes,
  }
  return draft.password === ''
    ? fields
    : { ...fields, password: draft.password }
}

/** The head's one-line readout, lowercase mono: what the instrument says of itself. */
function readout(saved: ArrivalSettings['mailbox']): string {
  if (saved === null) return 'not configured · nothing is polled'
  const every = `every ${String(saved.cadenceMinutes)} min`
  switch (saved.status) {
    case 'pending':
      return `${saved.address} · ${every} · waiting for the first poll`
    case 'ok':
      return `${saved.address} · ${every} · ok`
    case 'error':
      return `${saved.address} · ${every} · error, backing off`
  }
}

function stamp(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} utc`
}
