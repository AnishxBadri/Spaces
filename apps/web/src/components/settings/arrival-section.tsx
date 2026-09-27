import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { SettingsRow, SettingsSection } from './settings-section'
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
 * Settings → Arrival (SPA-56, D31) — the forwarding mailbox: an address the
 * fund forwards or BCCs mail to, polled over IMAP with an app password. The
 * settings-ledger shape the Embeddings section uses: a head whose readout is
 * the mailbox's state in one line, one row per field with the control
 * right, the Test and Save actions, then the last poll and the last error
 * as rows of their own.
 *
 * The app password is write-only. The section never has it: a saved one
 * reads as its `redact()` display in the hint, the field stays empty, and a
 * save with the field empty keeps it. Test connection tries what is typed —
 * the password field if filled, the stored one otherwise — without saving.
 */
export function ArrivalSection({ settings }: { settings: ArrivalSettings }) {
  const router = useRouter()
  const saved = settings.mailbox
  const [address, setAddress] = useState(saved?.address ?? '')
  const [host, setHost] = useState(saved?.host ?? '')
  const [port, setPort] = useState(String(saved?.port ?? MAILBOX_DEFAULTS.port))
  const [useTls, setUseTls] = useState(saved?.useTls ?? MAILBOX_DEFAULTS.useTls)
  const [folder, setFolder] = useState(saved?.folder ?? MAILBOX_DEFAULTS.folder)
  const [cadence, setCadence] = useState(
    String(saved?.cadenceMinutes ?? MAILBOX_DEFAULTS.cadenceMinutes),
  )
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState<'save' | 'test' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)

  function draft(): MailboxInput | null {
    const portN = Number(port)
    const cadenceN = Number(cadence)
    if (!address.trim() || !host.trim()) {
      setError('An address and a host are required.')
      return null
    }
    if (!Number.isInteger(portN) || portN < 1 || portN > 65535) {
      setError('The port is a number between 1 and 65535.')
      return null
    }
    if (!Number.isInteger(cadenceN) || cadenceN < 1 || cadenceN > 60) {
      setError('Poll every 1 to 60 minutes.')
      return null
    }
    const fields = {
      address: address.trim(),
      host: host.trim(),
      port: portN,
      useTls,
      folder: folder.trim() || MAILBOX_DEFAULTS.folder,
      cadenceMinutes: cadenceN,
    }
    return password === '' ? fields : { ...fields, password }
  }

  async function save() {
    const data = draft()
    if (data === null) return
    if (saved === null && data.password === undefined) {
      setError('Paste the mailbox’s app password.')
      return
    }
    setPending('save')
    setError(null)
    try {
      const { queued } = await saveMailbox({ data })
      setPassword('')
      toast(
        queued
          ? 'Mailbox saved · polling now'
          : 'Mailbox saved · the worker queue is unreachable, it polls on the next start',
      )
      void router.invalidate()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not save the mailbox',
      )
    } finally {
      setPending(null)
    }
  }

  async function test() {
    const data = draft()
    if (data === null) return
    setPending('test')
    setError(null)
    setResult(null)
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
    <SettingsSection
      title="Arrival"
      blurb="An address you forward or BCC mail to. Threads land on the people and companies they match."
      crumb="Workspace"
    >
      <div className="flex flex-col pt-5">
        <div className="flex items-baseline gap-3 border-b border-hairline pb-2">
          <h3 className="label-caps text-foreground">Mailbox</h3>
          <span className="mono text-micro text-graphite">
            {readout(saved)}
          </span>
        </div>

        <SettingsRow
          label="Address"
          hint="The mailbox people forward to. It is also the login."
        >
          <Input
            aria-label="Mailbox address"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="deals@fund.example"
            className="w-72 mono"
          />
        </SettingsRow>

        <SettingsRow
          label="IMAP server"
          hint="Host and port, as the provider lists them."
        >
          <Input
            aria-label="IMAP host"
            autoComplete="off"
            spellCheck={false}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="imap.fastmail.com"
            className="w-52 mono"
          />
          <Input
            aria-label="IMAP port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="w-18 mono"
          />
          <Switch checked={useTls} onCheckedChange={setUseTls}>
            TLS
          </Switch>
        </SettingsRow>

        <SettingsRow
          label="Folder"
          hint="Read-only: nothing is marked read or moved."
        >
          <Input
            aria-label="IMAP folder"
            autoComplete="off"
            spellCheck={false}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            className="w-52 mono"
          />
        </SettingsRow>

        <SettingsRow label="Poll every" hint="Minutes between polls, 1 to 60.">
          <Input
            aria-label="Poll cadence in minutes"
            inputMode="numeric"
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            className="w-18 mono"
          />
          <span className="mono text-micro text-graphite">min</span>
        </SettingsRow>

        <SettingsRow
          label={saved ? 'Replace app password' : 'App password'}
          hint={
            saved?.passwordDisplay
              ? `Saved as ${saved.passwordDisplay}. Stored encrypted; never shown again.`
              : 'An app password, not the account password. Stored encrypted.'
          }
        >
          <Input
            aria-label="Mailbox app password"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={saved ? '••••••••' : 'app password'}
            className="w-72 mono"
          />
        </SettingsRow>

        <div className="flex min-h-12 items-center justify-end gap-3 border-b border-rule py-2">
          {error ? (
            <span
              role="alert"
              className="mr-auto mono text-micro text-destructive"
            >
              {error}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void test()}
            disabled={pending !== null}
          >
            {pending === 'test' ? 'Testing' : 'Test connection'}
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={pending !== null}
          >
            {pending === 'save' ? 'Saving' : 'Save'}
          </Button>
        </div>

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
                ? `${String(result.exists)} ${result.exists === 1 ? 'message' : 'messages'} in ${folder} · uidvalidity ${String(result.uidValidity)}`
                : result.message}
            </span>
          </div>
        ) : null}

        <SettingsRow
          label="Last poll"
          hint={
            run === null
              ? 'Not polled yet.'
              : (run.summary ?? run.error ?? run.status)
          }
        >
          <span className="tabular mono text-micro text-graphite">
            {saved?.lastPolledAt ? stamp(saved.lastPolledAt) : 'never'}
          </span>
        </SettingsRow>

        {saved?.lastError ? (
          <SettingsRow label="Last error" hint={saved.lastError}>
            <span className="mono text-micro text-destructive">
              {saved.status}
            </span>
          </SettingsRow>
        ) : null}

        <div className="flex h-8 items-center justify-between">
          <span className="label-caps font-normal text-graphite">
            forwarded bodies are shared · admin only
          </span>
          <span className="mono text-micro text-graphite">
            one interaction per message-id
          </span>
        </div>
      </div>
    </SettingsSection>
  )
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
