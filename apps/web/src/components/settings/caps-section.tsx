import { useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsSection,
  SettingsTip,
} from './settings-section'
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
 * - One 48px row per ceiling, then Used today from `ai_usage`. The ceilings
 *   are typed fields in the page's Save bar; only an admin changes them.
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
  const { draft, set } = useSettingsDraft(
    {
      daily: caps.dailyTokens === null ? '' : String(caps.dailyTokens),
      perRun: caps.perRunTokens === null ? '' : String(caps.perRunTokens),
    },
    async (next) => {
      const dailyTokens = parseCeiling(next.daily)
      const perRunTokens = parseCeiling(next.perRun)
      if (dailyTokens === 'invalid' || perRunTokens === 'invalid')
        throw new Error('A cap is a whole number of tokens, or blank for none.')
      await setAiCaps({ data: { dailyTokens, perRunTokens } })
      toast(
        dailyTokens === null && perRunTokens === null
          ? 'AI caps cleared'
          : 'AI caps saved',
      )
      void router.invalidate()
    },
  )

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

  return (
    <SettingsSection title="Caps" crumb="AI" adminOnly>
      <div className="flex flex-col">
        <SettingsGroupHead title="Ceilings" count={readout} />
        <SettingsRow label="Daily tokens">
          <SettingsTip tip="Tokens in and out across every lane, per UTC day. Blank is no cap.">
            <Input
              id="ai-cap-daily"
              aria-label="Daily token cap"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.daily}
              onChange={(e) => set('daily', e.target.value)}
              placeholder="No cap"
              className="w-40 mono"
            />
          </SettingsTip>
        </SettingsRow>
        <SettingsRow label="Per-run tokens">
          <SettingsTip tip="The largest prompt one call may send, estimated at four characters a token. Blank is no cap.">
            <Input
              id="ai-cap-per-run"
              aria-label="Per-run token cap"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.perRun}
              onChange={(e) => set('perRun', e.target.value)}
              placeholder="No cap"
              className="w-40 mono"
            />
          </SettingsTip>
        </SettingsRow>
        <SettingsRow
          label="Used today"
          hint={reached ? 'Calls are refused until 00:00 UTC.' : undefined}
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
      </div>
    </SettingsSection>
  )
}
