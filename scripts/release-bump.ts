/**
 * Bumps one version line: core, the sdk or a plugin.
 *
 *   pnpm release:bump <core|sdk|plugin id|package name> <patch|minor|major|X.Y.Z>
 *
 * Writes the package.json version and the line that repeats it (a plugin's
 * `manifest.ts` `version`, the sdk's `SDK_VERSION`). Commit the result with
 * the change that earned it; the push tags it.
 */
import {
  ROOT,
  bumpPackage,
  packageToBump,
  workspacePackages,
} from './release/versioning.ts'

const args = process.argv.slice(2)
const named = args.at(0)
const to = args.at(1)
if (named === undefined || to === undefined) {
  console.error(
    'usage: pnpm release:bump <core|sdk|plugin id|package name> <patch|minor|major|X.Y.Z>',
  )
  process.exit(1)
}

const pkg = packageToBump(await workspacePackages(ROOT), named)
const bumped = bumpPackage(pkg.dir, to)
console.info(`${bumped.name}: ${bumped.from} → ${bumped.to}`)
