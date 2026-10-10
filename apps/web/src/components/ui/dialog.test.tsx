import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog.tsx'

/**
 * One close per dialog, and `esc` is never printed: the head is the serif
 * title and the mono context, nothing right; the close is the foot's Cancel,
 * which each caller puts beside its primary.
 */

/** `esc` as a word, so `Description` and `Escape` do not count. */
const ESC = /\besc\b/

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
}

describe('DialogHeader', () => {
  const html = renderToStaticMarkup(
    <Dialog open>
      <DialogHeader>
        <DialogTitle>New space</DialogTitle>
        <DialogDescription>on Companies</DialogDescription>
      </DialogHeader>
    </Dialog>,
  )

  it('prints the title and the context, and no esc', () => {
    expect(html).toContain('New space')
    expect(html).toContain('on Companies')
    expect(html).not.toMatch(ESC)
  })

  it('holds no close of its own', () => {
    expect(html).not.toContain('data-slot="dialog-close"')
    expect(html).not.toMatch(/close/i)
  })
})

describe('DialogFooter', () => {
  it('prints only what the caller hands it', () => {
    const html = renderToStaticMarkup(
      <DialogFooter note="lands in 2 ledgers">
        <button type="button">Cancel</button>
      </DialogFooter>,
    )
    expect(html).toContain('lands in 2 ledgers')
    expect(html).toContain('Cancel')
    expect(html).not.toMatch(ESC)
    expect(html).not.toMatch(/close/i)
  })
})

describe('the printed esc', () => {
  it('is absent from the dialog primitive', () => {
    expect(source('./dialog.tsx')).not.toMatch(ESC)
  })

  it.todo(
    'is absent from settings-chassis.tsx — the settings head drops its own esc separately',
  )
})
