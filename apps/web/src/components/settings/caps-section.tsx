import { useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsTip,
  readOnlyLine,
  useSettingsPage,
} from './settings-section'
import { Input } from '#/components/ui/input'
import { setAiCaps } from '#/lib/server-fns'
import type { getAiCaps } from '#/lib/server-fns'

type CapsView = Awaited<ReturnType<typeof getAiCaps>>

/** A blank field is no cap; anything else must be a positive whole number. */
function parseCeiling(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n > 0 ? n : 'invalid'
}

/**
 * Limits — the workspace's AI token ceilings, a group of Usage & limits
 * (D81).
 * - Two typed fields in the page's Save bar; a blank one is no cap.
 * - Only an admin changes them: a member reads them disabled, with whom to
 *   ask in the group head.
 * - `complete()` refuses a call once the day is at the daily ceiling; this
 *   group only sets the numbers. Today's count is the page's readout.
 */
export function LimitsGroup({ caps }: { caps: CapsView }) {
  const router = useRouter()
  const page = useSettingsPage()
  const { draft, set } = useSettingsDraft(
    {
      daily: caps.dailyTokens === null ? '' : String(caps.dailyTokens),
      perRun: caps.perRunTokens === null ? '' : String(caps.perRunTokens),
    },
    async (next) => {
      const dailyTokens = parseCeiling(next.daily)
      const perRunTokens = parseCeiling(next.perRun)
      if (dailyTokens === 'invalid' || perRunTokens === 'invalid')
        throw new Error(
          'A limit is a whole number of tokens, or blank for none.',
        )
      await setAiCaps({ data: { dailyTokens, perRunTokens } })
      toast(
        dailyTokens === null && perRunTokens === null
          ? 'AI limits cleared'
          : 'AI limits saved',
      )
      void router.invalidate()
    },
  )

  return (
    <div className="flex flex-col">
      <SettingsGroupHead
        title="Limits"
        action={
          page.isAdmin ? undefined : (
            <span data-read-only>{readOnlyLine(page.admins)}</span>
          )
        }
      />
      <fieldset disabled={!page.isAdmin} className="contents">
        <SettingsRow label="Daily limit">
          <SettingsTip tip="Tokens in and out across every lane, per UTC day. Blank is no limit.">
            <Input
              id="ai-cap-daily"
              aria-label="Daily token cap"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.daily}
              onChange={(e) => set('daily', e.target.value)}
              placeholder="No limit"
              className="w-40 mono"
            />
          </SettingsTip>
          <span className="mono text-micro text-graphite">tokens</span>
        </SettingsRow>
        <SettingsRow label="Largest single call">
          <SettingsTip tip="The largest prompt one call may send, estimated at four characters a token. Blank is no limit.">
            <Input
              id="ai-cap-per-run"
              aria-label="Per-run token cap"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.perRun}
              onChange={(e) => set('perRun', e.target.value)}
              placeholder="No limit"
              className="w-40 mono"
            />
          </SettingsTip>
          <span className="mono text-micro text-graphite">tokens</span>
        </SettingsRow>
      </fieldset>
    </div>
  )
}
