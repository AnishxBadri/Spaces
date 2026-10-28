import { useRouter } from '@tanstack/react-router'
import { Archive, ArchiveRestore } from 'lucide-react'
import { toast } from 'sonner'
import type { ResolvedSensitivity } from '#/lib/ai/sensitivity'
import { archiveRecord, restoreRecord } from '#/lib/server-fns'
import type { RecordArchive } from '#/lib/server-fns'
import { sensitiveStamp } from '#/components/sensitive-toggle'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import type { StampProps } from '#/components/ui/stamp'

/**
 * A record's archived state on its own page: the outlined stamp, the `···`
 * entry that archives or restores, and the writes behind both. Archive asks
 * nothing; Restore undoes it.
 */

export type { RecordArchive }

/** The page's stamp: outlined with the day once archived, else the kind. */
export function recordStamp(
  kind: string,
  sensitivity: ResolvedSensitivity,
  archive: RecordArchive | null,
): StampProps {
  return archive === null
    ? sensitiveStamp(kind, sensitivity)
    : { kind, state: 'archived', archivedOn: archive.on }
}

/** Archive and Restore for one record; the page re-reads after each. */
export function useRecordArchive(id: string): {
  archive: () => Promise<void>
  restore: () => Promise<void>
} {
  const router = useRouter()
  return {
    archive: async () => {
      try {
        await archiveRecord({ data: { id } })
        void router.invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not archive')
      }
    },
    restore: async () => {
      try {
        await restoreRecord({ data: { id } })
        void router.invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not restore')
      }
    },
  }
}

/** The `···` entry: Restore on an archived record, Archive otherwise. */
export function archiveEntry(
  archived: boolean,
  act: { archive: () => Promise<void>; restore: () => Promise<void> },
): MoreMenuEntry {
  return archived
    ? {
        label: 'Restore',
        icon: <ArchiveRestore className="size-4" />,
        onSelect: () => void act.restore(),
      }
    : {
        label: 'Archive',
        icon: <Archive className="size-4" />,
        onSelect: () => void act.archive(),
      }
}
