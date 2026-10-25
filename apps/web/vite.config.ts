import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  // `.env.local` lives at the workspace root, not the vite root; anchored to
  // this file rather than to cwd.
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: { tsconfigPaths: true },
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
