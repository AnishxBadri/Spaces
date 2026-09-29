import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The worker's two runtime entries, bundled for the image (SPA-185, mono-13b;
 * D26: `vite build --ssr`, no second bundler). `pnpm build` here writes
 * `dist/index.mjs` (the pg-boss host) and `dist/health.mjs` (the ROLE=worker
 * HEALTHCHECK), which the container runs with plain `node` — no tsx and no
 * `src/` in the image. Dev is unchanged: `pnpm worker` still runs tsx.
 *
 * What is inside a bundle and what stays outside is Vite's SSR default, and
 * it is the right split: every npm package resolves into node_modules and is
 * left as a runtime import — pg, pg-boss, drizzle-orm, effect, unpdf,
 * mammoth, fflate, tldts, the AI providers — so native and optional
 * dependencies (pg-native, pdf.js's worker lookup) resolve exactly as they
 * do under tsx, from the image's pruned node_modules. The workspace
 * packages (@spaces/core, @spaces/db) are links, not node_modules content,
 * so they are bundled in; so are the apps/web server modules the jobs reach
 * through `#web/*`. This file is not vitest's (vitest.config.ts wins for
 * `vitest run`), so the aliases are declared again here, exactly as
 * tsconfig.json declares them.
 */
const webSrc = fileURLToPath(new URL('../web/src/', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^#web\//, replacement: webSrc },
      { find: /^#\//, replacement: webSrc },
    ],
  },
  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // Every bare import stays a runtime import, except the workspace's own
      // packages, which are bundled. Vite's SSR default externalizes only what
      // resolves from this package's root, and under pnpm @spaces/core's
      // dependencies (unpdf, mammoth, @aws-sdk, fflate, tldts) resolve from
      // packages/core — so they were inlined, pdf.js and all. One rule here
      // rather than a package list to keep current.
      external: (id) =>
        /^(node:|[a-z@])/.test(id) && !id.startsWith('@spaces/'),
      input: {
        index: 'src/index.ts',
        health: 'src/health.ts',
      },
      output: { format: 'esm', entryFileNames: '[name].mjs' },
    },
  },
})
