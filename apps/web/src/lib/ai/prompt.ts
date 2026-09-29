import type { ContextItem } from '@spaces/core/context/types'

/**
 * The prompt renderer behind `complete()` (docs/spec-ai-substrate.md §4, the
 * map's "prompt: [ref] text … + task"). Pure: no clock, no randomness, no
 * I/O — the same items, task and budget always render the same string.
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
  // that joins them.
  let remaining = budget - task.length - BLOCK_SEPARATOR.length
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
  return blocks.join(BLOCK_SEPARATOR) + BLOCK_SEPARATOR + task
}
