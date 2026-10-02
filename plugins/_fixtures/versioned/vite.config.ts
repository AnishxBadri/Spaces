import { defineConfig } from 'vite'
import { pluginBuildConfig } from '@spaces/sdk/build'

// Version 0.1.0; vite.v2.config.ts builds 0.2.0 beside it.
export default defineConfig(
  pluginBuildConfig({ entry: 'src/v1.ts', outDir: 'dist/0.1.0' }),
)
