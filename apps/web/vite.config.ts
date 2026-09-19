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
  plugins: [devtools(), nitro(), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
