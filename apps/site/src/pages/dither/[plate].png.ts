import type { APIRoute, GetStaticPaths } from 'astro'
import { printPlate } from '../../dither/plate'
import { PLATES } from '../../dither/stages'

/**
 * /dither/<name>.png — every dither plate on the page, printed at build time
 * into dist/dither/ (and on request under `astro dev`). Nothing draws dither
 * in the browser.
 */
export const getStaticPaths = (() =>
  [...PLATES.keys()].map((plate) => ({
    params: { plate },
  }))) satisfies GetStaticPaths

export const GET: APIRoute = async ({ params }) => {
  const entry = PLATES.get(params.plate ?? '')
  if (entry === undefined) return new Response(null, { status: 404 })
  const png = await printPlate(entry.plate, entry.lift)
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png' },
  })
}
