import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin as VitePlugin, UserConfig } from 'vite'
import { toManifestJson } from '../manifest.ts'
import type { Plugin } from '../plugin.ts'

/**
 * The plugin build (sdk-3's call, recorded in the README): one `vite build
 * --ssr` config that every plugin package reuses — D26 made vite the one
 * bundler — with a plugin package's `vite.config.ts` being
 *
 *   export default pluginBuildConfig()
 *
 * It writes two files into `dist/`:
 *
 * - `bundle.mjs` — the plugin's code in one ESM file, every third-party
 *   dependency it has inlined, and exactly three bare imports left for the
 *   host to resolve: `effect`, `zod` and `@spaces/sdk` (plus `node:*`). A
 *   plugin never ships its own Effect or its own copy of the SDK — two copies
 *   of the SDK's service tags in one process is "service not found" at best
 *   — so those three are the host's, resolved to its copies by the loader
 *   (sdk-11).
 * - `manifest.json` — the bundle's `default.manifest` through
 *   `toManifestJson`: settings as JSON Schema, validated by `manifestSchema`,
 *   so a build that would write a manifest the loader refuses fails here.
 *   The manifest is read from the bundle it describes, not from a second
 *   entry, so the two cannot disagree.
 */

/** The bare specifiers a plugin bundle leaves to the host. */
export const HOST_PACKAGES = ['effect', 'zod', '@spaces/sdk'] as const

const isHostImport = (id: string): boolean =>
  id.startsWith('node:') ||
  HOST_PACKAGES.some((pkg) => id === pkg || id.startsWith(`${pkg}/`))

export type PluginBuildOptions = {
  /** The module whose default export is `definePlugin(…)`. */
  readonly entry?: string
  /** Where bundle.mjs and manifest.json land. */
  readonly outDir?: string
}

const isPlugin = (value: unknown): value is Plugin =>
  typeof value === 'object' &&
  value !== null &&
  'manifest' in value &&
  'jobs' in value

/** Writes manifest.json beside bundle.mjs once the bundle is on disk. */
const emitManifest = (): VitePlugin => {
  let outDir = 'dist'
  return {
    name: 'spaces-plugin-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    async writeBundle() {
      const bundle = path.join(outDir, 'bundle.mjs')
      // A cache-busting query: a second build in one process (a test, a
      // watch) must read the bundle it just wrote, not the module node
      // cached the first time.
      const mod: unknown = await import(
        `${pathToFileURL(bundle).href}?t=${Date.now()}`
      )
      const plugin =
        typeof mod === 'object' && mod !== null && 'default' in mod
          ? mod.default
          : undefined
      if (!isPlugin(plugin)) {
        throw new Error(
          `${bundle} has no definePlugin(…) default export — the entry must \`export default definePlugin({ manifest, jobs })\``,
        )
      }
      const json = toManifestJson(plugin.manifest)
      await writeFile(
        path.join(outDir, 'manifest.json'),
        `${JSON.stringify(json, null, 2)}\n`,
      )
    },
  }
}

export const pluginBuildConfig = (
  options: PluginBuildOptions = {},
): UserConfig => ({
  // Everything a plugin imports is bundled except the host's three.
  ssr: { noExternal: true },
  build: {
    ssr: options.entry ?? 'src/index.ts',
    outDir: options.outDir ?? 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: isHostImport,
      output: { format: 'esm', entryFileNames: 'bundle.mjs' },
    },
  },
  plugins: [emitManifest()],
})
