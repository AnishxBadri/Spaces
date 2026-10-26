import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toast } from 'sonner'
import { describe, expect, it } from 'vitest'

import { TOAST_MS } from './sonner'

/**
 * The toast: ink, no icon, an underlined action whose line drains over the
 * hold, and an error that stays, crimson, until its `×` is pressed.
 */

const source = readFileSync(
  fileURLToPath(new URL('./sonner.tsx', import.meta.url)),
  'utf8',
)
const css = readFileSync(
  fileURLToPath(new URL('../../styles.css', import.meta.url)),
  'utf8',
)

function last() {
  const t = toast.getHistory().at(-1)
  if (t === undefined || !('type' in t)) throw new Error('no toast')
  return t
}

describe('toast.error', () => {
  it('stays until it is dismissed, by its ×', () => {
    toast.error('Could not save')
    expect(last()).toMatchObject({
      type: 'error',
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
    })
  })

  it("keeps a caller's own hold", () => {
    toast.error('Could not save', { duration: 2000 })
    expect(last()).toMatchObject({ duration: 2000 })
  })

  it('leaves the other kinds on the hold', () => {
    toast.success('Saved')
    expect(last().duration).toBeUndefined()
  })
})

describe('the Toaster', () => {
  it('draws no icon, and the Twinkle while a toast is working', () => {
    expect(source).not.toMatch(/lucide-react/)
    for (const kind of ['success', 'info', 'warning', 'error'])
      expect(source).toContain(`${kind}: null`)
    expect(source).toContain('loading: <Twinkle tone="paper" />')
  })

  it("drains the action's line over the toast's hold", () => {
    expect(TOAST_MS).toBeGreaterThan(0)
    expect(source).toContain('duration={TOAST_MS}')
    expect(source).toContain("'--toast-duration': `${TOAST_MS}ms`")
    expect(css).toContain(
      'animation: toast-drain var(--toast-duration) linear forwards',
    )
    expect(css).toMatch(/\[data-action\] \{[^}]*text-decoration: underline/)
  })

  it('paints an error crimson', () => {
    expect(css).toMatch(
      /\[data-type='error'\] \{\s*--normal-bg: var\(--destructive\);/,
    )
  })
})
