import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'
import sharp from 'sharp'
import { FRAGMENT_NAMES } from '../content/landing'

/**
 * The site keeps no copy of the product's pictures. docs/assets is the one
 * place the logos and the screenshots live; this integration copies what the
 * site shows into public/ at the start of every `astro dev` and `astro build`,
 * and public/'s copies are gitignored.
 *
 * What the site shows of the product is fragments — tight crops of one piece
 * of it, docs/assets/screenshots/fragments/*.png, taken by `pnpm screenshots`.
 * Each is re-encoded as lossless WebP on the way (the same pixels at about a
 * third of the bytes, since the capture has no optimiser on most machines),
 * and its size is handed to the page as `__FRAGMENTS__`, in CSS pixels (the
 * captures are 2x). A fragment that has not been taken yet is not an error:
 * the page draws a labelled placeholder where it would sit.
 *
 * The third-party marks the orbit and the architecture stack show (Claude,
 * Gmail, Apollo…) live in docs/assets/logos/, full colour, and are copied
 * as they are into public/logos/, cleared first like the fragments.
 *
 * Paths are anchored to Astro's `config.root` (apps/site), never to the cwd,
 * so `pnpm --filter`, turbo and a Vercel build with root directory apps/site
 * all read the same docs/assets.
 */

export type FragmentSize = { readonly width: number; readonly height: number }

const LOGOS = ['logo.svg', 'logo-dark.svg', 'mark.svg'] as const

/** The captures' device scale factor (apps/e2e/playwright.screenshots.config.ts). */
const SCALE = 2

export function syncAssets(): AstroIntegration {
  return {
    name: 'spaces:sync-assets',
    hooks: {
      'astro:config:setup': async ({ config, updateConfig, logger }) => {
        const assets = new URL('../../docs/assets/', config.root)
        const publicDir = config.publicDir
        // Everything the site keeps in public/ is synced and gitignored, so a
        // clean clone has no public/ at all; the first copy would ENOENT.
        mkdirSync(publicDir, { recursive: true })

        const logos = LOGOS.filter((name) => {
          const from = new URL(name, assets)
          if (!existsSync(from)) return false
          copyFileSync(from, new URL(name, publicDir))
          return true
        })

        // Cleared first, like the fragments below, so a file deleted from
        // docs/assets does not live on in public/ from an earlier run.
        const marksFrom = new URL('logos/', assets)
        const marksDir = new URL('logos/', publicDir)
        rmSync(marksDir, { recursive: true, force: true })
        mkdirSync(marksDir, { recursive: true })
        const marks = existsSync(marksFrom)
          ? readdirSync(marksFrom).filter((name) => /\.(svg|png)$/.test(name))
          : []
        for (const name of marks) {
          copyFileSync(new URL(name, marksFrom), new URL(name, marksDir))
        }

        // Cleared first so a capture deleted from docs/assets does not live
        // on in public/ from an earlier run.
        const shotsDir = new URL('screenshots/', publicDir)
        rmSync(shotsDir, { recursive: true, force: true })
        const fragDir = new URL('fragments/', shotsDir)
        mkdirSync(fragDir, { recursive: true })

        const sizes: Record<string, FragmentSize> = {}
        let bytes = 0
        for (const name of FRAGMENT_NAMES) {
          const from = new URL(`screenshots/fragments/${name}.png`, assets)
          if (!existsSync(from)) continue
          const image = sharp(fileURLToPath(from))
          const { width, height } = await image.metadata()
          const out = await image
            .webp({ lossless: true, effort: 6 })
            .toFile(fileURLToPath(new URL(`${name}.webp`, fragDir)))
          bytes += out.size
          sizes[name] = {
            width: Math.round(width / SCALE),
            height: Math.round(height / SCALE),
          }
        }

        const missingLogos = LOGOS.filter((name) => !logos.includes(name))
        if (missingLogos.length > 0) {
          logger.warn(
            `missing from ${fileURLToPath(assets)}: ${missingLogos.join(', ')}`,
          )
        }
        const synced = Object.keys(sizes).length
        logger.info(
          `synced ${logos.length}/${LOGOS.length} logos, ${marks.length} integration marks and ${synced}/${FRAGMENT_NAMES.length} fragments (${Math.round(bytes / 1000)} KB webp) from docs/assets`,
        )

        updateConfig({
          vite: { define: { __FRAGMENTS__: JSON.stringify(sizes) } },
        })
      },
    },
  }
}
