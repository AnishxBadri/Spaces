import { Client } from 'pg'
import type { Page } from '@playwright/test'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * A tabbed record is a fixed pane at `xl`, against `main`: the window never
 * scrolls, the folder under the tabs runs to the view's foot less the 12px
 * gutter whether its tab is empty or long, the open tab scrolls inside it
 * under a head, a tab bar and a rail that stay put, and each tab keeps its
 * own place. Below `xl` the page scrolls as one again. The records are
 * written straight into the instance's own database, since this suite
 * imports nothing internal.
 *
 * Serial: the tests share the two companies the first one writes.
 */
test.describe.configure({ mode: 'serial' })

const GUTTER = 12

/** A company and its subtype row; `calls` logged calls on it, a day apart. */
async function addCompany(name: string, calls: number): Promise<string> {
  const client = new Client({ connectionString: fromEnv(ENV.mainDb) })
  await client.connect()
  try {
    const made = await client.query<{ id: string }>(
      `insert into entity (kind, object_id, canonical_name, "values")
       select 'company', o.id, $1::text, jsonb_build_object('name', $1::text)
       from object o where o.slug = 'companies'
       returning id`,
      [name],
    )
    const id = made.rows.at(0)?.id
    if (id === undefined) throw new Error('no company made')
    await client.query('insert into company (entity_id) values ($1)', [id])
    await client.query(
      `with made as (
         insert into interaction (kind, subject, occurred_at)
         select 'call', 'Pane call ' || lpad(g::text, 3, '0'),
                now() - make_interval(days => g)
         from generate_series(1, $2::int) g
         returning id
       )
       insert into interaction_entity (interaction_id, entity_id)
       select id, $1::uuid from made`,
      [id, calls],
    )
    return id
  } finally {
    await client.end()
  }
}

const ids: { quiet?: string; busy?: string } = {}

/** The geometry the criteria name, read in one go. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const el = (sel: string) => {
      const found = document.querySelector(sel)
      if (!found) throw new Error(`no ${sel}`)
      return found
    }
    const top = (sel: string) => el(sel).getBoundingClientRect().top
    const folder = el('[data-folder-scroll]')
    const rail = el('[data-record-rail]')
    return {
      innerHeight: window.innerHeight,
      pageHeight: document.scrollingElement?.scrollHeight ?? -1,
      folderBottom: folder.getBoundingClientRect().bottom,
      folderHeight: folder.getBoundingClientRect().height,
      folderScroll: folder.scrollTop,
      folderOverflows: folder.scrollHeight > folder.clientHeight,
      head: top('header h1'),
      tabs: top('[role="tablist"]'),
      rail: rail.getBoundingClientRect().top,
    }
  })
}

test.describe('at 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a quiet record and a busy one take the same folder, to the view’s foot', async ({
    adminPage,
    main,
  }) => {
    ids.quiet = await addCompany('Pane Quiet', 0)
    ids.busy = await addCompany('Pane Busy', 40)
    const heights: Array<number> = []
    for (const id of [ids.quiet, ids.busy]) {
      await adminPage.goto(`${main.url}/companies/${id}?tab=interactions`)
      await expect(adminPage.locator('[data-folder-scroll]')).toBeVisible()
      // Hydrated at xl: the head has no folding bar at all.
      await expect(adminPage.locator('[data-head-bar]')).toHaveCount(0)
      const m = await measure(adminPage)
      // No window scrollbar: the document is exactly the view's height.
      expect(m.pageHeight).toBe(m.innerHeight)
      expect(Math.round(m.folderBottom)).toBe(m.innerHeight - GUTTER)
      heights.push(Math.round(m.folderHeight))
    }
    expect(heights.at(0)).toBe(heights.at(1))
  })

  test('scrolling moves only the folder’s content; each tab keeps its place', async ({
    adminPage,
    main,
  }) => {
    await adminPage.goto(`${main.url}/companies/${ids.busy}?tab=interactions`)
    const folder = adminPage.locator('[data-folder-scroll]')
    await expect(adminPage.locator('[data-thread]').first()).toBeVisible()
    await expect(adminPage.locator('[data-head-bar]')).toHaveCount(0)
    const before = await measure(adminPage)
    expect(before.folderOverflows).toBe(true)
    await folder.evaluate((el) => el.scrollBy(0, 400))
    const after = await measure(adminPage)
    expect(after.folderScroll).toBeGreaterThan(0)
    expect(after.head).toBe(before.head)
    expect(after.tabs).toBe(before.tabs)
    expect(after.rail).toBe(before.rail)
    expect(after.pageHeight).toBe(after.innerHeight)

    // Overview lists threads too, so the open tab is read off the tab bar.
    const tablist = adminPage.getByRole('tablist')
    const overview = tablist.getByRole('tab', { name: 'Overview' })
    const interactions = tablist.getByRole('tab', { name: /^Interactions/ })
    const scrollTop = () => folder.evaluate((el) => el.scrollTop)
    await overview.click()
    await expect(overview).toHaveAttribute('aria-selected', 'true')
    await expect.poll(scrollTop).toBe(0)
    await interactions.click()
    await expect(interactions).toHaveAttribute('aria-selected', 'true')
    await expect.poll(scrollTop).toBe(after.folderScroll)
  })
})

for (const [width, height] of [
  [1024, 768],
  [390, 844],
] as const) {
  test.describe(`at ${width}×${height}`, () => {
    test.use({ viewport: { width, height } })

    test('the page scrolls as one, the folder only as tall as its tab', async ({
      adminPage,
      main,
    }) => {
      await adminPage.goto(`${main.url}/companies/${ids.busy}?tab=interactions`)
      await expect(adminPage.locator('[data-thread]').first()).toBeVisible()
      const m = await measure(adminPage)
      expect(m.pageHeight).toBeGreaterThan(m.innerHeight)
      expect(m.folderOverflows).toBe(false)
    })
  })
}
