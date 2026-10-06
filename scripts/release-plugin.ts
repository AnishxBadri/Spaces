/**
 * Release one plugin: pack it with its own `pack:plugin`, sign it, check the
 * registry entry against the artifacts, and — unless `--no-push` — publish
 * the GitHub release and commit registry.json on main.
 *
 *   pnpm exec turbo run build --filter=@spaces/plugin-<id>
 *   pnpm exec tsx scripts/release-plugin.ts --no-push <id>
 *
 * Flags: `--tag plugin-<id>@X.Y.Z` (default: the package's version),
 * `--dir <pluginDir>` (default plugins/<id>), `--out <dir>` (default
 * <pluginDir>/dist/release), `--registry <registry.json>` (default the
 * root's; only read on a dry run), `--repo owner/name`.
 *
 * Push mode is the plugin release workflow's: it needs
 * SPACES_PLUGIN_SIGNING_KEY, `gh` signed in, and a registry.json inside a
 * checkout of main the workflow owns.
 */
import path from 'node:path'
import { parseArgs } from 'node:util'
import { releasePlugin } from './release/plugin.ts'
import { DEFAULT_REPO, pluginTag } from './release/registry.ts'
import { ROOT, readPackageJson } from './release/versioning.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'no-push': { type: 'boolean', default: false },
    tag: { type: 'string' },
    dir: { type: 'string' },
    out: { type: 'string' },
    registry: { type: 'string' },
    repo: { type: 'string' },
  },
})

const id = positionals.at(0)
if (id === undefined) {
  console.error('usage: release-plugin.ts [--no-push] [--tag …] <id>')
  process.exit(2)
}
const pluginDir = path.resolve(values.dir ?? path.join(ROOT, 'plugins', id))
const push = !values['no-push']
const signingKey = process.env.SPACES_PLUGIN_SIGNING_KEY

try {
  await releasePlugin({
    id,
    pluginDir,
    tag: values.tag ?? pluginTag(id, readPackageJson(pluginDir).version),
    outDir: path.resolve(values.out ?? path.join(pluginDir, 'dist', 'release')),
    registryFile: path.resolve(
      values.registry ?? path.join(ROOT, 'registry.json'),
    ),
    keysDir: path.join(ROOT, 'plugin-keys'),
    repo: values.repo ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO,
    push,
    ...(signingKey ? { signingKey } : {}),
  })
} catch (cause) {
  console.error(
    `release-plugin: ${cause instanceof Error ? cause.message : String(cause)}`,
  )
  process.exit(1)
}
