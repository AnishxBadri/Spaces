import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'

/**
 * The site keeps no copy of the product's pictures. docs/assets is the one
 * place the logos and the screenshots live; this integration copies them into
 * public/ at the start of every `astro dev` and `astro build`, and public/'s
 * copies are gitignored. A screenshot that has not been taken yet is not an
 * error: the page draws a labelled placeholder in its place (Shot.astro),
 * reading the list of what arrived from `__SCREENSHOTS__`.
 *
 * Paths are anchored to Astro's `config.root` (apps/site), never to the cwd,
 * so `pnpm --filter`, turbo and a Vercel build with root directory apps/site
 * all read the same docs/assets.
 */

export const SCREENSHOTS = [
  'hero',
  'today',
  'deals',
  'deal',
  'companies',
  'company',
  'portfolio',
  'holding',
  'notes',
  'note',
  'documents',
  'spaces',
  'settings-ai',
  'settings-objects',
  'import',
  'inbox',
] as const

export type Screenshot = (typeof SCREENSHOTS)[number]

const LOGOS = ['logo.svg', 'logo-dark.svg', 'mark.svg'] as const

export function syncAssets(): AstroIntegration {
  return {
    name: 'spaces:sync-assets',
    hooks: {
      'astro:config:setup': ({ config, updateConfig, logger }) => {
        const assets = new URL('../../docs/assets/', config.root)
        const publicDir = config.publicDir

        const logos = LOGOS.filter((name) => {
          const from = new URL(name, assets)
          if (!existsSync(from)) return false
          copyFileSync(from, new URL(name, publicDir))
          return true
        })

        // Cleared first so a screenshot deleted from docs/assets does not
        // live on in public/ from an earlier run.
        const shotsDir = new URL('screenshots/', publicDir)
        rmSync(shotsDir, { recursive: true, force: true })
        mkdirSync(shotsDir, { recursive: true })
        const shots = SCREENSHOTS.filter((name) => {
          const from = new URL(`screenshots/${name}.png`, assets)
          if (!existsSync(from)) return false
          copyFileSync(from, new URL(`${name}.png`, shotsDir))
          return true
        })

        const missingLogos = LOGOS.filter((name) => !logos.includes(name))
        if (missingLogos.length > 0) {
          logger.warn(
            `missing from ${fileURLToPath(assets)}: ${missingLogos.join(', ')}`,
          )
        }
        logger.info(
          `synced ${logos.length}/${LOGOS.length} logos and ${shots.length}/${SCREENSHOTS.length} screenshots from docs/assets`,
        )

        updateConfig({
          vite: { define: { __SCREENSHOTS__: JSON.stringify(shots) } },
        })
      },
    },
  }
}
