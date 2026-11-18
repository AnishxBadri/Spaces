import type { Page } from '@playwright/test'
import { expect, test } from '../harness/fixtures.ts'

/**
 * A settings head's action ends where the 800px column ends its content
 * (E4), unfolded and folded alike, measured in a real Chromium on a window
 * wide enough that the column stops short of the page's edge. Members is
 * the page: an admin's head carries Invite.
 */

test.use({ viewport: { width: 1600, height: 600 } })

/** The last head action's right edge, and where the column's first row ends its content. */
async function edges(page: Page) {
  return page.evaluate(() => {
    const buttons = document.querySelectorAll('[data-head-actions] button')
    const last = buttons.item(buttons.length - 1)
    const row = document.querySelector('[data-settings-body] [data-member-row]')
    if (!(last instanceof HTMLElement) || !(row instanceof HTMLElement))
      throw new Error('no action or no row')
    const pad = Number.parseFloat(getComputedStyle(row).paddingRight)
    return {
      action: last.getBoundingClientRect().right,
      column: row.getBoundingClientRect().right - pad,
    }
  })
}

test('the folded settings head ends its action where the column ends', async ({
  adminPage,
  main,
}) => {
  await adminPage.goto(`${main.url}/settings/members`)
  const actions = adminPage.locator('[data-head-actions]')
  await expect(actions.getByRole('button', { name: 'Invite' })).toBeVisible()

  const open = await edges(adminPage)
  // The window is wide enough that the cap, not the 24px edge, decides.
  expect(open.column).toBeLessThan(1600 - 24 - 100)
  expect(Math.round(open.action - open.column)).toBe(0)

  // One admin is a short page: give it room to scroll its title away.
  await adminPage.evaluate(() => {
    const spacer = document.createElement('div')
    spacer.style.height = '2000px'
    document.querySelector('[data-settings-body]')?.append(spacer)
  })
  await adminPage.mouse.move(600, 400)
  await adminPage.mouse.wheel(0, 600)
  await expect(actions).toHaveAttribute('data-folded', 'true')

  const folded = await edges(adminPage)
  expect(Math.round(folded.action - folded.column)).toBe(0)
  expect(Math.round(folded.action - open.action)).toBe(0)
})
