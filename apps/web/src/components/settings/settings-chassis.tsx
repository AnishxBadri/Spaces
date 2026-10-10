import {
  getRouteApi,
  useLocation,
  useMatch,
  useNavigate,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import { SettingsNav } from './settings-nav'
import type { SettingsCounts } from './settings-nav'
import { rememberAppPage, settingsReturnHref } from '#/lib/settings-return'
import { isTyping } from '#/lib/use-hotkey'

const shell = getRouteApi('/_app/settings')

/**
 * For the app shell: whether settings holds the chassis, and the effect that
 * remembers every app page so settings can go back to it.
 */
export function useSettingsTakeover(): boolean {
  const location = useLocation()
  useEffect(() => {
    rememberAppPage(location.pathname, location.href)
  }, [location.pathname, location.href])
  return useMatch({ from: '/_app/settings', shouldThrow: false }) !== undefined
}

/**
 * What the settings shell needs from its loader: whether the reader is an
 * admin, the admins a member is told to ask, and the nav's right-lane counts.
 */
export function useSettingsNav(): {
  isAdmin: boolean
  admins: ReadonlyArray<string>
  counts: SettingsCounts
} {
  const data = shell.useLoaderData()
  return {
    isAdmin: data.isAdmin,
    admins: data.members
      .filter((m) => m.role === 'admin' && !m.banned)
      .map((m) => m.name),
    counts: {
      '/settings/members': data.members.length,
      '/settings/templates': data.templates.length,
      '/settings/objects': data.objects.length,
      '/settings/currency': data.fx.rates.length,
      '/settings/plugins': data.integrations,
    },
  }
}

/**
 * The key that leaves settings: a bare Escape the page itself received.
 * - Not from a field, an editor or a dialog (`isTyping`).
 * - Not one a popover or menu already spent closing itself — Radix marks
 *   that `defaultPrevented`.
 */
export function isLeaveSettingsKey(e: KeyboardEvent): boolean {
  return (
    e.key === 'Escape' &&
    !e.defaultPrevented &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey &&
    !isTyping(e)
  )
}

/**
 * The chassis while settings is open (D81): `‹ Settings` back to the page
 * settings was opened from, over the settings nav, in place of the app nav.
 * Escape goes back too; no key hint is printed beside it.
 */
export function SettingsChassis() {
  const navigate = useNavigate()
  const { counts } = useSettingsNav()

  useEffect(() => {
    const leave = (e: KeyboardEvent) => {
      if (!isLeaveSettingsKey(e)) return
      e.preventDefault()
      void navigate({ href: settingsReturnHref() })
    }
    document.addEventListener('keydown', leave)
    return () => document.removeEventListener('keydown', leave)
  }, [navigate])

  return (
    <div className="relative flex h-full flex-col bg-bone">
      {/* The chassis edge, as the app nav draws it. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-px bg-hairline"
      />
      <div className="flex h-12 shrink-0 items-center border-b border-hairline px-3">
        <button
          type="button"
          onClick={() => void navigate({ href: settingsReturnHref() })}
          // The visible word leads the name (WCAG 2.5.3).
          aria-label="Settings — go back"
          aria-keyshortcuts="Escape"
          className="focus-ring flex h-[1.875rem] min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left text-ui font-medium text-foreground transition-colors hover:bg-bone-deep"
        >
          <span aria-hidden className="text-graphite">
            ‹
          </span>
          <span className="min-w-0 flex-1 truncate">Settings</span>
        </button>
      </div>
      <SettingsNav variant="chassis" counts={counts} />
    </div>
  )
}
