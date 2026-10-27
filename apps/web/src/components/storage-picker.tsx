import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import type { MoreMenuAction } from './ui/more-menu'
import { filesTabPath } from './files/use-folder-link'
import { mintPickerToken, pickerReadiness } from '#/lib/server-fns'
import type {
  FakePickerFile,
  MintPickerOutcome,
  PickedFile,
  PickerMode,
  PickerView,
} from '#/lib/server-fns'

/**
 * "Attach from Drive": the generic host for a provider's own picker.
 * - The provider's script is loaded at click time from the URL the mint
 *   names; nothing of the provider is bundled, and no plugin code is here.
 * - The token lives in this component's state for one picker and is dropped
 *   when it closes — never stored, never put in a URL.
 * - Under the fake providers the mint lists the fake Drive's files and this
 *   draws them as an in-app pick list instead.
 */

/** The globals Google's `api.js` defines, as far as this host touches them. */
type GoogleDocsView = {
  setIncludeFolders: (on: boolean) => GoogleDocsView
  setSelectFolderEnabled: (on: boolean) => GoogleDocsView
  setEnableDrives: (on: boolean) => GoogleDocsView
  setMimeTypes: (mimeTypes: string) => GoogleDocsView
}
type GooglePicker = {
  setVisible: (on: boolean) => GooglePicker
  dispose: () => void
}
type GooglePickerBuilder = {
  addView: (view: GoogleDocsView) => GooglePickerBuilder
  enableFeature: (feature: string) => GooglePickerBuilder
  setOAuthToken: (token: string) => GooglePickerBuilder
  setDeveloperKey: (key: string) => GooglePickerBuilder
  setAppId: (appId: string) => GooglePickerBuilder
  setCallback: (
    callback: (data: { readonly [key: string]: unknown }) => void,
  ) => GooglePickerBuilder
  build: () => GooglePicker
}
export type GooglePickerKeys = {
  readonly Action: { readonly PICKED: string; readonly CANCEL: string }
  readonly Response: { readonly ACTION: string; readonly DOCUMENTS: string }
  readonly Document: { readonly ID: string; readonly NAME: string }
}
type GooglePickerApi = GooglePickerKeys & {
  readonly PickerBuilder: new () => GooglePickerBuilder
  readonly DocsView: new (viewId?: string) => GoogleDocsView
  readonly ViewId: { readonly DOCS: string; readonly FOLDERS: string }
  readonly Feature: {
    readonly MULTISELECT_ENABLED: string
    readonly SUPPORT_DRIVES: string
  }
}

declare global {
  interface Window {
    gapi?: {
      load: (
        name: string,
        options: { callback: () => void; onerror: () => void },
      ) => void
    }
    google?: { picker?: GooglePickerApi }
  }
}

/** What a picker answered: files picked, or a close with nothing. */
export type PickResult =
  | { readonly kind: 'picked'; readonly files: ReadonlyArray<PickedFile> }
  | { readonly kind: 'cancel' }

/** Google's callback data as a pick; null for a callback that is neither (`loaded`). */
export function readGooglePick(
  keys: GooglePickerKeys,
  data: { readonly [key: string]: unknown },
): PickResult | null {
  const action = data[keys.Response.ACTION]
  if (action === keys.Action.CANCEL) return { kind: 'cancel' }
  if (action !== keys.Action.PICKED) return null
  const docs = data[keys.Response.DOCUMENTS]
  const files: Array<PickedFile> = []
  if (Array.isArray(docs))
    for (const doc of docs) {
      if (typeof doc !== 'object' || doc === null) continue
      const id: unknown = Reflect.get(doc, keys.Document.ID)
      const name: unknown = Reflect.get(doc, keys.Document.NAME)
      if (typeof id === 'string' && typeof name === 'string')
        files.push({ id, name })
    }
  return { kind: 'picked', files }
}

const scripts = new Map<string, Promise<GooglePickerApi>>()

/** Google's picker API, its script added once per page at first use. */
function loadGooglePicker(scriptUrl: string): Promise<GooglePickerApi> {
  const loaded = scripts.get(scriptUrl)
  if (loaded !== undefined) return loaded
  const loading = new Promise<GooglePickerApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = scriptUrl
    script.async = true
    script.onerror = () => reject(new Error('Google’s picker did not load'))
    script.onload = () => {
      const gapi = window.gapi
      if (gapi === undefined) {
        reject(new Error('Google’s picker did not load'))
        return
      }
      gapi.load('picker', {
        callback: () => {
          const api = window.google?.picker
          if (api === undefined) reject(new Error('Google’s picker is missing'))
          else resolve(api)
        },
        onerror: () => reject(new Error('Google’s picker did not load')),
      })
    }
    document.head.appendChild(script)
  })
  loading.catch(() => scripts.delete(scriptUrl))
  scripts.set(scriptUrl, loading)
  return loading
}

type GoogleSession = Extract<MintPickerOutcome, { readonly _tag: 'ok' }>

const FOLDER_MIME = 'application/vnd.google-apps.folder'

function openGooglePicker(
  api: GooglePickerApi,
  session: GoogleSession,
  mode: PickerMode,
  onResult: (result: PickResult) => void,
): GooglePicker {
  const builder = new api.PickerBuilder().enableFeature(
    api.Feature.SUPPORT_DRIVES,
  )
  // Files are picked several at a time; a folder is linked one at a time.
  if (mode === 'files') builder.enableFeature(api.Feature.MULTISELECT_ENABLED)
  builder
    .setOAuthToken(session.token)
    .setDeveloperKey(session.developerKey)
    .setAppId(session.appId)
    .setCallback((data) => {
      const result = readGooglePick(api, data)
      if (result !== null) onResult(result)
    })
  const views: Record<PickerView, () => GoogleDocsView> = {
    DOCS: () =>
      new api.DocsView(api.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false),
    SHARED_DRIVES: () => new api.DocsView().setEnableDrives(true),
    FOLDERS: () =>
      new api.DocsView(api.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes(FOLDER_MIME),
  }
  for (const view of session.views) builder.addView(views[view]())
  return builder.build().setVisible(true)
}

export type Readiness = Awaited<ReturnType<typeof pickerReadiness>>

type Session =
  | { readonly kind: 'google'; readonly session: GoogleSession }
  | { readonly kind: 'fake'; readonly files: ReadonlyArray<FakePickerFile> }

const LABEL = 'Attach from Drive'

/**
 * The user's Drive picker state, asked once on mount. Held by the Files
 * tab, whose add row's `···` offers Attach from Drive from it.
 */
export function usePickerReadiness(): [
  Readiness | null,
  (next: Readiness) => void,
] {
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  useEffect(() => {
    let stale = false
    pickerReadiness({
      data: { provider: 'google', returnTo: window.location.pathname },
    }).then(
      (answer) => {
        if (!stale) setReadiness(answer)
      },
      () => undefined,
    )
    return () => {
      stale = true
    }
  }, [])
  return [readiness, setReadiness]
}

/**
 * One opening of the provider's picker: the mint, then Google's picker or
 * the fake's pick list, in files or folders mode. A Connect or re-consent
 * navigates; a refusal is a toast, and `onBlocked` hears it.
 */
export function usePickerSession({
  mode,
  onPicked,
  onBlocked = () => undefined,
}: {
  mode: PickerMode
  onPicked: (files: ReadonlyArray<PickedFile>) => void
  onBlocked?: (readiness: Readiness) => void
}): { open: () => Promise<void>; opening: boolean; sheet: ReactNode } {
  const [opening, setOpening] = useState(false)
  const [session, setSession] = useState<Session | null>(null)

  /** The picker closed: the session and its token go, and a pick is handed on. */
  const settle = (result: PickResult) => {
    setSession(null)
    if (result.kind === 'picked' && result.files.length > 0)
      onPicked(result.files)
  }
  // An open Google picker answers through the latest render's `settle`.
  const settleRef = useRef(settle)
  settleRef.current = settle

  useEffect(() => {
    if (session?.kind !== 'google') return
    let closed = false
    let picker: GooglePicker | null = null
    loadGooglePicker(session.session.scriptUrl).then(
      (api) => {
        if (closed) return
        picker = openGooglePicker(api, session.session, mode, (result) =>
          settleRef.current(result),
        )
      },
      (err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : 'Google’s picker did not load',
        )
        setSession(null)
      },
    )
    return () => {
      closed = true
      picker?.dispose()
    }
  }, [session, mode])

  async function open() {
    setOpening(true)
    try {
      const outcome = await mintPickerToken({
        data: {
          provider: 'google',
          returnTo: filesTabPath(window.location.href),
          mode,
        },
      })
      switch (outcome._tag) {
        case 'ok':
          setSession({ kind: 'google', session: outcome })
          return
        case 'fake':
          setSession({ kind: 'fake', files: outcome.files })
          return
        case 'connect':
        case 'consent':
          window.location.assign(outcome.href)
          return
        case 'refused':
          onBlocked(outcome)
          toast.error(outcome.reason)
          return
        case 'unconfigured':
          onBlocked({ ...outcome, settingsHref: null })
          toast.error(outcome.reason)
          return
      }
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : 'Could not open the picker'
      onBlocked({ _tag: 'refused', reason })
      toast.error(reason)
    } finally {
      setOpening(false)
    }
  }

  const sheet =
    session?.kind === 'fake' ? (
      <FakePickList files={session.files} mode={mode} onResult={settle} />
    ) : null
  return { open, opening, sheet }
}

/**
 * The Files tab's "Attach from Drive", as an item of the add row's `···`:
 * the picker once Drive is connected, Google's re-consent when it asks once
 * more. Null with no Drive connection, before the answer, and while the
 * picker is not set up — a missing setup is never a control.
 */
export function attachFromDriveItem(
  readiness: Readiness | null,
  picker: { open: () => Promise<void>; opening: boolean },
): MoreMenuAction | null {
  switch (readiness?._tag) {
    case 'ready':
      return {
        label: LABEL,
        disabled: picker.opening,
        opens: true,
        onSelect: () => void picker.open(),
      }
    case 'consent':
      return {
        label: `${LABEL}…`,
        title: 'Google asks once more, for the files you pick.',
        onSelect: () => window.location.assign(readiness.href),
      }
    default:
      return null
  }
}

/** The fake picker: the fake Drive's files as a pick list, in our own sheet. */
export function FakePickList({
  files,
  mode = 'files',
  onResult,
}: {
  files: ReadonlyArray<FakePickerFile>
  /** `folders`: one folder is picked, to link. */
  mode?: PickerMode
  onResult: (result: PickResult) => void
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const chosen = files.filter((f) => picked.has(f.id))
  const folders = mode === 'folders'

  const toggle = (id: string, on: boolean) =>
    setPicked((all) => {
      const next = new Set(folders ? [] : all)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onResult({ kind: 'cancel' })
      }}
    >
      <DialogContent size="m">
        <DialogHeader>
          <DialogTitle>{folders ? 'Link a folder' : LABEL}</DialogTitle>
          <DialogDescription>fake Drive</DialogDescription>
        </DialogHeader>
        <ul className="-mx-5 -my-5 max-h-80 overflow-y-auto">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex h-9 items-center gap-2.5 border-t border-rule px-5 text-ui first:border-t-0"
            >
              <Checkbox
                checked={picked.has(f.id)}
                onCheckedChange={(on) => toggle(f.id, on)}
                aria-label={`Pick ${f.name}`}
              />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              {f.path === null ? null : (
                <span className="min-w-0 shrink truncate mono text-micro text-graphite">
                  {f.path}
                </span>
              )}
            </li>
          ))}
        </ul>
        <DialogFooter
          note={
            folders
              ? null
              : chosen.length === 0
                ? 'nothing picked'
                : `${chosen.length} picked · copied onto this record`
          }
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => onResult({ kind: 'cancel' })}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={chosen.length === 0}
            onClick={() =>
              onResult({
                kind: 'picked',
                files: chosen.map((f) => ({ id: f.id, name: f.name })),
              })
            }
          >
            {folders
              ? 'Choose'
              : chosen.length === 0
                ? 'Attach'
                : `Attach ${chosen.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
