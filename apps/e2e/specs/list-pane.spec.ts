import { Client } from 'pg'
import type { Page } from '@playwright/test'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * A list is a fixed pane, against `main`: the window never scrolls, the
 * table's card fills to the view's foot less the 12px gutter, and rows scroll
 * inside it under a column head and over a foot that both stay put. The
 * companies are written straight into the instance's own database, as
 * `userCount` reads it, since this suite imports nothing internal.
 *
 * Serial: each test adds companies to the one shared instance.
 */
test.describe.configure({ mode: 'serial' })

const GUTTER = 12

/** Adds `n` companies after any already there, named so they sort last. */
async function addCompanies(n: number) {
  const client = new Client({ connectionString: fromEnv(ENV.mainDb) })
  await client.connect()
  try {
    // A company is its entity row plus the subtype row the list guards on.
    const added = await client.query(
      `with made as (
         insert into entity (kind, object_id, canonical_name, "values")
         select 'company', o.id, 'Pane Co ' || lpad((g + c.n)::text, 3, '0'),
                jsonb_build_object('name', 'Pane Co ' || lpad((g + c.n)::text, 3, '0'))
         from object o,
              (select count(*)::int as n from entity where kind = 'company') c,
              generate_series(1, $1::int) g
         where o.slug = 'companies'
         returning id
       )
       insert into company (entity_id) select id from made`,
      [n],
    )
    expect(added.rowCount).toBe(n)
  } finally {
    await client.end()
  }
}

/** The geometry the criteria name, read in one go. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (sel: string) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error(`no ${sel}`)
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
    }
    const scrolling = document.scrollingElement
    return {
      innerHeight: window.innerHeight,
      scrollHeight: scrolling?.scrollHeight ?? -1,
      box: rect('[data-table-box]'),
      foot: rect('[data-table-foot]'),
      head: rect('thead th'),
      search: rect('input[type="search"]'),
      rows: document.querySelectorAll('tbody [data-row]').length,
    }
  })
}

async function expectPane(page: Page, rows: number) {
  await expect(page.locator('tbody [data-row]')).toHaveCount(rows)
  const m = await measure(page)
  // No window scrollbar: the document is exactly the view's height.
  expect(m.scrollHeight).toBe(m.innerHeight)
  // The card reaches the view's foot less the bone gutter, with its foot in it.
  expect(Math.round(m.box.bottom)).toBe(m.innerHeight - GUTTER)
  expect(Math.round(m.foot.bottom)).toBe(Math.round(m.box.bottom) - 1)
  await expect(page.locator('[data-table-foot]')).toBeVisible()
  // The search box ends on the card's right border.
  expect(Math.round(m.search.right)).toBe(Math.round(m.box.right))
  return m
}

for (const [width, height] of [
  [1280, 800],
  [1440, 900],
] as const) {
  test.describe(`at ${width}×${height}`, () => {
    test.use({ viewport: { width, height } })

    test('three rows: the card still fills, the foot at its bottom', async ({
      adminPage,
      main,
    }) => {
      // Only the first viewport adds them; the second sees the same three.
      if (width === 1280) await addCompanies(3)
      await adminPage.goto(`${main.url}/companies`)
      await expectPane(adminPage, 3)
      await expect(adminPage.locator('[data-table-foot]')).toContainText(
        '3 of 3',
      )
    })
  })
}

test.describe('at 1280×800, a full list', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('fifty rows scroll under a still head and over a still foot', async ({
    adminPage,
    main,
  }) => {
    await addCompanies(47)
    await adminPage.goto(`${main.url}/companies`)
    const before = await expectPane(adminPage, 50)
    await adminPage
      .locator('[data-table-scroller]')
      .evaluate((el) => el.scrollBy(0, 400))
    const after = await measure(adminPage)
    expect(after.head.top).toBe(before.head.top)
    expect(after.foot.top).toBe(before.foot.top)
    expect(after.scrollHeight).toBe(after.innerHeight)
  })

  test('sideways, the name column and the row’s trailing lane stay put', async ({
    adminPage,
    main,
  }) => {
    await adminPage.goto(`${main.url}/companies`)
    const scroller = adminPage.locator('[data-table-scroller]')
    await expect(adminPage.locator('tbody [data-row]')).toHaveCount(50)
    const at = () =>
      adminPage.evaluate(() => {
        const row = document.querySelector('tbody [data-row]')
        // The first pinned left lane: the checkbox, then the name.
        const name = row?.querySelector('td.sticky:not([data-row-end])')
        const end = row?.querySelector('[data-row-end]')
        const box = document.querySelector('[data-table-box]')
        if (!name || !end || !box) throw new Error('no row')
        return {
          name: name.getBoundingClientRect().left,
          end: end.getBoundingClientRect().right,
          box: box.getBoundingClientRect().right,
        }
      })
    const before = await at()
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    const after = await at()
    expect(after.name).toBe(before.name)
    // The lane ends on the card's inner edge, inside its 1px border.
    expect(Math.round(after.end)).toBe(Math.round(after.box) - 1)
  })

  test('Load more appends rows inside the card and holds the scroll', async ({
    adminPage,
    main,
  }) => {
    await addCompanies(10)
    await adminPage.goto(`${main.url}/companies`)
    const foot = adminPage.locator('[data-table-foot]')
    await expect(foot).toContainText('50 of 60')
    const scroller = adminPage.locator('[data-table-scroller]')
    await scroller.evaluate((el) => el.scrollBy(0, 300))
    const top = await scroller.evaluate((el) => el.scrollTop)
    await foot.getByRole('button', { name: 'Load 50 more' }).click()
    await expect(adminPage.locator('tbody [data-row]')).toHaveCount(60)
    await expect(foot).toContainText('60 of 60')
    await expect(foot.getByRole('button', { name: /^Load/ })).toHaveCount(0)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top)
    const m = await measure(adminPage)
    expect(m.scrollHeight).toBe(m.innerHeight)
  })
})
