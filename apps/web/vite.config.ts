import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

/**
 * Dev only: nitro's dev middleware treats any request whose `Sec-Fetch-Dest`
 * is not a document as a static asset and hands it to vite, which answers
 * "Cannot GET" for a server route, so an `<img src="/api/…">` (the workspace
 * logo, blob pictures) would never load under `pnpm dev`. Dropping the header
 * on `/api/` requests sends them to the app. Must run before nitro's.
 */
const apiImagesInDev = (): Plugin => ({
  name: 'spaces:api-images-in-dev',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/api/')) delete req.headers['sec-fetch-dest']
      next()
    })
  },
})

const config = defineConfig({
  // `.env.local` lives at the workspace root, not the vite root; anchored to
  // this file rather than to cwd.
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    apiImagesInDev(),
    // jsdom reads its stylesheet beside its own files at runtime, so it is
    // traced into `.output/server/node_modules` rather than bundled.
    nitro({ traceDeps: ['jsdom'] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
