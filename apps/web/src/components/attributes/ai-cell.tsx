import { Link, useRouter } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { readAiConfig } from '@spaces/core/ai/attribute-ai'
import type { AiAttributeLane } from '@spaces/core/ai/attribute-ai'
import {
  attributeCellStatus,
  isLaneRouted,
  openCellProposals,
  runAttributeCell,
} from '#/lib/server-fns'
import type { RegistryEntry } from './value-editor'

/**
 * AI attribute cells (SPA-72, spec-ai-substrate §13) — the per-cell trigger
 * on the record rail and in the table, for an attribute whose
 * `options.ai` is set (the spec's `attribute.config.ai`). Pull-based: a
 * person presses one cell; nothing runs on its own.
 *
 * - **No `ai` config → nothing.** `AiCell` renders its child untouched, on
 *   the rail and in the table alike, so a plain attribute's cell is the cell
 *   it always was.
 * - **Lane unrouted → no trigger** (`isLaneRouted`, the gate every AI verb
 *   hides on): classify for classify, synthesize for summarize and prompt,
 *   research for research.
 * - **An open proposal → "proposed"**: the Waiting chip's shape and mark
 *   (DESIGN.md "Waiting chip", SPA-114 — "SPA-72's proposed table cell
 *   inherits this chip"), a pointer into `/inbox` scoped to the record. It
 *   is never a verb: accept and reject live in the inbox (D44), and a
 *   pressed cell with a proposal waiting is refused by the server anyway.
 *
 * `AiCellsProvider` reads once for every record a surface shows — the
 * routed lanes and the open proposals — so a table page is two requests,
 * not one per cell. A pressed cell polls its own job until it settles.
 */

type AiCells = {
  routed: ReadonlySet<AiAttributeLane>
  proposed: ReadonlySet<string>
  running: ReadonlySet<string>
  press: (entityId: string, def: RegistryEntry) => void
}

const Ctx = createContext<AiCells | null>(null)

const proposedKey = (entityId: string, slug: string) => `${entityId}:${slug}`
const runKey = (entityId: string, attributeId: string) =>
  `${entityId}:${attributeId}`

export function AiCellsProvider({
  entityIds,
  registry,
  children,
}: {
  entityIds: ReadonlyArray<string>
  registry: ReadonlyArray<RegistryEntry>
  children: ReactNode
}) {
  const router = useRouter()
  const lanes = useMemo(
    () => [
      ...new Set(
        registry.flatMap((d) => {
          const ai = readAiConfig(d)
          return ai === null ? [] : [ai.lane]
        }),
      ),
    ],
    [registry],
  )
  const idsKey = entityIds.join(',')
  const [routed, setRouted] = useState<ReadonlySet<AiAttributeLane>>(
    () => new Set(),
  )
  const [proposed, setProposed] = useState<ReadonlySet<string>>(() => new Set())
  const [running, setRunning] = useState<ReadonlyMap<string, RegistryEntry>>(
    () => new Map(),
  )
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (lanes.length === 0) return
    void (async () => {
      const open = new Set<AiAttributeLane>()
      for (const lane of lanes) {
        try {
          const r = await isLaneRouted({ data: { lane } })
          if (r.normal || r.sensitive) open.add(lane)
        } catch {
          // A gate that cannot tell is closed: no trigger rather than a toast.
        }
      }
      if (live.current) setRouted(open)
    })()
  }, [lanes])

  const refresh = useCallback(async () => {
    if (lanes.length === 0 || idsKey === '') return
    try {
      const rows = await openCellProposals({
        data: { entityIds: idsKey.split(',') },
      })
      if (live.current)
        setProposed(new Set(rows.map((r) => proposedKey(r.entityId, r.slug))))
    } catch {
      // The cells keep their last known state.
    }
  }, [lanes.length, idsKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Each pressed cell polls its own job until it settles, then the surface
  // re-reads the proposals and the page (the rail's Waiting chip).
  useEffect(() => {
    if (running.size === 0) return
    const timer = setInterval(() => {
      for (const [key, def] of running) {
        const [entityId] = key.split(':')
        if (def.id === undefined) continue
        void attributeCellStatus({
          data: { entityId, attributeId: def.id },
        })
          .then((status) => {
            if (status.state === 'running') return
            setRunning((m) => {
              const next = new Map(m)
              next.delete(key)
              return next
            })
            if (status.state === 'failed') toast.error(status.message)
            if (status.state === 'done')
              if (status.proposed === 0)
                toast.message(`No answer for ${def.name}`)
              else toast.success(`${def.name} proposed · review in the inbox`)
            void refresh()
            void router.invalidate()
          })
          .catch(() => undefined)
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [running, refresh, router])

  const press = useCallback(
    (entityId: string, def: RegistryEntry) => {
      const attributeId = def.id
      if (attributeId === undefined) return
      const key = runKey(entityId, attributeId)
      setRunning((m) => new Map(m).set(key, def))
      const stop = () =>
        setRunning((m) => {
          const next = new Map(m)
          next.delete(key)
          return next
        })
      void runAttributeCell({ data: { entityId, attributeId } })
        .then((result) => {
          if (result.status === 'queued' || result.status === 'already-running')
            return
          stop()
          if (result.status === 'already-proposed') {
            toast.message(`${def.name} already has a proposal in the inbox`)
            void refresh()
          }
          if (result.status === 'queue-unavailable')
            toast.error('The worker queue is unreachable; try again shortly')
          if (result.status === 'refused') toast.error(result.message)
        })
        .catch((err: unknown) => {
          stop()
          toast.error(
            err instanceof Error ? err.message : `Could not run ${def.name}`,
          )
        })
    },
    [refresh],
  )

  const value = useMemo<AiCells>(
    () => ({ routed, proposed, running: new Set(running.keys()), press }),
    [routed, proposed, running, press],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * One cell: its editor, and — only when the attribute carries `options.ai`
 * and a provider is above — the trigger or the "proposed" chip beside it.
 */
export function AiCell({
  def,
  entityId,
  children,
}: {
  def: RegistryEntry
  entityId: string
  children: ReactNode
}) {
  const cells = useContext(Ctx)
  const ai = readAiConfig(def)
  if (cells === null || ai === null || def.id === undefined) return children
  const isProposed = cells.proposed.has(proposedKey(entityId, def.slug))
  const isRunning = cells.running.has(runKey(entityId, def.id))
  const routed = cells.routed.has(ai.lane)
  if (!isProposed && !routed) return children
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="min-w-0 flex-1">{children}</div>
      {isProposed ? (
        <Link
          to="/inbox"
          search={{ record: entityId, lane: 'suggestions' }}
          title={`A proposed ${def.name} is waiting in the inbox`}
          onClick={(e) => e.stopPropagation()}
          className="mention-chip focus-ring shrink-0"
        >
          <Sparkles size={12} strokeWidth={1.75} aria-hidden />
          proposed
        </Link>
      ) : (
        <button
          type="button"
          disabled={isRunning}
          aria-label={`Ask AI for ${def.name}`}
          title={
            isRunning
              ? `Asking for ${def.name}…`
              : `Ask the ${ai.lane} lane for ${def.name}; the answer lands in the inbox as a suggestion`
          }
          onClick={(e) => {
            e.stopPropagation()
            cells.press(entityId, def)
          }}
          className="focus-ring flex size-6 shrink-0 items-center justify-center rounded-md text-graphite transition-colors duration-150 ease-out-quart hover:bg-bone hover:text-foreground disabled:animate-pulse disabled:hover:bg-transparent"
        >
          <Sparkles className="size-3" strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  )
}
