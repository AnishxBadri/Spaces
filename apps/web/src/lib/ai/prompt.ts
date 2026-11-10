import type { ModelMessage, SystemModelMessage } from 'ai'
import type { ContextItem } from '@spaces/core/context/types'

/**
 * The user part's renderer behind `complete()`: `[ref] text` blocks, then the
 * task — the call's variable part, last. Pure: no clock, no randomness, no I/O — the same items, task and
 * budget always render the same string.
 *
 * - Each item renders once, as `[ref] text`, so the model can cite what it
 *   read by the ref the assembler minted. A second item with a ref already
 *   rendered is dropped: one ref, one block.
 * - Items render in the order given — the assembler's rank order — so a
 *   budget cut drops the least relevant context first.
 * - The whole prompt, task included, is at most `budgetChars` long. The task
 *   is reserved first (a prompt without its question is useless); the
 *   context fills what is left, whole blocks while they fit, and the block
 *   that overflows is cut with `…` if its `[ref] ` and one character of text
 *   still fit, else dropped. Nothing after it renders.
 */

const BLOCK_SEPARATOR = '\n\n'
const ELLIPSIS = '…'

export type RenderPromptInput = {
  items: ReadonlyArray<ContextItem>
  task: string
  budgetChars: number
}

export function renderBlock(item: Pick<ContextItem, 'ref' | 'text'>): string {
  return `[${item.ref}] ${item.text}`
}

export function renderPrompt({
  items,
  task,
  budgetChars,
}: RenderPromptInput): string {
  const budget = Math.max(0, Math.floor(budgetChars))
  if (task.length >= budget) return task.slice(0, budget)

  // What the context may spend: the budget less the task and the separator
  // that joins them. With no task there is nothing to join.
  let remaining =
    task === '' ? budget : budget - task.length - BLOCK_SEPARATOR.length
  const blocks: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.ref)) continue
    seen.add(item.ref)
    const cost = blocks.length === 0 ? 0 : BLOCK_SEPARATOR.length
    const room = remaining - cost
    const block = renderBlock(item)
    if (block.length <= room) {
      blocks.push(block)
      remaining = room - block.length
      continue
    }
    const head = `[${item.ref}] `
    if (room >= head.length + 1 + ELLIPSIS.length) {
      blocks.push(block.slice(0, room - ELLIPSIS.length) + ELLIPSIS)
    }
    break
  }
  if (blocks.length === 0) return task
  if (task === '') return blocks.join(BLOCK_SEPARATOR)
  return blocks.join(BLOCK_SEPARATOR) + BLOCK_SEPARATOR + task
}

/** One file part of a call: sent after the text of the last user message. */
export type PromptFile = {
  mediaType: 'application/pdf'
  data: Uint8Array
  name?: string
}

/** An earlier turn of a conversation, sent as a message of its own. */
export type PromptTurn = { role: 'user' | 'assistant'; text: string }

export type BuildRequestInput = {
  /** The lane's fixed text: what to produce and in what form. */
  instructions: string
  /**
   * Standing text the system part carries after the instructions, identical
   * on every call that shares it. Never cut by the budget.
   */
  mandate?: string
  items: ReadonlyArray<ContextItem>
  /** What this call is about — the row, the question, the document — rendered last. */
  subject: string
  /** The whole request's ceiling: system part, context and subject. */
  budgetChars: number
  /**
   * Earlier turns, oldest first. Present (even empty), the request is a
   * conversation: its last two messages carry cache markers.
   */
  conversation?: ReadonlyArray<PromptTurn>
  files?: ReadonlyArray<PromptFile>
  /** Whether the provider reads cache markers (Anthropic). */
  cache: boolean
}

/** What `generateText` / `streamText` are handed: `instructions` plus `messages`. */
export type BuiltRequest = {
  instructions: SystemModelMessage
  messages: Array<ModelMessage>
}

// Providers refuse an empty user message; a call with no context and no
// subject (a plugin handing no items) still needs one.
const NO_MATERIAL = 'No material was supplied.'

const CACHE_MARK: NonNullable<SystemModelMessage['providerOptions']> = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
}

/**
 * A call as a system part and messages, built so calls of one lane share a
 * prefix byte for byte: the system part is the lane's fixed text, the user
 * part the context and then the subject, so only the tail differs.
 * - The budget is spent on the system part first and never cuts it; the
 *   subject next; the context fills what is left (`renderPrompt`).
 * - With `cache`, the system part carries Anthropic's marker; a conversation
 *   also marks its last two messages, so each turn re-reads the one before.
 *   Without, the shape is the same and no marker is set.
 * - Files follow the text of the last user message.
 */
export function buildRequest(input: BuildRequestInput): BuiltRequest {
  const system =
    input.mandate === undefined || input.mandate === ''
      ? input.instructions
      : input.instructions + BLOCK_SEPARATOR + input.mandate
  const rendered = renderPrompt({
    items: input.items,
    task: input.subject,
    budgetChars: input.budgetChars - system.length,
  })
  const text = rendered === '' ? NO_MATERIAL : rendered
  const files = input.files ?? []
  const last: ModelMessage = {
    role: 'user',
    content: [
      { type: 'text', text },
      ...files.map((f) => ({
        type: 'file' as const,
        data: f.data,
        mediaType: f.mediaType,
        ...(f.name === undefined ? {} : { filename: f.name }),
      })),
    ],
  }
  const earlier = (input.conversation ?? []).map((turn): ModelMessage =>
    turn.role === 'user'
      ? { role: 'user', content: [{ type: 'text', text: turn.text }] }
      : { role: 'assistant', content: [{ type: 'text', text: turn.text }] },
  )
  const messages = [...earlier, last]
  const marked =
    input.cache && input.conversation !== undefined
      ? messages.map((m, i) =>
          i >= messages.length - 2 ? { ...m, providerOptions: CACHE_MARK } : m,
        )
      : messages
  return {
    instructions: {
      role: 'system',
      content: system,
      ...(input.cache ? { providerOptions: CACHE_MARK } : {}),
    },
    messages: marked,
  }
}

/** The request's length in characters, as the cap and an estimate count it. */
export function requestChars(request: BuiltRequest): number {
  let n = request.instructions.content.length
  for (const m of request.messages)
    if (typeof m.content === 'string') n += m.content.length
    else
      for (const part of m.content)
        if (part.type === 'text') n += part.text.length
  return n
}
