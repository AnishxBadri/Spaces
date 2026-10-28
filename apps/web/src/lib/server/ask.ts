import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

export type {
  AskCall,
  AskCardKind,
  AskCardView,
  AskEvent,
  AskFindRow,
  AskFindTable,
  AskRef,
  AskSavedWatch,
  AskScopeChip,
  AskThreadRow,
  AskThreadView,
  AskTurnState,
  AskTurnView,
  AskVia,
} from '../ask/types'
export type { FindActed } from '../ask/find'
export type { SaveWatchResult, WatchSpace } from '../ask/save-watch'
export type { WebSource } from '../ask/mount'
export type { AskRefPreview } from '../ask/ref-preview'

/**
 * Ask's server fns: a turn streamed as `AskEvent`s, and the thread store —
 * every one keyed on the signed-in user, whose threads alone it reads.
 * Programs are imported inside the handlers so their database code never
 * reaches the client bundle.
 */

const scopeChip = z.object({
  kind: z.enum(['record', 'space', 'person', 'view', 'file', 'page', 'web']),
  id: z.uuid().nullable(),
  name: z.string().min(1).max(300),
  href: z.string().max(500).nullable(),
})

/** One turn, streamed: the rows, the route, calls and text, then the stored turn. */
export const askQuestion = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      threadId: z.uuid().nullable(),
      question: z.string().trim().min(1).max(4000),
      // Four chips the reader chose, and the web.
      scope: z.array(scopeChip).max(5),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { askStream } = await import('../ask/turn')
    return askStream({
      userId: user.id,
      threadId: data.threadId,
      question: data.question,
      scope: data.scope,
    })
  })

const byThread = z.object({ threadId: z.uuid() })

async function run<T>(f: () => Promise<T>): Promise<T> {
  const { askMessage } = await import('../ask/threads')
  try {
    return await f()
  } catch (failure) {
    throw new Error(askMessage(failure))
  }
}

export const listAskThreads = createServerFn().handler(async () => {
  const user = await requireUser()
  const { listThreadsProgram } = await import('../ask/threads')
  const { effectFn } = await import('./effect')
  return run(() => effectFn(listThreadsProgram)(user.id))
})

export const getAskThread = createServerFn()
  .validator(byThread)
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { getThreadProgram } = await import('../ask/threads')
    const { effectFn } = await import('./effect')
    return run(() => effectFn(getThreadProgram)(user.id, data.threadId))
  })

export const renameAskThread = createServerFn({ method: 'POST' })
  .validator(byThread.extend({ title: z.string().trim().min(1).max(200) }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { renameThreadProgram } = await import('../ask/threads')
    const { effectFn } = await import('./effect')
    return run(() =>
      effectFn(renameThreadProgram)(user.id, data.threadId, data.title),
    )
  })

/** What a delete takes with it, printed in the confirm's foot. */
export const getAskThreadCounts = createServerFn()
  .validator(byThread)
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { threadCountsProgram } = await import('../ask/threads')
    const { effectFn } = await import('./effect')
    return run(() => effectFn(threadCountsProgram)(user.id, data.threadId))
  })

export const deleteAskThread = createServerFn({ method: 'POST' })
  .validator(byThread)
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { deleteThreadProgram } = await import('../ask/threads')
    const { effectFn } = await import('./effect')
    return run(() => effectFn(deleteThreadProgram)(user.id, data.threadId))
  })

/** "Save as note": one answer, filed on the records it cited. */
export const saveAskAnswerAsNote = createServerFn({ method: 'POST' })
  .validator(z.object({ turnId: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { saveAnswerNoteProgram } = await import('../ask/threads')
    const { effectFn } = await import('./effect')
    return run(() => effectFn(saveAnswerNoteProgram)(user.id, data.turnId))
  })

/**
 * A citation's passage for its hover: the chunk, note, body or value the ref
 * names, read as the reader — null when they may not read it.
 */
export const previewAskRef = createServerFn()
  .validator(z.object({ ref: z.string().min(1).max(300) }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { askRefPreviewProgram } = await import('../ask/ref-preview')
    const { effectFn } = await import('./effect')
    return run(() => effectFn(askRefPreviewProgram)(user.id, data.ref))
  })

const byCard = z.object({ suggestionId: z.uuid() })

/**
 * An action card's two verbs, as the reader. Apply runs the writer a person
 * would — the task writer, the stage write, the one tag insert — and answers
 * the card with its outcome; Skip closes it and writes nothing.
 */
export const applyAskCard = createServerFn({ method: 'POST' })
  .validator(byCard)
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { applyCardProgram } = await import('../ask/card-store')
    const { effectFn } = await import('./effect')
    return run(() => effectFn(applyCardProgram)(user.id, data.suggestionId))
  })

export const skipAskCard = createServerFn({ method: 'POST' })
  .validator(byCard)
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { skipCardProgram } = await import('../ask/card-store')
    const { effectFn } = await import('./effect')
    return run(() => effectFn(skipCardProgram)(user.id, data.suggestionId))
  })

/**
 * The plugins whose MCP servers a turn can mount: what lights the dock's
 * web chip and the space head's Find companies.
 */
export const askWebSources = createServerFn().handler(async () => {
  await requireUser()
  const { webSourcesProgram } = await import('../ask/mount')
  const { effectFn } = await import('./effect')
  return run(() => effectFn(webSourcesProgram)())
})

/**
 * A Find row's verbs, as the reader, on a row of their own answer: Add,
 * Add and file here / File here (`file`), or Dismiss for the space.
 */
export const actOnFindRow = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      turnId: z.uuid(),
      domain: z.string().min(1).max(253),
      act: z.enum(['add', 'file', 'dismiss']),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const {
      addFindRowProgram,
      dismissFindRowProgram,
      fileFindRowProgram,
      findMessage,
    } = await import('../ask/find')
    const { effectFn } = await import('./effect')
    try {
      if (data.act === 'dismiss') {
        await effectFn(dismissFindRowProgram)(user.id, data.turnId, data.domain)
        return { act: 'dismiss' as const, acted: null }
      }
      const acted =
        data.act === 'add'
          ? await effectFn(addFindRowProgram)(user.id, data.turnId, data.domain)
          : await effectFn(fileFindRowProgram)(
              user.id,
              data.turnId,
              data.domain,
            )
      return { act: data.act, acted }
    } catch (failure) {
      throw new Error(findMessage(failure))
    }
  })

/** What a Find table's Save as watch window offers: engines and spaces. */
export const getSaveWatchSetup = createServerFn().handler(async () => {
  await requireUser()
  const { saveWatchSetupProgram } = await import('../ask/save-watch')
  const { effectFn } = await import('./effect')
  return effectFn(saveWatchSetupProgram)()
})

/**
 * Save as watch on a Find table: one `space_watch`, the table's untouched
 * rows as cards under the space, and the thread's link. The same lens again
 * comes back as `exists`, naming the watch, and writes nothing.
 */
export const saveFindAsWatch = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      turnId: z.uuid(),
      callIndex: z.int().min(0),
      space: z.union([
        z.object({ id: z.uuid() }),
        z.object({ create: z.string().trim().min(1).max(300) }),
      ]),
      integrationId: z.uuid(),
      values: z.record(z.string(), z.union([z.string(), z.boolean()])),
      cadenceMinutes: z.int().positive().nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { saveFindAsWatchProgram, saveWatchMessage } =
      await import('../ask/save-watch')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(saveFindAsWatchProgram)(user.id, data)
    } catch (failure) {
      throw new Error(saveWatchMessage(failure))
    }
  })
