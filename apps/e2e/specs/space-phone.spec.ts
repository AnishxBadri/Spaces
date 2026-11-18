import { Client } from 'pg'
import type { Page } from '@playwright/test'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * A space on a phone, against `main`: at 390px nothing on the page is wider
 * than the window, whichever tab is open. Its tab bar scrolls inside itself
 * and its readouts wrap. The space is one of the starter taxonomy's, with
 * companies filed on it at three funding stages so Overview draws its
 * readouts; they are written straight into the instance's own database,
 * since this suite imports nothing internal.
 */
test.describe.configure({ mode: 'serial' })

const STAGES = ['seed', 'series_a', 'bootstrapped', 'pre_seed'] as const

/** A starter space with four companies filed on it; its id. */
async function spaceWithCompanies(): Promise<string> {
  const client = new Client({ connectionString: fromEnv(ENV.mainDb) })
  await client.connect()
  try {
    const found = await client.query<{ id: string }>(
      `select s.entity_id as id from space s
       where s.parent_id is null and s.archived_at is null
       order by s.path limit 1`,
    )
    const id = found.rows.at(0)?.id
    if (id === undefined) throw new Error('no starter space')
    await client.query(
      `with made as (
         insert into entity (kind, object_id, canonical_name, "values")
         select 'company', o.id, 'Phone Co ' || g,
                jsonb_build_object('name', 'Phone Co ' || g,
                                   'funding_stage', ($2::text[])[g])
         from object o, generate_series(1, array_length($2::text[], 1)) g
         where o.slug = 'companies'
         returning id
       ), sub as (
         insert into company (entity_id) select id from made returning entity_id
       )
       insert into entity_space (entity_id, space_id)
       select entity_id, $1::uuid from sub`,
      [id, STAGES],
    )
    return id
  } finally {
    await client.end()
  }
}

/** The page's widths, and what pokes past the window when it is too wide. */
async function widths(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement
    const edge = root.clientWidth
    const past = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
      .filter((el) => {
        // Inside a box that scrolls or clips sideways, it is that box's.
        for (let p = el.parentElement; p; p = p.parentElement) {
          const x = getComputedStyle(p).overflowX
          if (x !== 'visible') return false
        }
        return true
      })
      .slice(0, 8)
      .map((el) => {
        const attrs = [...el.attributes]
          .filter((a) => a.name.startsWith('data-') || a.name === 'role')
          .map((a) => a.name)
        return `${el.tagName.toLowerCase()}[${attrs.join(',')}] ${Math.round(el.getBoundingClientRect().right)}`
      })
    return { scrollWidth: root.scrollWidth, clientWidth: edge, past }
  })
}

test.describe('at 390×844, a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  let spaceId = ''

  test('the space page is no wider than the window on any tab', async ({
    adminPage,
    main,
  }) => {
    spaceId = await spaceWithCompanies()
    await adminPage.goto(`${main.url}/spaces/${spaceId}`)
    await expect(adminPage.locator('[data-overview-readouts]')).toBeVisible()
    await expect(adminPage.locator('[data-readout]')).toHaveCount(2)
    const tabs = adminPage.getByRole('tab')
    const count = await tabs.count()
    expect(count).toBeGreaterThan(1)
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i)
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      const w = await widths(adminPage)
      expect(w.past, `${await tab.innerText()}: past the window`).toEqual([])
      expect(w.scrollWidth).toBe(w.clientWidth)
    }
  })

  test('the tab bar scrolls inside itself to a deep-linked last tab', async ({
    adminPage,
    main,
  }) => {
    await adminPage.goto(`${main.url}/spaces/${spaceId}?tab=records`)
    const last = adminPage.getByRole('tab').last()
    await expect(last).toHaveAttribute('aria-selected', 'true')
    // The bar scrolled, not the window, to bring the open tab inside it.
    await expect
      .poll(() =>
        adminPage.locator('[data-tab-scroll]').evaluate((el) => el.scrollLeft),
      )
      .toBeGreaterThan(0)
    const right = await last.evaluate((el) => el.getBoundingClientRect().right)
    expect(right).toBeLessThanOrEqual(390)
    const w = await widths(adminPage)
    expect(w.past).toEqual([])
    expect(w.scrollWidth).toBe(w.clientWidth)
  })
})
