import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Select } from '../ui/select'
import { markNewerVersion } from '#/lib/server-fns'
import { linkReady } from '#/lib/documents/newer-version'
import type {
  VersionCandidate,
  VersionPick,
} from '#/lib/documents/newer-version'

/**
 * "Newer version of" on an arriving file: one optional field under the
 * row, defaulting to none, over the record's files of the same kind.
 * - Renders nothing when there is no candidate; never a disabled select.
 * - The same control on the upload dialog, the Files tab's uploads and a
 *   file attached from Drive.
 */

const NONE = 'none'

export function NewerVersionSelect({
  candidates,
  value,
  onChange,
  disabled = false,
}: {
  /** Newest first; `versionCandidates` answers it. */
  candidates: ReadonlyArray<VersionCandidate>
  value: string | null
  onChange: (olderId: string | null) => void
  /** While the link is being written. */
  disabled?: boolean
}) {
  if (candidates.length === 0) return null
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-label text-graphite">
        Newer version of
      </span>
      <Select
        aria-label="Newer version of"
        value={value ?? NONE}
        onChange={(next) => onChange(next === NONE ? null : next)}
        items={[
          { value: NONE, label: 'None' },
          ...candidates.map((c) => ({
            value: c.id,
            label: c.filename,
            render: (
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{c.filename}</span>
                <span className="shrink-0 mono text-micro text-graphite">
                  {c.createdAt.slice(0, 10)}
                </span>
              </span>
            ),
          })),
        ]}
        width="content"
        disabled={disabled}
        searchPlaceholder="Search files…"
        emptyLabel="No file matches."
        className="h-7 w-auto max-w-64"
      />
    </div>
  )
}

/**
 * Writes each pick's `supersedes` link once its document has committed —
 * a second call after the birth, never inside it. `onSettled` hears the
 * outcome: linked, or refused (the toast says why and the pick is the
 * caller's to reset, so a refusal is not retried every render).
 */
export function useLinkWhenFiled(
  picks: ReadonlyArray<VersionPick>,
  onSettled: (key: string, linked: boolean) => void,
) {
  const router = useRouter()
  const started = useRef(new Set<string>())
  const settle = useRef(onSettled)
  settle.current = onSettled
  const ready = picks.filter(linkReady)
  const signature = ready
    .map((p) => `${p.key}:${p.newerId}:${p.olderId}`)
    .join(',')
  const latest = useRef(ready)
  latest.current = ready

  useEffect(() => {
    for (const pick of latest.current) {
      if (started.current.has(pick.key)) continue
      started.current.add(pick.key)
      const { key, newerId, olderId } = pick
      markNewerVersion({ data: { newerId, olderId } }).then(
        () => {
          settle.current(key, true)
          void router.invalidate()
        },
        (err: unknown) => {
          started.current.delete(key)
          toast.error(
            err instanceof Error
              ? err.message
              : 'Could not mark the newer version',
          )
          settle.current(key, false)
        },
      )
    }
  }, [signature, router])
}
