import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsSection,
  SettingsTip,
} from './settings-section'
import { ReadoutStrip } from '#/components/record/record-parts'
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
 * - The typed fields are one draft in the page's Save bar; the Secure switch
 *   saves alone once a mailbox exists (D81).
 * - The app password is write-only. A saved one reads as `●●●● saved` with
 *   Replace; a save with the field empty keeps it. Test connection tries
 *   what is typed, without saving.
 */
export function ArrivalSection({ settings }: { settings: ArrivalSettings }) {
  const router = useRouter()
  const saved = settings.mailbox
  const [pending, setPending] = useState<'tls' | 'test' | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)
  const [replacing, setReplacing] = useState(false)
  const now = useNow()

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
      setReplacing(false)
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
      toast(useTls ? 'Secure on' : 'Secure off')
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

  const passwordField =
    saved === null || saved.passwordDisplay === null || replacing

  return (
    <SettingsSection title="Email forwarding" crumb="Integrations">
      {saved ? (
        <ReadoutStrip
          className="border-t-0 border-b border-rule"
          readouts={[
            {
              label: 'Address',
              figure: true,
              value: (
                <span className="truncate mono text-body leading-6.5">
                  {saved.address}
                </span>
              ),
            },
            {
              label: 'Since last check',
              value:
                saved.lastPolledAt === null || now === null
                  ? '—'
                  : since(saved.lastPolledAt, now),
              ...(saved.status === 'error' ? { tone: 'bad' as const } : {}),
            },
            { label: 'Threads today', value: String(settings.threadsToday) },
          ]}
        />
      ) : null}

      <div className="flex flex-col">
        <SettingsGroupHead title="Mailbox" count={stateOf(saved)} />

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
            className="w-64 mono"
          />
        </SettingsRow>

        <SettingsRow label="Mail server">
          <SettingsTip tip="The IMAP host and port, as the provider lists them.">
            <Input
              aria-label="IMAP host"
              autoComplete="off"
              spellCheck={false}
              value={draft.host}
              onChange={(e) => set('host', e.target.value)}
              placeholder="imap.fastmail.com"
              className="w-48 mono"
            />
          </SettingsTip>
          <Input
            aria-label="IMAP port"
            inputMode="numeric"
            value={draft.port}
            onChange={(e) => set('port', e.target.value)}
            className="w-16 mono"
          />
          <Switch
            checked={draft.useTls}
            disabled={pending === 'tls'}
            onCheckedChange={(next) => void saveTls(next)}
          >
            Secure
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
              className="w-36 mono"
            />
          </SettingsTip>
        </SettingsRow>

        <SettingsRow label="Check every">
          <SettingsTip tip="Minutes between checks, 1 to 60.">
            <Input
              aria-label="Check every, in minutes"
              inputMode="numeric"
              value={draft.cadence}
              onChange={(e) => set('cadence', e.target.value)}
              className="w-16 mono"
            />
          </SettingsTip>
          <span className="mono text-micro text-graphite">min</span>
        </SettingsRow>

        <SettingsRow label="App password" hint="Not your account password.">
          {passwordField ? (
            <Input
              aria-label="Mailbox app password"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder="Paste the app password"
              className="w-64 mono"
            />
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate mono text-label">
                <span aria-label="stored password">●●●●</span> saved
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setReplacing(true)}
              >
                Replace
              </Button>
            </>
          )}
        </SettingsRow>

        <div
          data-mailbox-foot
          className="flex min-h-12 items-center gap-3 border-b border-rule py-2"
        >
          <FootLine result={result} folder={draft.folder} settings={settings} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void test()}
            disabled={pending !== null}
          >
            {pending === 'test' ? 'Testing' : 'Test connection'}
          </Button>
        </div>
      </div>
    </SettingsSection>
  )
}

/**
 * The foot's one status line: the last test when there is one, else the
 * stored error, else the last poll's summary.
 */
function FootLine({
  result,
  folder,
  settings,
}: {
  result: TestResult | null
  folder: string
  settings: ArrivalSettings
}) {
  const saved = settings.mailbox
  const run = settings.lastRun
  const line: { bad: boolean; text: string } | null = result
    ? result.ok
      ? {
          bad: false,
          text: `connected · ${result.exists.toLocaleString('en-US')} ${result.exists === 1 ? 'message' : 'messages'} in ${folder}`,
        }
      : { bad: true, text: result.message }
    : saved?.lastError
      ? { bad: true, text: saved.lastError }
      : run
        ? { bad: false, text: run.summary ?? run.error ?? run.status }
        : null
  return (
    <span
      role="status"
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2 mono text-micro break-words',
        line?.bad ? 'text-destructive' : 'text-graphite',
      )}
    >
      {line ? (
        <>
          <span
            aria-hidden
            className={cn(
              'size-1.5 shrink-0',
              line.bad ? 'bg-destructive' : 'bg-primary',
            )}
          />
          {line.text}
        </>
      ) : null}
    </span>
  )
}

/** The clock, read after hydration so the server and first render agree. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => setNow(Date.now()), [])
  return now
}

/** `2 min`, `3 h`, `2 d` since an instant. */
function since(iso: string, now: number): string {
  const minutes = Math.max(
    0,
    Math.floor((now - new Date(iso).getTime()) / 60_000),
  )
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${String(hours)} h`
  return `${String(Math.floor(hours / 24))} d`
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
    throw new Error('An address and a mail server are required.')
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('The port is a number between 1 and 65535.')
  if (
    !Number.isInteger(cadenceMinutes) ||
    cadenceMinutes < 1 ||
    cadenceMinutes > 60
  )
    throw new Error('Check every 1 to 60 minutes.')
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

/** The group head's state word, only when the mailbox is not simply working. */
function stateOf(saved: ArrivalSettings['mailbox']): string | undefined {
  if (saved === null) return 'not set up'
  switch (saved.status) {
    case 'pending':
      return 'waiting for the first check'
    case 'ok':
      return undefined
    case 'error':
      return 'error · backing off'
  }
}
