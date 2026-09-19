import { Link } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '#/lib/utils'

export type OnboardingProgress = {
  mappedMarkets: boolean
  filedMemo: boolean
  wroteMandate: boolean
  trackedCompany: boolean
  invitedPartner: boolean
}

// FROZEN: renaming re-shows the welcome banner for existing users.
const DISMISS_KEY = 'dealos.getting-started.dismissed'

const STEPS: Array<{
  key: keyof OnboardingProgress
  label: string
  detail: string
  to: string
}> = [
  {
    key: 'mappedMarkets',
    label: 'Map your markets',
    detail: 'A space per market you look at — the tree is your map.',
    to: '/spaces',
  },
  {
    key: 'filedMemo',
    label: 'File a first memo',
    detail: 'Open a space and write what you believe about that market.',
    to: '/notes',
  },
  {
    key: 'wroteMandate',
    label: 'Write the mandate',
    detail: 'What you invest in — stages, geos, check size, thesis.',
    to: '/mandate',
  },
  {
    key: 'trackedCompany',
    label: 'Track companies',
    detail: 'Tag companies into spaces — watching, not yet evaluating.',
    to: '/companies',
  },
  {
    key: 'invitedPartner',
    label: 'Invite your partner',
    detail: 'Solo? Skip it — dismiss the card whenever.',
    to: '/settings',
  },
]

/**
 * The onboarding direction, on the surface instead of in the wizard
 * (decided 2026-08-07): every step is "done" when its real artifact exists,
 * never by being clicked. Dismissal is local to this browser — the card is
 * guidance, not state.
 */
export function GettingStarted({ progress }: { progress: OnboardingProgress }) {
  // localStorage is read post-mount so SSR and client render identically.
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    setVisible(localStorage.getItem(DISMISS_KEY) !== '1')
  }, [])

  const done = STEPS.filter((s) => progress[s.key]).length
  if (!visible || done === STEPS.length) return null

  return (
    <section
      aria-label="Getting started"
      className="mt-6 rounded-none border border-rule bg-bone p-4"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-ui font-semibold">
          Getting started
          <span className="tabular ml-2 font-normal text-graphite">
            {done}/{STEPS.length}
          </span>
        </h2>
        <button
          type="button"
          aria-label="Dismiss getting started"
          className="focus-ring rounded-md text-graphite hover:text-foreground"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, '1')
            setVisible(false)
          }}
        >
          <X className="size-4" strokeWidth={2} />
        </button>
      </div>
      <ol className="mt-3 space-y-1">
        {STEPS.map((s) => {
          const isDone = progress[s.key]
          return (
            <li key={s.key}>
              <Link
                to={s.to}
                className={cn(
                  'group focus-ring flex items-baseline gap-2.5 rounded-md px-2 py-1.5 hover:bg-bone',
                  isDone && 'opacity-60',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 translate-y-0.5 items-center justify-center rounded-none border',
                    isDone
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-hairline bg-paper',
                  )}
                >
                  {isDone ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
                <span
                  className={cn(
                    'text-ui font-medium',
                    isDone && 'line-through',
                  )}
                >
                  {s.label}
                </span>
                <span className="text-label text-graphite">{s.detail}</span>
              </Link>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
