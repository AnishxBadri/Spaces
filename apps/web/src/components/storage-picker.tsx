import { useEffect, useRef, useState } from 'react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { mintPickerToken, pickerReadiness } from '#/lib/server-fns'
import type {
  FakePickerFile,
  MintPickerOutcome,
  PickedFile,
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
  readonly ViewId: { readonly DOCS: string }
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

function openGooglePicker(
  api: GooglePickerApi,
  session: GoogleSession,
  onResult: (result: PickResult) => void,
): GooglePicker {
  const builder = new api.PickerBuilder()
    .enableFeature(api.Feature.MULTISELECT_ENABLED)
    .enableFeature(api.Feature.SUPPORT_DRIVES)
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
  }
  for (const view of session.views) builder.addView(views[view]())
  return builder.build().setVisible(true)
}

type Readiness = Awaited<ReturnType<typeof pickerReadiness>>

type Session =
  | { readonly kind: 'google'; readonly session: GoogleSession }
  | { readonly kind: 'fake'; readonly files: ReadonlyArray<FakePickerFile> }

const LABEL = 'Attach from Drive'

/** The Files tab's "Attach from Drive", in whatever state the user's Drive is in. */
export function StoragePicker({
  onPicked,
}: {
  onPicked: (files: ReadonlyArray<PickedFile>) => void
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [opening, setOpening] = useState(false)
  const [session, setSession] = useState<Session | null>(null)

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

  /** The picker closed: the session and its token go, and a pick is attached. */
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
        picker = openGooglePicker(api, session.session, (result) =>
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
  }, [session])

  async function open() {
    setOpening(true)
    try {
      const outcome = await mintPickerToken({
        data: { provider: 'google', returnTo: window.location.pathname },
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
          setReadiness(outcome)
          toast.error(outcome.reason)
          return
        case 'unconfigured':
          setReadiness({ ...outcome, settingsHref: null })
          toast.error(outcome.reason)
          return
      }
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : 'Could not open the picker'
      setReadiness({ _tag: 'refused', reason })
      toast.error(reason)
    } finally {
      setOpening(false)
    }
  }

  return (
    <>
      <PickerButton readiness={readiness} opening={opening} onOpen={open} />
      {session?.kind === 'fake' ? (
        <FakePickList files={session.files} onResult={settle} />
      ) : null}
    </>
  )
}

const BUTTON = 'shrink-0'

/** The button itself: open, Connect, re-consent, not set up, or refused in a tooltip. */
export function PickerButton({
  readiness,
  opening,
  onOpen,
}: {
  readiness: Readiness | null
  opening: boolean
  onOpen: () => void
}) {
  const explained = (label: string, reason: string, href: string | null) => (
    <Tooltip>
      <TooltipTrigger asChild>
        {href === null ? (
          <span
            tabIndex={0}
            aria-disabled="true"
            className="focus-ring inline-flex h-6 shrink-0 cursor-default items-center rounded-md border border-rule bg-paper px-2 text-label text-graphite"
          >
            {label}
          </span>
        ) : (
          <Button asChild size="xs" variant="outline" className={BUTTON}>
            <a href={href}>{label}</a>
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{reason}</TooltipContent>
    </Tooltip>
  )

  switch (readiness?._tag) {
    case 'connect':
      return (
        <Button asChild size="xs" variant="outline" className={BUTTON}>
          <a href={readiness.href}>{readiness.label}</a>
        </Button>
      )
    case 'consent':
      return explained(
        `${LABEL}…`,
        'Google asks once more, for the files you pick.',
        readiness.href,
      )
    case 'unconfigured':
      return explained(
        'Picker not set up',
        readiness.reason,
        readiness.settingsHref,
      )
    case 'refused':
      return explained(LABEL, readiness.reason, null)
    case 'ready':
    case undefined:
      return (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className={BUTTON}
          pending={opening}
          disabled={opening}
          onClick={onOpen}
        >
          {LABEL}
        </Button>
      )
  }
}

/** The fake picker: the fake Drive's files as a pick list, in our own sheet. */
export function FakePickList({
  files,
  onResult,
}: {
  files: ReadonlyArray<FakePickerFile>
  onResult: (result: PickResult) => void
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const chosen = files.filter((f) => picked.has(f.id))

  const toggle = (id: string, on: boolean) =>
    setPicked((all) => {
      const next = new Set(all)
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{LABEL}</DialogTitle>
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
            chosen.length === 0
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
            {chosen.length === 0 ? 'Attach' : `Attach ${chosen.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
