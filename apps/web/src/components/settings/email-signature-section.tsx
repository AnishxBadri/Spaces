import { useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import { SettingsGroup, SettingsRow } from './settings-section'
import { SIGNATURE_MAX } from '#/lib/email/signature'
import { saveEmailSignature } from '#/lib/server-fns'

/**
 * The reader's email signature: plain text in the serif the body is
 * written in, a draft in the page's Save bar. The composer adds it once to
 * a new email and a reply; it needs no account connected.
 */
export function EmailSignatureCard({ stored }: { stored: string }) {
  const router = useRouter()
  const { draft, set } = useSettingsDraft(
    { signature: stored },
    async (next) => {
      const signature = await saveEmailSignature({
        data: { signature: next.signature },
      })
      toast('Saved')
      void router.invalidate()
      return { signature }
    },
  )
  return (
    <SettingsGroup title="Email">
      <SettingsRow label="Signature" top>
        <textarea
          aria-label="Email signature"
          rows={3}
          maxLength={SIGNATURE_MAX}
          value={draft.signature}
          onChange={(e) => set('signature', e.target.value)}
          className="focus-ring min-h-24 w-full resize-y rounded-md border border-rule bg-paper px-2.5 py-2 font-serif text-title leading-6 text-foreground outline-none"
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
