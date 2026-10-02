import { defineConfig } from 'vite'
import { pluginBuildConfig } from '@spaces/sdk/build'

// Version 0.2.0, the upgrade that replaces vite.config.ts's 0.1.0.
export default defineConfig(
  pluginBuildConfig({ entry: 'src/v2.ts', outDir: 'dist/0.2.0' }),
)
