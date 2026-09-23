import { describe, expect, it } from 'vitest'

import { focusTab } from './focus'

/**
 * Which tab `/tasks?task=<id>` opens (SPA-87). Open and Done are exclusive,
 * so a focused closed task must open Done or it renders nothing.
 */

const data = {
  open: [{ id: 'open-1' }, { id: 'open-2' }],
  done: [{ id: 'done-1' }],
}

describe('focusTab', () => {
  it('opens Done for a closed task', () => {
    expect(focusTab('done-1', data)).toBe('done')
  })

  it('stays on Open for an open task', () => {
    expect(focusTab('open-2', data)).toBe('open')
  })

  it('leaves the tab alone with no param or an id the payload lacks', () => {
    expect(focusTab(undefined, data)).toBeNull()
    expect(focusTab('gone', data)).toBeNull()
  })
})
