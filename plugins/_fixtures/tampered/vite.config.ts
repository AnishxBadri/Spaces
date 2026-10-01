import { defineConfig } from 'vite'
import { pluginBuildConfig } from '@spaces/sdk/build'

// The whole of a plugin's build config: dist/bundle.mjs + dist/manifest.json.
export default defineConfig(pluginBuildConfig())
