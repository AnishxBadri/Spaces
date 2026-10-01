import { fileURLToPath } from 'node:url'
import { expect, test } from '../../harness/fixtures.ts'
import type { Page, Request } from '@playwright/test'

/**
 * Upload → preview, in a real browser, against the image built for this
 * commit (SPA-186). CONTEXT.md named this test two phases ago; it is also
 * the image smoke, because the app under test is the composed container.
 *
 * It leans on a property the preview surface already has:
 *
 *   DOCX  the preview shows the text the *worker* extracted, so one upload
 *         proves the upload, the blob write, the pg-boss enqueue, extraction
 *         in the worker and the preview.
 *   PDF   pdf.js draws to a canvas client-side, and the browser never
 *         navigates to the blob — while the download route still answers
 *         `attachment` + `application/octet-stream`, because echoing an
 *         upload's own content type would be stored XSS on the app's origin.
 *
 * Serial: both specs file into the one company the first creates.
 */
test.describe.configure({ mode: 'serial' })

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url))

const DOCX = { file: 'smoke-memo.docx', marker: 'wombatsmoke-7c2e' }
const PDF = { file: 'smoke-deck.pdf' }
const COMPANY = 'Image Smoke Holdings'

let companyUrl = ''

/**
 * Every request the page makes that leaves the app's own origin. The run
 * must fetch nothing from the network — fixtures are committed, and a
 * preview that reached for a CDN (pdf.js fonts or its worker, say) would
 * break on an offline install. Asserted empty at the end of each spec.
 */
function offOrigin(page: Page, imageUrl: string): string[] {
  const origin = new URL(imageUrl).origin
  const seen: string[] = []
  page.on('request', (r) => {
    const url = r.url()
    if (url.startsWith('data:') || url.startsWith('blob:')) return
    if (new URL(url).origin !== origin) seen.push(url)
  })
  return seen
}

async function openCompany(page: Page, imageUrl: string) {
  if (companyUrl === '') {
    await page.goto(`${imageUrl}/companies`)
    // The header's button; an empty list offers a second one in its body.
    await page.getByRole('button', { name: 'New company' }).first().click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Name', { exact: true }).fill(COMPANY)
    await form.getByRole('button', { name: 'Create company' }).click()
    await expect(form).toHaveCount(0)
    await page.getByRole('link', { name: COMPANY }).first().click()
    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/)
    companyUrl = page.url()
  } else {
    await page.goto(companyUrl)
  }
}

/**
 * The Files section's own input. The section's head holds the "upload"
 * control and its body the hidden input (record-files.tsx), so the input is
 * found through the section, not as the button's sibling.
 */
async function upload(page: Page, file: string) {
  await page
    .getByRole('button', { name: 'upload', exact: true })
    .locator('xpath=ancestor::section[1]//input[@type="file"]')
    .setInputFiles(fixture(file))
  await expect(
    page.getByRole('button', { name: `Preview ${file}` }),
  ).toBeVisible()
}

test('a DOCX previews the text the worker extracted from it', async ({
  adminPage: page,
  imageUrl,
}) => {
  const external = offOrigin(page, imageUrl)
  await openCompany(page, imageUrl)
  await upload(page, DOCX.file)
  // The row says "extracting text…" until the worker has written the text;
  // the section polls, and the row changes on its own.
  await expect(page.getByText('extracting text…')).toHaveCount(0, {
    timeout: 60_000,
  })
  await page.getByRole('button', { name: `Preview ${DOCX.file}` }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(DOCX.marker)).toBeVisible()
  expect(external).toEqual([])
})

test('a PDF previews on a canvas, never as a navigation, and downloads as an opaque attachment', async ({
  adminPage: page,
  imageUrl,
}) => {
  const external = offOrigin(page, imageUrl)
  await openCompany(page, imageUrl)
  const here = page.url()

  // Every request that touches a blob, and whether the browser treated it
  // as a navigation — the preview must only ever fetch() the bytes.
  const blobRequests: Request[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/blob/')) blobRequests.push(r)
  })

  await upload(page, PDF.file)
  await page.getByRole('button', { name: `Preview ${PDF.file}` }).click()
  const dialog = page.getByRole('dialog')
  const canvas = dialog.locator('canvas')
  await expect(canvas).toBeVisible()
  // Drawn, not just mounted: pdf.js sizes the backing store when it renders.
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(0)
  expect(page.url()).toBe(here)
  expect(blobRequests.length).toBeGreaterThan(0)
  expect(blobRequests.filter((r) => r.isNavigationRequest())).toEqual([])
  await page.keyboard.press('Escape')

  // The row's Download control goes through the signed blob route. The
  // browser gets a download, not a page, and the headers are the rule.
  const response = page.waitForResponse(
    (r) => r.url().includes('/api/blob/') && r.request().method() === 'GET',
  )
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: `Download ${PDF.file}` }).click()
  const res = await response
  expect(res.headers()['content-type']).toBe('application/octet-stream')
  expect(res.headers()['content-disposition']).toMatch(/^attachment;/)
  expect((await download).suggestedFilename()).toBe(PDF.file)
  expect(page.url()).toBe(here)
  expect(external).toEqual([])
})
