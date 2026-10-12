import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

export type {
  AskCall,
  AskEvent,
  AskRef,
  AskScopeChip,
  AskThreadRow,
  AskThreadView,
  AskTurnState,
  AskTurnView,
} from '../ask/types'

/**
 * Ask's server fns: a turn streamed as `AskEvent`s, and the thread store —
 * every one keyed on the signed-in user, whose threads alone it reads. (D70)
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
      scope: z.array(scopeChip).max(4),
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
