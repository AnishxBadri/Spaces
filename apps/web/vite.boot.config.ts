import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The boot entry (migrate → seeds → value-index reconcile), bundled for the
 * image with `vite build --ssr`. None of the app's plugins: this is a node
 * program, not the app.
 * - The migration journal is NOT bundled: `@spaces/db` resolves it from its
 *   own `import.meta.url`, so the entrypoint passes the folder as argv[2].
 * - `build.ssr`, not `rollupOptions.input`, so `--ssr <file>` bundles any
 *   other node script the same way (CI's roundtrip fixture).
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
      // Every bare import stays a runtime import except the workspace's own
      // packages. Vite's SSR default externalizes only what resolves from
      // this package's root, which under pnpm would inline core's
      // dependencies (pdf.js and all).
      external: (id) =>
        /^(node:|[a-z@])/.test(id) && !id.startsWith('@spaces/'),
      output: { format: 'esm', entryFileNames: '[name].mjs' },
    },
  },
})
