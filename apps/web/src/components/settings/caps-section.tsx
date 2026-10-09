import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { SettingsRow, SettingsSection } from './settings-section'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { formatNumber } from '@spaces/core/format'
import { setAiCaps } from '#/lib/server-fns'
import type { getAiCaps, getAiUsageToday } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

type CapsView = Awaited<ReturnType<typeof getAiCaps>>
type UsageToday = Awaited<ReturnType<typeof getAiUsageToday>>

/** A token count as the ledger prints it: grouped, never compact. */
const tokens = (n: number) => formatNumber(n, 0)

/** A blank field is no cap; anything else must be a positive whole number. */
function parseCeiling(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n > 0 ? n : 'invalid'
}

/**
 * Caps — the workspace's AI token ceilings, under Usage & limits (D81).
 * - One 48px row per ceiling, the save row, then Used today from `ai_usage`.
 * - A blank field is no cap; with neither set the head says so.
 * - `complete()` refuses a call once the day is at the daily ceiling; this
 *   section only sets the numbers and shows the count.
 */
export function CapsSection({
  caps,
  usage,
}: {
  caps: CapsView
  usage: UsageToday
}) {
  const router = useRouter()
  const [daily, setDaily] = useState(
    caps.dailyTokens === null ? '' : String(caps.dailyTokens),
  )
  const [perRun, setPerRun] = useState(
    caps.perRunTokens === null ? '' : String(caps.perRunTokens),
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const uncapped = caps.dailyTokens === null && caps.perRunTokens === null
  const readout = uncapped
    ? 'No cap — every lane spends freely'
    : [
        caps.dailyTokens === null ? null : `${tokens(caps.dailyTokens)} a day`,
        caps.perRunTokens === null
          ? null
          : `${tokens(caps.perRunTokens)} a call`,
      ]
        .filter((part) => part !== null)
        .join(' · ')
  const reached = caps.dailyTokens !== null && usage.used >= caps.dailyTokens

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const dailyTokens = parseCeiling(daily)
    const perRunTokens = parseCeiling(perRun)
    if (dailyTokens === 'invalid' || perRunTokens === 'invalid') {
      setError('A cap is a whole number of tokens, or blank for none.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await setAiCaps({ data: { dailyTokens, perRunTokens } })
      toast(
        dailyTokens === null && perRunTokens === null
          ? 'AI caps cleared'
          : 'AI caps saved',
      )
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsSection
      title="Caps"
      blurb="How many tokens the workspace may spend on AI, counted from every call's usage."
      crumb="AI"
    >
      <form onSubmit={save} className="flex flex-col pt-8">
        <SectionHead as="h3" title="Ceilings" count={readout} />
        <SettingsRow
          label="Daily tokens"
          hint="Tokens in and out across every lane, per UTC day. Blank is no cap."
        >
          <Input
            id="ai-cap-daily"
            aria-label="Daily token cap"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            placeholder="No cap"
            className="w-40 mono"
          />
        </SettingsRow>
        <SettingsRow
          label="Per-run tokens"
          hint="The largest prompt one call may send, estimated at four characters a token. Blank is no cap."
        >
          <Input
            id="ai-cap-per-run"
            aria-label="Per-run token cap"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={perRun}
            onChange={(e) => setPerRun(e.target.value)}
            placeholder="No cap"
            className="w-40 mono"
          />
        </SettingsRow>
        <div className="flex min-h-12 items-center justify-end gap-3 border-b border-rule px-3 py-2">
          {error ? (
            <span
              role="alert"
              className="mr-auto mono text-micro text-destructive"
            >
              {error}
            </span>
          ) : null}
          <Button type="submit" size="sm" disabled={pending}>
            Save
          </Button>
        </div>
        <SettingsRow
          label="Used today"
          hint={`Since 00:00 UTC, from the AI usage ledger. ${reached ? 'Calls are refused until' : 'The day resets at'} 00:00 UTC.`}
        >
          <span
            className={cn(
              'mono text-label',
              reached ? 'text-destructive' : 'text-graphite',
            )}
          >
            {caps.dailyTokens === null
              ? `${tokens(usage.used)} tokens · no cap`
              : `${tokens(usage.used)} of ${tokens(caps.dailyTokens)} tokens`}
          </span>
        </SettingsRow>
        <div className="flex h-8 items-center justify-between px-3">
          <span className="label-caps font-normal text-graphite">
            tokens per workspace · admin only
          </span>
          <span className="mono text-micro text-graphite">
            checked before each call · a call in flight finishes
          </span>
        </div>
      </form>
    </SettingsSection>
  )
}
