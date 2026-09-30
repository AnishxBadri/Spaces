import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Browser, Locator, Page } from '@playwright/test'
import { Client } from 'pg'
import { SHOTS_DIR, SHOTS_STORAGE } from '../harness/screenshots-setup.ts'
import { ENV, fromEnv } from '../harness/shared.ts'

/**
 * The captures `pnpm screenshots` writes to docs/assets/screenshots/. One
 * test per route, so a route that breaks names itself and the rest are
 * still taken. Each waits for network idle and one selector that only
 * renders once its data has (a table row, a record header, the note's
 * title) — never a sleep.
 *
 * The detail routes need ids the seed minted at run time; they are read
 * from the instance's database, choosing the record with the most on it so
 * the capture shows a timeline rather than an empty record.
 *
 * Size: 2x is the default, and oxipng or pngquant runs when one is on PATH.
 * A wide list (`list: true`) still over BUDGET after that is re-taken at 1x
 * — dense rows survive 1x; the hero and the record pages keep 2x and are
 * reported instead.
 */

/** The capture used as the README's hero image. */
const HERO = 'today.png'

/** Bytes a capture should stay under. */
const BUDGET = 400_000

type Ids = {
  deal: string
  company: string
  holding: string
  note: string
  /** The thesis memo the site's research fragment shows. */
  memo: string
}

type Shot = {
  readonly file: string
  readonly path: (ids: Ids) => string
  /** Present only once the route's data has rendered. */
  readonly ready: (page: Page) => Locator
  /** A wide list of rows: falls back to 1x when 2x is over BUDGET. */
  readonly list?: true
}

const firstRow = (page: Page) => page.locator('main tbody tr').first()
const heading = (page: Page) => page.locator('main h1').first()

const SHOTS: ReadonlyArray<Shot> = [
  { file: 'today.png', path: () => '/today', ready: heading },
  { file: 'deals.png', path: () => '/deals', ready: firstRow, list: true },
  { file: 'deal.png', path: (ids) => `/deals/${ids.deal}`, ready: heading },
  {
    file: 'companies.png',
    path: () => '/companies',
    ready: firstRow,
    list: true,
  },
  {
    file: 'company.png',
    path: (ids) => `/companies/${ids.company}`,
    ready: heading,
  },
  {
    file: 'portfolio.png',
    path: () => '/portfolio',
    ready: firstRow,
    list: true,
  },
  {
    file: 'holding.png',
    path: (ids) => `/portfolio/${ids.holding}`,
    ready: heading,
  },
  { file: 'notes.png', path: () => '/notes', ready: heading, list: true },
  {
    file: 'note.png',
    path: (ids) => `/notes/${ids.note}`,
    // The note's title is an editable textbox, not a heading.
    ready: (page) => page.getByRole('textbox', { name: 'Note title' }),
  },
  {
    file: 'documents.png',
    path: () => '/documents',
    ready: firstRow,
    list: true,
  },
  { file: 'spaces.png', path: () => '/spaces', ready: heading },
  { file: 'settings-ai.png', path: () => '/settings/ai', ready: heading },
  {
    file: 'settings-objects.png',
    path: () => '/settings/objects',
    ready: heading,
  },
  { file: 'import.png', path: () => '/import', ready: heading },
  { file: 'inbox.png', path: () => '/inbox', ready: heading },
]

/** One id from the instance's database — the first row `sql` returns. */
async function pick(client: Client, what: string, sql: string) {
  const res = await client.query<{ id: string }>(sql)
  const id = res.rows.at(0)?.id
  if (id === undefined)
    throw new Error(`[shots] the seed left no ${what} to capture`)
  return id
}

/** Activity on a record plus every edge touching it — notes, files, people. */
const WEIGHT = `(select count(*) from activity a
                  where a.subject_entity_id = e.id or a.object_entity_id = e.id)
              + (select count(*) from link l
                  where l.from_entity_id = e.id or l.to_entity_id = e.id)`

/** Research records of `kind` (a document, a note) filed against `e`. */
const filed = (kind: string) => `(select count(*) from link l
                  join entity r on r.id = l.from_entity_id
                  where l.to_entity_id = e.id and r.kind = '${kind}')`

async function readIds(): Promise<Ids> {
  const client = new Client({ connectionString: fromEnv(ENV.shotsDb) })
  await client.connect()
  try {
    const busiest = (kind: string) =>
      pick(
        client,
        kind,
        `select e.id from entity e
          where e.kind = '${kind}' and e.merged_into_id is null
          order by ${WEIGHT} desc, e.canonical_name
          limit 1`,
      )
    return {
      deal: await busiest('deal'),
      // A company with files *and* notes filed against it, then the busiest.
      company: await pick(
        client,
        'company',
        `select e.id from entity e
          where e.kind = 'company' and e.merged_into_id is null
          order by ${filed('document')} > 0 and ${filed('note')} > 0 desc,
                   ${filed('document')} + ${filed('note')} desc,
                   ${WEIGHT} desc, e.canonical_name
          limit 1`,
      ),
      holding: await pick(
        client,
        'holding',
        `select h.id from holding h
          join entity e on e.id = h.company_id
          order by (select count(*) from investment i where i.holding_id = h.id)
                 + (select count(*) from mark m where m.holding_id = h.id)
                 + (select count(*) from distribution d where d.holding_id = h.id) desc,
                   e.canonical_name
          limit 1`,
      ),
      // A shared memo, the one that mentions the most records, then the longest.
      note: await pick(
        client,
        'note',
        `select n.entity_id as id from note n
          where n.title <> '' and n.visibility = 'shared'
          order by n.kind = 'memo' desc,
                   (select count(*) from link l where l.from_entity_id = n.entity_id) desc,
                   length(n.body_md) desc
          limit 1`,
      ),
      // A thesis rather than a post-mortem: the bench's small-lift memo when
      // it is there, else the shared memo with the most mentions.
      memo: await pick(
        client,
        'memo',
        `select n.entity_id as id from note n
          where n.title <> '' and n.visibility = 'shared'
          order by n.title = 'Why small-lift, and why now' desc,
                   n.kind = 'memo' desc,
                   (select count(*) from link l where l.from_entity_id = n.entity_id) desc,
                   n.title
          limit 1`,
      ),
    }
  } finally {
    await client.end()
  }
}

/** A PNG optimiser on PATH, if the machine has one. */
function optimiser(): ((file: string) => void) | null {
  const has = (bin: string) => {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  if (has('oxipng'))
    return (file) =>
      execFileSync('oxipng', ['-o', '4', '--strip', 'safe', '-q', file])
  if (has('pngquant'))
    return (file) =>
      execFileSync('pngquant', [
        '--force',
        '--skip-if-larger',
        '--ext',
        '.png',
        '--quality',
        '80-95',
        file,
      ])
  return null
}

let ids: Ids | null = null
const optimise = optimiser()

test.beforeAll(async () => {
  ids = await readIds()
  mkdirSync(SHOTS_DIR, { recursive: true })
  if (optimise === null)
    console.log(
      '[shots] neither oxipng nor pngquant on PATH — PNGs unoptimised',
    )
})

/** Load a route and wait for its data — network idle, then its selector. */
async function open(page: Page, url: string, ready: Shot['ready']) {
  await page.goto(url, { waitUntil: 'networkidle' })
  // Signed in: a lost session would land on /login and capture that. The
  // path only — a route may add its default search (/documents?filed=all).
  expect(new URL(page.url()).pathname).toBe(new URL(url).pathname)
  await expect(ready(page)).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

async function capture(page: Page, file: string) {
  await page.screenshot({
    path: file,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  })
  if (optimise !== null) optimise(file)
  return statSync(file).size
}

/** The same page at deviceScaleFactor 1, for a list over BUDGET. */
async function captureAt1x(
  browser: Browser,
  page: Page,
  url: string,
  shot: Shot,
  file: string,
) {
  const context = await browser.newContext({
    viewport: page.viewportSize(),
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    storageState: SHOTS_STORAGE,
  })
  try {
    const small = await context.newPage()
    await open(small, url, shot.ready)
    return await capture(small, file)
  } finally {
    await context.close()
  }
}

for (const shot of SHOTS) {
  test(shot.file, async ({ page, browser }) => {
    if (ids === null) throw new Error('[shots] ids were not read')
    const url = `${fromEnv(ENV.shotsUrl)}${shot.path(ids)}`
    const file = join(SHOTS_DIR, shot.file)
    await open(page, url, shot.ready)
    let size = await capture(page, file)
    let scale = '2x'
    if (size > BUDGET && shot.list === true) {
      size = await captureAt1x(browser, page, url, shot, file)
      scale = '1x (2x was over budget)'
    }
    if (shot.file === HERO) copyFileSync(file, join(SHOTS_DIR, 'hero.png'))
    const kb = Math.round(size / 1000)
    console.log(
      `[shots] ${shot.file} ${scale} ${kb} KB${size > BUDGET ? ' — over the 400 KB budget' : ''}`,
    )
  })
}

/*
 * Fragments: tight crops of one piece of the product — a readout strip, four
 * rows of a table, a rail section — for the marketing site, which floats
 * them over its panels rather than showing whole screens. Written to
 * docs/assets/screenshots/fragments/<name>.png at the same 2x.
 *
 * Each is found by what it says, never by a class or a test id: this package
 * imports nothing from the app and knows it only as a user would. `around`
 * climbs from one piece of text to the nearest element that also holds
 * another, which is how "the readout strip" or "the portfolio card" is named
 * without knowing the markup. The clip is that element's box, or the band
 * between two such boxes; the site draws the padding, so a crop never
 * reaches into a neighbour and never cuts a line of text in half.
 */

type Box = { x: number; y: number; width: number; height: number }

type Fragment = {
  readonly name: string
  readonly path: (ids: Ids) => string
  readonly ready: (page: Page) => Locator
  /** A narrower window, so a table sits closer together. */
  readonly width?: number
  readonly clip: (page: Page) => Promise<Box>
}

const FRAGMENTS_DIR = join(SHOTS_DIR, 'fragments')

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('[shots] fragment anchor has no box')
  return box
}

/** The nearest element, from `anchor` up, whose text also contains `text`. */
const around = (anchor: Locator, text: string) =>
  anchor.locator(
    `xpath=ancestor-or-self::*[contains(string(.), ${JSON.stringify(text)})][1]`,
  )

const exact = (scope: Page | Locator, text: string) =>
  scope.getByText(text, { exact: true }).first()

/** `box` from its left edge to `right`, and from its top to `bottom`. */
const cut = (
  box: Box,
  edges: { right?: number | undefined; bottom?: number | undefined },
): Box => ({
  x: box.x,
  y: box.y,
  width: (edges.right ?? box.x + box.width) - box.x,
  height: (edges.bottom ?? box.y + box.height) - box.y,
})

/** A table's header and its first `rows` rows, up to the column `stopAt`. */
async function tableSlice(page: Page, rows: number, stopAt?: string) {
  const head = await boxOf(page.locator('main thead').first())
  const last = await boxOf(page.locator('main tbody tr').nth(rows - 1))
  const right =
    stopAt === undefined
      ? undefined
      : (await boxOf(page.locator('main thead th').filter({ hasText: stopAt })))
          .x
  return cut(head, { bottom: last.y + last.height, right })
}

const FRAGMENTS: ReadonlyArray<Fragment> = [
  {
    // The hero's base card: Today without its rail, down to the idle deals.
    name: 'today-main',
    path: () => '/today',
    ready: heading,
    clip: async (page) => {
      const rail = await boxOf(page.locator('aside').last())
      // The section head, not the readout cell of the same name above it.
      const stale = await boxOf(
        page.locator('main').getByText('Stale marks', { exact: true }).last(),
      )
      return { x: 0, y: 0, width: rail.x, height: stale.y - 32 }
    },
  },
  {
    name: 'today-readout',
    path: () => '/today',
    ready: heading,
    clip: async (page) => {
      const strip = await boxOf(around(exact(page, 'Overdue'), 'Unfiled'))
      const stop = await boxOf(
        around(exact(page, 'Missing FX'), 'Missing FX').locator('xpath=..'),
      )
      return cut(strip, { right: stop.x, bottom: strip.y + strip.height - 1 })
    },
  },
  {
    name: 'today-portfolio',
    path: () => '/today',
    ready: heading,
    clip: async (page) => {
      const card = await boxOf(
        around(exact(page.locator('aside').last(), 'Invested'), 'MOIC'),
      )
      // Less the section's bottom hairline: the site draws the frame.
      return cut(card, { bottom: card.y + card.height - 1 })
    },
  },
  {
    name: 'today-ledger',
    path: () => '/today',
    ready: heading,
    clip: async (page) => {
      const rail = page.locator('aside').last()
      const section = await boxOf(
        around(exact(rail, 'Ledger'), 'entries').locator('xpath=..'),
      )
      return cut(section, { bottom: section.y + Math.min(section.height, 340) })
    },
  },
  {
    name: 'deals-rows',
    path: () => '/deals',
    ready: firstRow,
    clip: (page) => tableSlice(page, 5, 'People'),
  },
  {
    name: 'deal-pipeline',
    path: (minted) => `/deals/${minted.deal}`,
    ready: heading,
    clip: async (page) => {
      const rail = page.locator('aside').last()
      const card = await boxOf(around(exact(rail, 'Pipeline'), 'Lost'))
      return cut(card, { bottom: card.y + card.height - 1 })
    },
  },
  {
    name: 'company-grid',
    path: (minted) => `/companies/${minted.company}`,
    ready: heading,
    clip: (page) =>
      boxOf(around(exact(page.locator('main'), 'Description'), 'Team size')),
  },
  {
    name: 'inbox-duplicate',
    path: () => '/inbox',
    ready: heading,
    clip: (page) =>
      boxOf(around(exact(page, 'Same Company?'), 'Merge B into A')),
  },
  {
    name: 'note-memo',
    path: (minted) => `/notes/${minted.memo}`,
    ready: (page) => page.getByRole('textbox', { name: 'Note title' }),
    clip: async (page) => {
      const title = await boxOf(
        page.getByRole('textbox', { name: 'Note title' }),
      )
      const editor = page.locator('main [contenteditable="true"]')
      const body = await boxOf(editor)
      // The editor keeps an empty block at its foot; stop at the last line
      // that has text in it (a mention chip is text too).
      const inked = await editor.evaluate((el) => {
        let bottom = 0
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
          if ((n.textContent ?? '').trim() === '') continue
          const range = document.createRange()
          range.selectNodeContents(n)
          bottom = Math.max(bottom, range.getBoundingClientRect().bottom)
        }
        return bottom
      })
      return {
        x: body.x,
        y: title.y,
        width: body.width,
        height: inked + 8 - title.y,
      }
    },
  },
  {
    name: 'spaces-tree',
    path: () => '/spaces',
    ready: heading,
    width: 860,
    clip: async (page) => {
      const head = await boxOf(
        around(exact(page, 'Market map'), 'Companies').locator('xpath=..'),
      )
      return cut(head, { bottom: head.y + 360 })
    },
  },
  {
    name: 'portfolio-table',
    path: () => '/portfolio',
    ready: firstRow,
    clip: (page) => tableSlice(page, 6, 'Last mark'),
  },
  {
    name: 'holding-readout',
    path: (minted) => `/portfolio/${minted.holding}`,
    ready: heading,
    clip: async (page) => {
      const main = page.locator('main')
      const strip = await boxOf(around(exact(main, 'Invested'), 'XIRR'))
      const xirr = await boxOf(around(exact(main, 'XIRR'), '%'))
      return cut(strip, { right: xirr.x + xirr.width + 32 })
    },
  },
  {
    name: 'holding-marks',
    path: (minted) => `/portfolio/${minted.holding}`,
    ready: heading,
    clip: async (page) => {
      const marks = await boxOf(
        around(exact(page, 'Marks'), 'add mark').locator('xpath=..'),
      )
      const next = await boxOf(exact(page, 'Distributions'))
      return cut(marks, { bottom: next.y - 24 })
    },
  },
  {
    name: 'documents-rows',
    path: () => '/documents',
    ready: firstRow,
    clip: (page) => tableSlice(page, 5, 'Space'),
  },
  {
    name: 'ai-providers',
    path: () => '/settings/ai',
    ready: heading,
    width: 1060,
    clip: async (page) => {
      const head = await boxOf(exact(page, 'Providers'))
      // The Ollama row: its text up to the nearest element that also says
      // `default` (the base-URL cell), which is the row itself.
      const table = await boxOf(around(exact(page, 'Ollama'), 'default'))
      return {
        x: table.x,
        y: head.y - 2,
        width: table.width,
        height: table.y + table.height - head.y + 2,
      }
    },
  },
]

for (const fragment of FRAGMENTS) {
  test(`fragments/${fragment.name}.png`, async ({ page }) => {
    if (ids === null) throw new Error('[shots] ids were not read')
    mkdirSync(FRAGMENTS_DIR, { recursive: true })
    if (fragment.width !== undefined)
      await page.setViewportSize({ width: fragment.width, height: 900 })
    const url = `${fromEnv(ENV.shotsUrl)}${fragment.path(ids)}`
    await open(page, url, fragment.ready)
    const clip = await fragment.clip(page)
    const file = join(FRAGMENTS_DIR, `${fragment.name}.png`)
    await page.screenshot({
      path: file,
      clip: {
        x: Math.round(clip.x),
        y: Math.round(clip.y),
        width: Math.round(clip.width),
        height: Math.round(clip.height),
      },
      animations: 'disabled',
      caret: 'hide',
    })
    if (optimise !== null) optimise(file)
    const kb = Math.round(statSync(file).size / 1000)
    console.log(
      `[shots] fragments/${fragment.name}.png ${Math.round(clip.width)}×${Math.round(clip.height)} ${kb} KB`,
    )
  })
}
