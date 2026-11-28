import { Link } from '@tanstack/react-router'
import { adminNames } from '#/lib/setup/whats-set-up'
import type { SetupPath } from '#/lib/setup/whats-set-up'
import type { SetupAudience } from '#/lib/server-fns'

/**
 * The in-place setup prompt: one line, one link, where a missing
 * piece would be used — never a checklist or a banner.
 * - An admin reads `<what it needs> · <action> ›`, the link to set it up.
 * - A member reads `Ask <admin names> to set up <thing>` and no link.
 */
export function NeedsSetup({
  needs,
  action,
  to,
  thing,
  ask = 'set up',
  audience,
}: {
  /** What is missing, said plainly: "No calendar connected". */
  needs: string
  /** The verb on the link: "Connect Google", "More sources". */
  action: string
  to: SetupPath
  /** What a member asks for: "Google", "more enrichment sources". */
  thing: string
  /** The member's verb: `Ask Anika Rao to connect Google`. */
  ask?: string | undefined
  audience: SetupAudience
}) {
  if (!audience.isAdmin)
    return (
      <p data-needs-setup="member" className="text-label text-graphite">
        Ask {adminNames(audience.admins)} to {ask} {thing}
      </p>
    )
  return (
    <p data-needs-setup="admin" className="text-label text-graphite">
      {needs} ·{' '}
      <Link
        to={to}
        className="focus-ring mono text-micro font-medium text-foreground hover:underline"
      >
        {action} ›
      </Link>
    </p>
  )
}
