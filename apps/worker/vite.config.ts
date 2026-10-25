import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The worker's two runtime entries, bundled for the image with `vite build
 * --ssr` (no second bundler): `index.mjs` (the pg-boss host) and `health.mjs`
 * (the ROLE=worker HEALTHCHECK), run with plain `node`. Dev runs tsx.
 * - npm packages stay runtime imports, so native and optional deps (pg-native,
 *   pdf.js's worker lookup) resolve as they do under tsx.
 * - Workspace packages and the `#web/*` modules are bundled in.
 * - Vitest has its own config, so the aliases repeat tsconfig's here.
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
      // Every bare import stays a runtime import except the workspace's own
      // packages. Vite's SSR default externalizes only what resolves from this
      // package's root, which under pnpm would inline core's deps (pdf.js and all).
      //
      // @spaces/sdk must stay external (the Dockerfile puts it in
      // /app/node_modules): the loader's hook hands plugin bundles the copy
      // this process loaded, and an inlined sdk is a second set of port tags —
      // every plugin job would fail "service not found".
      external: (id) =>
        /^(node:|[a-z@])/.test(id) &&
        (!id.startsWith('@spaces/') || /^@spaces\/sdk(\/|$)/.test(id)),
      input: {
        index: 'src/index.ts',
        health: 'src/health.ts',
      },
      output: { format: 'esm', entryFileNames: '[name].mjs' },
    },
  },
})
