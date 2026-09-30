import { defineConfig } from 'astro/config'
import { syncAssets } from './src/integrations/sync-assets'

// Static output to dist/, which Vercel serves as-is (vercel.json). No adapter:
// nothing here renders on request.
export default defineConfig({
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [syncAssets()],
  markdown: {
    // Code blocks are plain mono on bone, like the product's own. Shiki's
    // theme colours would be the only chroma on the page.
    syntaxHighlight: false,
  },
})
