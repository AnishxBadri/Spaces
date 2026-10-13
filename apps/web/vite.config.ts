import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  // Vite's env dir defaults to the project root, which is now apps/web, but
  // `.env.local` stays at the workspace root where the operator (and CI, and
  // the compose files) put it. Anchored to this file rather than to cwd.
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: { tsconfigPaths: true },
  // The email sanitizer runs DOMPurify over jsdom on the server. jsdom is
  // CommonJS; vite's dev SSR rewrite hoists a read of its `window` constant
  // above its declaration, so Node loads it untouched instead. Production
  // does the same through `traceDeps` below.
  ssr: { external: ['jsdom', 'dompurify'] },
  plugins: [
    devtools(),
    // jsdom reads its stylesheet beside its own files at runtime, so it is
    // traced into `.output/server/node_modules` rather than bundled.
    nitro({ traceDeps: ['jsdom'] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
