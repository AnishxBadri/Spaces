import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The boot entry (`src/db/boot.ts`: migrate → seeds → value-index
 * reconcile), bundled for the image by the second half of `pnpm build`
 * (SPA-185, mono-13b; D26: `vite build --ssr`). Its own config and none of
 * vite.config.ts's plugins: this is a node program, not the app, and nitro
 * or the router codegen have nothing to do with it.
 *
 * npm packages stay runtime imports from node_modules (Vite's SSR default);
 * the workspace packages and `#/` are bundled in, so the `--tsconfig`
 * workaround tsx needed (SPA-181) goes with tsx. The migration journal is
 * NOT bundled and cannot be found from here: `@spaces/db` resolves it from
 * its own `import.meta.url`, which inside this bundle is dist/, so the
 * entrypoint passes the folder as argv[2] — the argument boot.ts already
 * takes — pointing at /app/packages/db/drizzle, the directory CI mounts an
 * older journal over.
 *
 * `build.ssr` rather than `rollupOptions.input`, so `vite build --config
 * vite.boot.config.ts --ssr <file>` can bundle another node script the same
 * way — CI's roundtrip fixture does.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^#\//,
        replacement: fileURLToPath(new URL('./src/', import.meta.url)),
      },
    ],
  },
  build: {
    ssr: 'src/db/boot.ts',
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
      output: { format: 'esm', entryFileNames: '[name].mjs' },
    },
  },
})
