import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AddWatchDialog } from '#/components/space-watching'
import type { WatchDraft } from '#/components/space-watching'
import { Button } from '#/components/ui/button'
import { getSaveWatchSetup, saveFindAsWatch } from '#/lib/server-fns'
import type { AskFindTable, AskSavedWatch } from '#/lib/server-fns'
import { engineFor, savedWatchLine, spaceNameFrom } from '#/lib/ask/find-view'

/**
 * A Find table's head: Save as watch, and once saved the thread's line
 * linking to the watch — which says so when the watch is gone.
 * - Absent until a watch engine is installed, like the space page's Add watch.
 * - The window opens on the table's space, else asks for one and offers to
 *   create a space named from the question; How often opens on Weekly.
 */

type Setup = Awaited<ReturnType<typeof getSaveWatchSetup>>

/** The saved line: the space linking to the watch, or the watch gone. */
export function SavedWatchLine({ saved }: { saved: AskSavedWatch }) {
  if (saved.deleted === true)
    return (
      <span
        data-saved-watch="deleted"
        className="mono text-micro text-graphite"
      >
        {savedWatchLine(saved)}
      </span>
    )
  return (
    <span data-saved-watch="live" className="mono text-micro text-graphite">
      Saved as a watch on{' '}
      <Link
        to="/spaces/$spaceId"
        params={{ spaceId: saved.spaceId }}
        search={{ watch: saved.id }}
        className="focus-ring text-foreground hover:underline"
      >
        {saved.spaceName}
      </Link>
    </span>
  )
}

export function FindTableHead({
  table,
  turnId,
  callIndex,
  question,
}: {
  table: AskFindTable
  /** Null while the answer streams: nothing can be saved yet. */
  turnId: string | null
  callIndex: number
  /** The question the table answered; null when the thread has none. */
  question: string | null
}) {
  const router = useRouter()
  const [setup, setSetup] = useState<Setup | null>(null)
  const [saved, setSaved] = useState(table.savedWatch)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (turnId === null || question === null) return
    // A cell: the flag is read after an `await`.
    const live = { current: true }
    void (async () => {
      try {
        const next = await getSaveWatchSetup()
        if (live.current) setSetup(next)
      } catch {
        if (live.current) setSetup(null)
      }
    })()
    return () => {
      live.current = false
    }
  }, [turnId, question])

  const prefill = useMemo(
    () =>
      setup === null || question === null
        ? null
        : {
            integrationId: engineFor(table, setup.engines),
            question,
            cadence: 'weekly',
          },
    [setup, question, table],
  )

  const offered =
    turnId !== null &&
    question !== null &&
    setup !== null &&
    setup.installed.length > 0 &&
    (saved === undefined || saved.deleted === true)
  if (saved === undefined && !offered) return null

  async function save(draft: WatchDraft) {
    if (turnId === null) return
    const out = await saveFindAsWatch({
      data: { turnId, callIndex, ...draft },
    })
    if (out.status === 'exists') {
      toast('Already watching this')
      await router.navigate({
        to: '/spaces/$spaceId',
        params: { spaceId: out.spaceId },
        search: { watch: out.watchId },
      })
      return
    }
    setSaved({
      id: out.watchId,
      spaceId: out.spaceId,
      spaceName: out.spaceName,
    })
    toast(
      out.cards === 0
        ? `Saved as a watch on ${out.spaceName}`
        : `Saved as a watch on ${out.spaceName} · ${String(out.cards)} in Review`,
    )
  }

  const scoped =
    table.space === null
      ? null
      : {
          id: table.space.id,
          name: table.space.name,
          criteria:
            setup?.spaces.find((s) => s.id === table.space?.id)?.criteria ??
            null,
        }

  return (
    <div className="flex h-7 items-center gap-3 border-b border-rule px-2">
      {saved === undefined ? null : <SavedWatchLine saved={saved} />}
      {offered ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={setup.engines.length === 0}
            title={
              setup.engines.length === 0
                ? 'No watch engine is running'
                : 'Keep finding these for a space'
            }
            onClick={() => setOpen(true)}
          >
            Save as watch
          </Button>
          <AddWatchDialog
            open={open}
            onOpenChange={setOpen}
            title="Save as watch"
            space={scoped}
            spaces={setup.spaces}
            newSpaceName={spaceNameFrom(question)}
            engines={setup.engines}
            prefill={prefill}
            onSave={save}
          />
        </>
      ) : null}
    </div>
  )
}
