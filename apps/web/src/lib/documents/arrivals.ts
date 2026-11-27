import { useSyncExternalStore } from 'react'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import { findStoredDocument } from '#/lib/server-fns'
import { sha256Hex, uploadDocument } from './upload'

/**
 * Files added without a dialog: each lands at once as a row in the Files
 * page's `Unfiled` band and shows its own progress, then the row the list
 * reads takes its place.
 * - A client module: the server-fns barrel and `upload` only.
 * - The store is module state, so an upload outlives the page it started
 *   on; the Files page shows whatever is still here when it mounts.
 * - One file at a time, across every drop: a file dropped twice is asked
 *   about after the first copy has landed, so it reads `Already here`
 *   rather than landing twice.
 */

/** The file the reader may read with the same bytes, as `Already here` names it. */
export type StoredDocument = NonNullable<
  Awaited<ReturnType<typeof findStoredDocument>>
>

export type ArrivalState =
  /** Waiting its turn, being read, or being sent; 0 to 1. */
  | { readonly kind: 'uploading'; readonly progress: number }
  /** The row exists; the list shows it once it is read again. */
  | { readonly kind: 'landed'; readonly documentId: string }
  /** Its bytes are already here; nothing was stored. */
  | { readonly kind: 'already'; readonly existing: StoredDocument }
  /** Refused before anything was stored: `larger than 250 MB`. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The upload itself failed. */
  | { readonly kind: 'failed'; readonly reason: string }

export type Arrival = {
  readonly key: string
  readonly name: string
  readonly mime: string | null
  readonly sizeBytes: number
  readonly state: ArrivalState
}

/** Why a file is not added at all, before it is read; null when it may be. */
export function refusalOf(file: { readonly size: number }): string | null {
  if (file.size > MAX_UPLOAD_BYTES)
    return `larger than ${formatBytes(MAX_UPLOAD_BYTES)}`
  if (file.size === 0) return 'the file is empty'
  return null
}

/**
 * One file, unfiled: refuse it on size, take its digest, ask whether the
 * reader can already read a file with those bytes, and only then store it.
 * Resolves to the state its row ends in; an upload failure rejects.
 */
export async function addFile(
  file: File,
  {
    onProgress,
    signal,
  }: {
    onProgress: (fraction: number) => void
    signal?: AbortSignal | undefined
  },
): Promise<ArrivalState> {
  const refusal = refusalOf(file)
  if (refusal !== null) return { kind: 'refused', reason: refusal }
  const sha = await sha256Hex(file)
  signal?.throwIfAborted()
  const existing = await findStoredDocument({ data: { sha } })
  if (existing !== null) return { kind: 'already', existing }
  const born = await uploadDocument({
    file,
    sha,
    fileAgainst: [],
    onPhase: (phase) => {
      if (phase === 'filing') onProgress(1)
    },
    onProgress,
    ...(signal === undefined ? {} : { signal }),
  })
  return { kind: 'landed', documentId: born.id }
}

const NONE: ReadonlyArray<Arrival> = []
let arrivals: ReadonlyArray<Arrival> = NONE
/** How many files have landed, so a reader of the list knows to look again. */
let landings = 0
let turn: Promise<void> = Promise.resolve()
const controllers = new Map<string, AbortController>()
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function emit() {
  for (const l of listeners) l()
}

function settle(key: string, state: ArrivalState) {
  // A row dismissed while its upload ran has nothing to update.
  if (!arrivals.some((a) => a.key === key)) return
  arrivals = arrivals.map((a) => (a.key === key ? { ...a, state } : a))
  if (state.kind === 'landed') landings += 1
  emit()
}

async function run(key: string, file: File, controller: AbortController) {
  if (controller.signal.aborted) return
  try {
    settle(
      key,
      await addFile(file, {
        onProgress: (progress) => settle(key, { kind: 'uploading', progress }),
        signal: controller.signal,
      }),
    )
  } catch (err) {
    // A cancel took the row away first, so its abort settles nothing.
    settle(key, {
      kind: 'failed',
      reason: err instanceof Error ? err.message : 'Upload failed',
    })
  } finally {
    controllers.delete(key)
  }
}

/** Add files, unfiled: each is a row at once, and they upload in turn. */
export function addFiles(files: Iterable<File>) {
  const added: Array<Arrival> = []
  for (const file of files) {
    const key = `${file.name}-${String(file.size)}-${String(Math.random())}`
    const refusal = refusalOf(file)
    added.push({
      key,
      name: file.name,
      mime: file.type === '' ? null : file.type,
      sizeBytes: file.size,
      // A refusal needs no turn: nothing is read or sent.
      state:
        refusal === null
          ? { kind: 'uploading', progress: 0 }
          : { kind: 'refused', reason: refusal },
    })
    if (refusal !== null) continue
    const controller = new AbortController()
    controllers.set(key, controller)
    turn = turn.then(() => run(key, file, controller))
  }
  if (added.length === 0) return
  arrivals = [...arrivals, ...added]
  emit()
}

/** Take a row away; an upload still running is cancelled. */
export function dismissArrival(key: string) {
  controllers.get(key)?.abort()
  controllers.delete(key)
  arrivals = arrivals.filter((a) => a.key !== key)
  emit()
}

/** The rows still arriving, in the order they were added. */
export function useArrivals(): ReadonlyArray<Arrival> {
  return useSyncExternalStore(
    subscribe,
    () => arrivals,
    () => NONE,
  )
}

/** A count that moves each time a file lands. */
export function useLandings(): number {
  return useSyncExternalStore(
    subscribe,
    () => landings,
    () => 0,
  )
}

let chooser: (() => void) | null = null

/**
 * The app shell's file input registers here, so any surface can open the
 * system's file chooser without a dialog of its own.
 */
export function registerFileChooser(open: () => void): () => void {
  chooser = open
  return () => {
    if (chooser === open) chooser = null
  }
}

/** Open the system's file chooser; the files picked land on the Files page. */
export function chooseFilesToAdd() {
  chooser?.()
}
