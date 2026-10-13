import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  linkDriveFolder,
  linkFolderStatus,
  listRecordBindings,
  unlinkDriveFolder,
} from '#/lib/server-fns'
import type { BoundFolderRow, FolderPick } from '#/lib/server-fns'
import { DEFAULT_FOLDER_OPTIONS } from './link-folder-dialog'
import type { FolderOptions } from './link-folder-dialog'

/**
 * Link a Drive folder on one record: its bindings, the bind (a worker job,
 * polled until it binds or is refused), the consent detour, and Unlink.
 * - Google's consent for `drive.readonly` leaves the page; the folder and
 *   options wait in sessionStorage, the dance returns to this record's Files
 *   tab, and the window reopens there.
 * - A queued bind is polled whether or not the window stays open, so a
 *   folder linked behind a closed window still appears.
 */

const POLL_MS = 1500

/** The Link folder window while it is open. */
export type FolderLinking = {
  readonly folder: FolderPick
  /** The window's mono title: the folder's name, or the link pasted. */
  readonly title: string
  readonly initial: FolderOptions
  /** The bind is on its way: sent, or queued and polled by `bindId`. */
  readonly busy: boolean
  readonly bindId: string | null
  readonly refusal: string | null
}

const PENDING_KEY = 'spaces.link-folder'

/** This page with the Files tab open: where a consent dance comes back to. */
export function filesTabPath(href: string): string {
  const url = new URL(href)
  url.searchParams.set('tab', 'files')
  return `${url.pathname}${url.search}`
}

const pendingSchema = z.object({
  entityId: z.string(),
  folder: z.union([
    z.object({ url: z.string() }),
    z.object({ id: z.string() }),
  ]),
  title: z.string(),
  options: z.object({
    mapSubfolders: z.boolean(),
    retain: z.enum(['full', 'text']),
    direction: z.literal('pull'),
    sensitivity: z.enum(['inherit', 'sensitive']),
  }),
})

/** The bind a consent detour left for this record, taken once. */
function takePending(entityId: string): FolderLinking | null {
  const raw = window.sessionStorage.getItem(PENDING_KEY)
  if (raw === null) return null
  window.sessionStorage.removeItem(PENDING_KEY)
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = pendingSchema.safeParse(json)
  if (!parsed.success || parsed.data.entityId !== entityId) return null
  return {
    folder: parsed.data.folder,
    title: parsed.data.title,
    initial: parsed.data.options,
    busy: false,
    bindId: null,
    refusal: null,
  }
}

export function useFolderLink(entityId: string) {
  const router = useRouter()
  const [bindings, setBindings] = useState<ReadonlyArray<BoundFolderRow>>([])
  const [canLink, setCanLink] = useState(false)
  const [linking, setLinking] = useState<FolderLinking | null>(null)
  // The bind being polled; outlives the window.
  const [polling, setPolling] = useState<string | null>(null)
  // Whether the window is still open when a bind settles.
  const openRef = useRef(false)
  openRef.current = linking !== null

  const refresh = useCallback(async () => {
    try {
      const answer = await listRecordBindings({ data: { entityId } })
      setBindings(answer.bindings)
      setCanLink(answer.canLink)
    } catch {
      // A tab that cannot ask offers no folder and draws no band.
    }
  }, [entityId])

  useEffect(() => {
    void refresh()
    setLinking(takePending(entityId))
  }, [entityId, refresh])

  const open = (folder: FolderPick, title: string) =>
    setLinking({
      folder,
      title,
      initial: DEFAULT_FOLDER_OPTIONS,
      busy: false,
      bindId: null,
      refusal: null,
    })

  const settled = useCallback(
    (refusal: string | null) => {
      setPolling(null)
      if (refusal !== null) {
        // Closed meanwhile: the refusal has no window to stay in.
        if (!openRef.current) toast.error(refusal)
        setLinking((l) =>
          l === null ? l : { ...l, busy: false, bindId: null, refusal },
        )
        return
      }
      setLinking(null)
      toast.success('Folder linked')
      void refresh()
      void router.invalidate()
    },
    [refresh, router],
  )

  async function link(options: FolderOptions) {
    if (linking === null) return
    const { folder, title } = linking
    setLinking({
      ...linking,
      initial: options,
      busy: true,
      bindId: null,
      refusal: null,
    })
    try {
      const outcome = await linkDriveFolder({
        data: {
          folder,
          attachTo: entityId,
          options,
          returnTo: filesTabPath(window.location.href),
        },
      })
      switch (outcome._tag) {
        case 'queued':
          setPolling(outcome.bindId)
          setLinking((l) => (l === null ? l : { ...l, bindId: outcome.bindId }))
          return
        case 'consent':
          window.sessionStorage.setItem(
            PENDING_KEY,
            JSON.stringify({ entityId, folder, title, options }),
          )
          window.location.assign(outcome.href)
          return
        case 'connect':
          window.location.assign(outcome.href)
          return
        case 'refused':
          settled(outcome.reason)
          return
      }
    } catch (err) {
      settled(err instanceof Error ? err.message : 'Could not link this folder')
    }
  }

  const bindId = polling
  useEffect(() => {
    if (bindId === null) return
    let stopped = false
    const timer = setInterval(() => {
      void linkFolderStatus({ data: { bindIds: [bindId] } }).then(
        (status) => {
          if (stopped || !Object.hasOwn(status, bindId)) return
          const now = status[bindId]
          if (now.state === 'done') settled(null)
          if (now.state === 'failed') settled(now.reason)
        },
        () => undefined,
      )
    }, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [bindId, settled])

  async function unlink(bindingId: string) {
    try {
      await unlinkDriveFolder({ data: { bindingId } })
      toast.success('Folder unlinked')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not unlink this folder',
      )
    }
    void refresh()
    void router.invalidate()
  }

  return {
    bindings,
    canLink,
    linking,
    open,
    close: () => setLinking(null),
    link: (options: FolderOptions) => void link(options),
    unlink: (bindingId: string) => void unlink(bindingId),
  }
}
