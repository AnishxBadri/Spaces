import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAVE_DEBOUNCE_MS, SAVE_RETRY_MS, useNoteSave } from './use-note-save'

/**
 * The note's autosave under fake timers, against a mocked `saveNote`: the
 * debounce, the one automatic retry after a failure, `retry()`, the latest
 * text winning over a slow save, and nothing running after unmount.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/notes/n1' })
  for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement'])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

type SaveInput = { data: { id: string; title: string; body: unknown } }

const fns = vi.hoisted(() => ({
  saveNote: vi.fn<(input: SaveInput) => Promise<void>>(),
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('#/components/editor/note-editor', () => ({
  deriveMarkdown: (md: string) => md,
  extractMentionIds: () => [],
}))

let save: ReturnType<typeof useNoteSave>
let root: Root | null = null

function Probe() {
  save = useNoteSave({ noteId: 'n1', initialTitle: 'Flent thesis' })
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  fns.saveNote.mockReset()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(<Probe />))
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const refuse = () => Promise.reject(new Error('the server did not answer'))
const land = () => Promise.resolve()

describe('useNoteSave', () => {
  it('is idle and has nothing pending before the first edit', () => {
    expect(save.state).toBe('idle')
    expect(save.pending).toBe(false)
    expect(save.hasPending()).toBe(false)
  })

  it('debounces an edit into one save of the latest title', async () => {
    fns.saveNote.mockImplementation(land)
    act(() => save.editTitle('Flent'))
    act(() => save.editTitle('Flent thesis v2'))
    expect(save.state).toBe('dirty')
    expect(save.hasPending()).toBe(true)
    await advance(SAVE_DEBOUNCE_MS)
    expect(fns.saveNote).toHaveBeenCalledTimes(1)
    expect(fns.saveNote).toHaveBeenCalledWith({
      data: { id: 'n1', title: 'Flent thesis v2', body: undefined },
    })
    expect(save.state).toBe('saved')
    expect(save.pending).toBe(false)
    expect(save.hasPending()).toBe(false)
  })

  it('fails, retries once by itself, stays failed, then lands on Retry', async () => {
    fns.saveNote
      .mockImplementationOnce(refuse)
      .mockImplementationOnce(refuse)
      .mockImplementation(land)
    act(() => save.editTitle('Flent'))
    await advance(SAVE_DEBOUNCE_MS)
    expect(fns.saveNote).toHaveBeenCalledTimes(1)
    expect(save.state).toBe('failed')
    expect(save.hasPending()).toBe(true)

    // One automatic retry after the backoff, and no second.
    await advance(SAVE_RETRY_MS - 1)
    expect(fns.saveNote).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(fns.saveNote).toHaveBeenCalledTimes(2)
    expect(save.state).toBe('failed')
    await advance(SAVE_RETRY_MS * 10)
    expect(fns.saveNote).toHaveBeenCalledTimes(2)
    expect(save.state).toBe('failed')
    expect(save.pending).toBe(true)

    // The server answers again: Retry lands it.
    await act(async () => {
      save.retry()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fns.saveNote).toHaveBeenCalledTimes(3)
    expect(fns.saveNote).toHaveBeenLastCalledWith({
      data: { id: 'n1', title: 'Flent', body: undefined },
    })
    expect(save.state).toBe('saved')
    expect(save.hasPending()).toBe(false)
  })

  it('gives a later edit its own save and its own retry', async () => {
    fns.saveNote
      .mockImplementationOnce(refuse)
      .mockImplementationOnce(refuse)
      .mockImplementationOnce(refuse)
      .mockImplementation(land)
    act(() => save.editTitle('Flent'))
    await advance(SAVE_DEBOUNCE_MS + SAVE_RETRY_MS)
    expect(fns.saveNote).toHaveBeenCalledTimes(2)
    act(() => save.editTitle('Flent, again'))
    expect(save.state).toBe('dirty')
    await advance(SAVE_DEBOUNCE_MS)
    expect(fns.saveNote).toHaveBeenCalledTimes(3)
    expect(save.state).toBe('failed')
    await advance(SAVE_RETRY_MS)
    expect(fns.saveNote).toHaveBeenCalledTimes(4)
    expect(fns.saveNote).toHaveBeenLastCalledWith({
      data: { id: 'n1', title: 'Flent, again', body: undefined },
    })
    expect(save.state).toBe('saved')
  })

  it('never puts older text over newer: saves run one at a time, each sending the latest', async () => {
    let answer: () => void = () => {}
    fns.saveNote
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            answer = resolve
          }),
      )
      .mockImplementation(land)
    act(() => save.editTitle('First'))
    await advance(SAVE_DEBOUNCE_MS)
    expect(save.state).toBe('saving')
    act(() => save.editTitle('Second'))
    // The second debounce ends while the first save is still out: it waits.
    await advance(SAVE_DEBOUNCE_MS)
    expect(fns.saveNote).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fns.saveNote).toHaveBeenCalledTimes(2)
    expect(fns.saveNote).toHaveBeenLastCalledWith({
      data: { id: 'n1', title: 'Second', body: undefined },
    })
    expect(save.state).toBe('saved')
    expect(save.hasPending()).toBe(false)
  })

  it('sends the editor body with the title', async () => {
    fns.saveNote.mockImplementation(land)
    act(() =>
      save.edit({
        document: [],
        blocksToMarkdownLossy: () => Promise.resolve('# Flent'),
      }),
    )
    await advance(SAVE_DEBOUNCE_MS)
    expect(fns.saveNote).toHaveBeenCalledWith({
      data: {
        id: 'n1',
        title: 'Flent thesis',
        body: { bodyJson: [], bodyMd: '# Flent', mentionIds: [] },
      },
    })
  })

  it('flushNow saves at once and says whether the edit landed', async () => {
    await expect(save.flushNow()).resolves.toBe(true)
    expect(fns.saveNote).not.toHaveBeenCalled()

    fns.saveNote.mockImplementationOnce(refuse).mockImplementation(land)
    act(() => save.editTitle('Flent'))
    let landed: boolean | null = null
    await act(async () => {
      landed = await save.flushNow()
    })
    expect(landed).toBe(false)
    expect(save.state).toBe('failed')
    await act(async () => {
      landed = await save.flushNow()
    })
    expect(landed).toBe(true)
    expect(save.state).toBe('saved')
  })

  it('runs nothing after unmount', async () => {
    fns.saveNote.mockImplementation(refuse)
    act(() => save.editTitle('Flent'))
    await advance(SAVE_DEBOUNCE_MS)
    expect(fns.saveNote).toHaveBeenCalledTimes(1)
    act(() => root?.unmount())
    root = null
    await advance(SAVE_RETRY_MS * 5)
    expect(fns.saveNote).toHaveBeenCalledTimes(1)
  })
})
